import json
import math
import os
import re
import time
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime

import requests
from fastapi import Body, FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from google import genai
from google.genai import types
from groq import Groq

app = FastAPI(title="BTC AI Signal Dashboard")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

BINANCE_BASE_URL = "https://data-api.binance.vision"
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")
GROQ_MODEL = os.getenv("GROQ_MODEL", "llama-3.3-70b-versatile")
AI_NEWS_LIMIT = 10
RSS_NEWS_TIMEOUT_SECONDS = 10
TECHNICAL_CACHE_SECONDS = 30
TECHNICAL_DELAYED_SECONDS = 90
GROQ_LIVE_COOLDOWN_SECONDS = 10
GROQ_NEWS_COOLDOWN_SECONDS = 30

RSS_NEWS_SOURCES = [
    {"name": "CoinDesk", "url": "https://www.coindesk.com/arc/outboundfeeds/rss/"},
    {"name": "Cointelegraph", "url": "https://cointelegraph.com/rss"},
    {"name": "Decrypt", "url": "https://decrypt.co/feed"},
    {"name": "Bitcoin Magazine", "url": "https://bitcoinmagazine.com/.rss/full/"},
]

price_cache = {"data": None, "updated_at": 0}
chart_cache = {"data": {}, "updated_at": 0}
ai_signal_cache = {"data": None, "updated_at": 0}
technical_cache = {"data": None, "updated_at": 0}
rrg_cache = {"data": {}, "updated_at": 0}
groq_live_cache = {"data": None, "updated_at": 0}
groq_news_cache = {"data": None, "updated_at": 0}


def round_value(value, digits=2):
    return round(float(value), digits) if value is not None else 0.0


def average(values):
    return sum(values) / len(values) if values else 0.0


def normalize_signal(raw_signal: str) -> str:
    s = str(raw_signal or "").strip().upper()
    if "BUY" in s and "WATCH" not in s and "NO" not in s and "HOLD" not in s:
        return "BUY"
    elif "SELL" in s and "WATCH" not in s and "NO" not in s and "HOLD" not in s:
        return "SELL"
    return "HOLD"


def get_ticker(symbol="BTCUSDT"):
    response = requests.get(
        f"{BINANCE_BASE_URL}/api/v3/ticker/24hr",
        params={"symbol": symbol},
        timeout=15,
    )
    response.raise_for_status()
    return response.json()


def get_btc_ticker():
    return get_ticker("BTCUSDT")


def get_klines(symbol="BTCUSDT", interval="1h", limit=250):
    response = requests.get(
        f"{BINANCE_BASE_URL}/api/v3/klines",
        params={"symbol": symbol, "interval": interval, "limit": limit},
        timeout=15,
    )
    response.raise_for_status()
    return response.json()


def get_btc_klines(interval="1h", limit=250):
    return get_klines("BTCUSDT", interval, limit)


def get_btc_daily_change(current_price):
    daily_candles = get_btc_klines(interval="1d", limit=2)
    if len(daily_candles) < 2:
        raise ValueError("Not enough daily candle data to calculate daily change.")
    previous_daily_close = float(daily_candles[-2][4])
    if previous_daily_close == 0:
        raise ValueError("Previous daily close is zero.")
    return previous_daily_close, ((current_price - previous_daily_close) / previous_daily_close) * 100


def sma(values, period):
    if len(values) < period:
        raise ValueError(f"Need {period} values for SMA.")
    return average(values[-period:])


def ema_series(values, period):
    if len(values) < period:
        raise ValueError(f"Need {period} values for EMA.")
    multiplier = 2 / (period + 1)
    current = average(values[:period])
    series = [None] * (period - 1) + [current]
    for value in values[period:]:
        current = (value - current) * multiplier + current
        series.append(current)
    return series


def ema(values, period):
    return ema_series(values, period)[-1]


def rsi(values, period=14):
    if len(values) < period + 1:
        raise ValueError(f"Need {period + 1} values for RSI.")
    changes = [values[i] - values[i - 1] for i in range(1, len(values))]
    recent = changes[-period:]
    avg_gain = average([max(c, 0) for c in recent])
    avg_loss = average([max(-c, 0) for c in recent])
    if avg_loss == 0:
        return 100.0
    rs = avg_gain / avg_loss
    return 100 - (100 / (1 + rs))


def standard_deviation(values):
    if not values:
        return 0.0
    mean = average(values)
    return math.sqrt(average([(v - mean) ** 2 for v in values]))


def percentage_change(start_val, end_val):
    if start_val == 0:
        return 0.0
    return ((end_val - start_val) / start_val) * 100


def macd(values, fast=12, slow=26, signal=9):
    if len(values) < slow + signal:
        raise ValueError("Not enough candle data for MACD.")
    fast_s = ema_series(values, fast)
    slow_s = ema_series(values, slow)
    macd_s = [
        f - s for f, s in zip(fast_s, slow_s) if f is not None and s is not None
    ]
    sig_s = ema_series(macd_s, signal)
    macd_l = macd_s[-1]
    sig_l = sig_s[-1]
    hist = macd_l - sig_l
    prev_hist = macd_s[-2] - sig_s[-2] if len(macd_s) > 1 else hist
    direction = "Bullish" if macd_l > sig_l else "Bearish"
    strength = "Strengthening" if hist > prev_hist else "Weakening"
    return {
        "macd_line": round_value(macd_l, 4),
        "signal_line": round_value(sig_l, 4),
        "histogram": round_value(hist, 4),
        "state": f"{direction}, {strength}",
    }


def atr(highs, lows, closes, period=14):
    if len(closes) < period + 1:
        raise ValueError("Not enough candle data for ATR.")
    trs = [
        max(
            highs[i] - lows[i],
            abs(highs[i] - closes[i - 1]),
            abs(lows[i] - closes[i - 1]),
        )
        for i in range(1, len(closes))
    ]
    return average(trs[-period:])


def adx(highs, lows, closes, period=14):
    if len(closes) < (period * 2) + 1:
        raise ValueError("Not enough candle data for ADX.")
    plus_dm, minus_dm, trs = [], [], []
    for i in range(1, len(closes)):
        up = highs[i] - highs[i - 1]
        down = lows[i - 1] - lows[i]
        plus_dm.append(up if up > down and up > 0 else 0)
        minus_dm.append(down if down > up and down > 0 else 0)
        trs.append(
            max(
                highs[i] - lows[i],
                abs(highs[i] - closes[i - 1]),
                abs(lows[i] - closes[i - 1]),
            )
        )
    dx_vals, plus_dis, minus_dis = [], [], []
    for i in range(period - 1, len(trs)):
        tr_avg = average(trs[i - period + 1 : i + 1])
        p_avg = average(plus_dm[i - period + 1 : i + 1])
        m_avg = average(minus_dm[i - period + 1 : i + 1])
        p_di = 100 * p_avg / tr_avg if tr_avg else 0
        m_di = 100 * m_avg / tr_avg if tr_avg else 0
        tot = p_di + m_di
        dx = 100 * abs(p_di - m_di) / tot if tot else 0
        plus_dis.append(p_di)
        minus_dis.append(m_di)
        dx_vals.append(dx)
    adx_v = average(dx_vals[-period:])
    return {
        "adx_14": round_value(adx_v),
        "plus_di_14": round_value(plus_dis[-1]),
        "minus_di_14": round_value(minus_dis[-1]),
        "trend_strength": (
            "Strong"
            if adx_v >= 25
            else "Moderate" if adx_v >= 20 else "Weak / ranging"
        ),
    }


def bollinger_bands(values, period=20, multiplier=2):
    if len(values) < period:
        raise ValueError("Not enough candle data for Bollinger Bands.")
    w = values[-period:]
    mid = average(w)
    dev = standard_deviation(w)
    up = mid + multiplier * dev
    low = mid - multiplier * dev
    width = ((up - low) / mid) * 100 if mid else 0
    pos = ((values[-1] - low) / (up - low)) * 100 if up != low else 50
    return {
        "upper": round_value(up),
        "middle": round_value(mid),
        "lower": round_value(low),
        "width_percent": round_value(width),
        "price_position_percent": round_value(pos),
    }


def obv(closes, volumes):
    val = 0.0
    vals = [val]
    for i in range(1, len(closes)):
        if closes[i] > closes[i - 1]:
            val += volumes[i]
        elif closes[i] < closes[i - 1]:
            val -= volumes[i]
        vals.append(val)
    direction = (
        "Rising"
        if vals[-1] > vals[-6]
        else "Falling" if vals[-1] < vals[-6] else "Flat"
    )
    return {"value": round_value(vals[-1], 2), "direction_5_candles": direction}


def mfi(highs, lows, closes, volumes, period=14):
    if len(closes) < period + 1:
        raise ValueError("Not enough candle data for MFI.")
    tps = [(h + l + c) / 3 for h, l, c in zip(highs, lows, closes)]
    pos, neg = [], []
    for i in range(1, len(tps)):
        raw = tps[i] * volumes[i]
        if tps[i] > tps[i - 1]:
            pos.append(raw)
            neg.append(0)
        elif tps[i] < tps[i - 1]:
            pos.append(0)
            neg.append(raw)
        else:
            pos.append(0)
            neg.append(0)
    p_sum = sum(pos[-period:])
    n_sum = sum(neg[-period:])
    if n_sum == 0:
        return 100.0
    return 100 - (100 / (1 + (p_sum / n_sum)))


def candle_pattern(candles):
    cur, prev = candles[-1], candles[-2]
    o, h, l, c = map(float, [cur[1], cur[2], cur[3], cur[4]])
    po, ph, pl, pc = map(float, [prev[1], prev[2], prev[3], prev[4]])
    body = abs(c - o)
    rng = max(h - l, 0.00000001)
    u_wick = h - max(o, c)
    l_wick = min(o, c) - l
    if h < ph and l > pl:
        return "Inside bar / consolidation"
    if c > o and pc < po and c >= po and o <= pc:
        return "Bullish engulfing"
    if c < o and pc > po and c <= po and o >= pc:
        return "Bearish engulfing"
    if body / rng < 0.12:
        return "Doji / indecision"
    if l_wick > body * 2 and u_wick < body:
        return "Hammer-like bullish rejection"
    if u_wick > body * 2 and l_wick < body:
        return "Shooting-star-like bearish rejection"
    return "Bullish candle" if c > o else "Bearish candle"


def market_structure(closes, highs, lows, e20, e50):
    rh, rl = max(highs[-20:]), min(lows[-20:])
    ph, pl = max(highs[-40:-20]), min(lows[-40:-20])
    lc = closes[-1]
    if rh > ph and rl > pl and lc > e20 > e50:
        return "Bullish: Higher highs and higher lows"
    if rh < ph and rl < pl and lc < e20 < e50:
        return "Bearish: Lower highs and lower lows"
    return "Range / mixed structure"


def pivot_levels(highs, lows, closes):
    ph, pl, pc = max(highs[-25:-1]), min(lows[-25:-1]), closes[-2]
    p = (ph + pl + pc) / 3
    return {
        "pivot": round_value(p),
        "support_1": round_value((2 * p) - ph),
        "support_2": round_value(p - (ph - pl)),
        "resistance_1": round_value((2 * p) - pl),
        "resistance_2": round_value(p + (ph - pl)),
    }


def fibonacci_levels(highs, lows):
    sh, sl = max(highs[-50:]), min(lows[-50:])
    rng = sh - sl
    return {
        "swing_high": round_value(sh),
        "swing_low": round_value(sl),
        "level_23_6": round_value(sh - rng * 0.236),
        "level_38_2": round_value(sh - rng * 0.382),
        "level_50_0": round_value(sh - rng * 0.5),
        "level_61_8": round_value(sh - rng * 0.618),
        "level_78_6": round_value(sh - rng * 0.786),
    }


def find_pivot_highs(highs, left_right=3):
    return [
        i
        for i in range(left_right, len(highs) - left_right)
        if highs[i] > max(highs[i - left_right : i])
        and highs[i] >= max(highs[i + 1 : i + left_right + 1])
    ]


def find_pivot_lows(lows, left_right=3):
    return [
        i
        for i in range(left_right, len(lows) - left_right)
        if lows[i] < min(lows[i - left_right : i])
        and lows[i] <= min(lows[i + 1 : i + left_right + 1])
    ]


def calculate_swing_failure_structure(
    candles,
    atr_value,
    swing_left_right=3,
    volume_ratio=0,
    rsi_value=50,
    macd_state="",
    trend_1h="",
    trend_4h="",
):
    if len(candles) < 60:
        raise ValueError("Need 60 candles for swing structure.")
    opens = [float(c[1]) for c in candles]
    highs = [float(c[2]) for c in candles]
    lows = [float(c[3]) for c in candles]
    closes = [float(c[4]) for c in candles]
    volumes = [float(c[5]) for c in candles]
    p_highs = find_pivot_highs(highs, swing_left_right)
    p_lows = find_pivot_lows(lows, swing_left_right)
    cur_p = closes[-1]
    atr_buf = max(float(atr_value) * 0.30, 0.01)
    retest_tol = max(float(atr_value) * 0.25, 0.01)

    norm_macd = str(macd_state or "").lower()
    norm_1h = str(trend_1h or "").lower()
    norm_4h = str(trend_4h or "").lower()
    bull_mom_ok = float(rsi_value) >= 50 and "bullish" in norm_macd
    bear_mom_ok = float(rsi_value) <= 50 and "bearish" in norm_macd
    bull_1h_ok = "bullish" in norm_1h
    bear_1h_ok = "bearish" in norm_1h
    bull_4h_blocked = "strong bearish" in norm_4h
    bear_4h_blocked = "strong bullish" in norm_4h

    avg_vol = average(volumes[-21:-1])
    calc_vol_r = volumes[-1] / avg_vol if avg_vol else 0
    eff_vol_r = max(float(volume_ratio or 0), calc_vol_r)
    vol_ok = eff_vol_r >= 1.20

    def build_res(
        direction,
        raw_sig,
        status,
        prior_h,
        prior_l,
        prot_lvl,
        brk_lvl,
        ret_lvl,
        inval_lvl,
        concl,
        reason,
        quality,
        p_filt,
        w_filt,
        f_filt,
        brk_event,
    ):
        sig = normalize_signal(raw_sig)
        return {
            "timeframe": "15m",
            "current_price": round_value(cur_p),
            "atr_14": round_value(atr_value),
            "atr_buffer": round_value(atr_buf),
            "prior_swing_high": round_value(prior_h),
            "prior_swing_low": round_value(prior_l),
            "failed_high": None,
            "failed_low": None,
            "break_event": brk_event,
            "protected_break_level": round_value(prot_lvl),
            "break_level": round_value(brk_lvl),
            "break_level_text": (
                f"Body close above ${brk_lvl:,.2f}"
                if direction == "BULLISH"
                else f"Body close below ${brk_lvl:,.2f}"
            ),
            "break_status": status,
            "retest_level": round_value(ret_lvl),
            "invalidation_level": round_value(inval_lvl),
            "signal": sig,
            "direction": direction,
            "quality": quality,
            "final_conclusion": concl,
            "reason": reason,
            "confirmation_rule": "Final signal requires: 0.30 ATR body-close break, volume >= 1.20x, second close, 1h alignment, no strong 4h conflict, retest, and confirmation candle.",
            "filter_checklist": {
                "passed": p_filt,
                "waiting": w_filt,
                "failed": f_filt,
                "volume_ratio": round_value(eff_vol_r),
                "volume_required": 1.20,
                "rsi_15m": round_value(rsi_value),
                "macd_15m": macd_state,
                "trend_1h": trend_1h,
                "trend_4h": trend_4h,
            },
        }

    if not p_highs or not p_lows:
        return build_res(
            "NEUTRAL",
            "HOLD",
            "STRUCTURE TRACKING",
            None,
            None,
            None,
            cur_p,
            None,
            None,
            "HOLD — waiting for confirmed 15m swing pivots.",
            "No confirmed local swing high and low are available yet.",
            "LOW",
            [],
            ["Confirmed local swing high/low"],
            [],
            "No confirmed swing structure yet",
        )

    act_h, act_l = highs[p_highs[-1]], lows[p_lows[-1]]
    b_brk_lvl, s_brk_lvl = act_h + atr_buf, act_l - atr_buf
    b_idx = next(
        (
            i
            for i in range(p_highs[-1] + 1, len(candles))
            if closes[i] > b_brk_lvl
        ),
        None,
    )
    s_idx = next(
        (
            i
            for i in range(p_lows[-1] + 1, len(candles))
            if closes[i] < s_brk_lvl
        ),
        None,
    )

    if b_idx is None and s_idx is None:
        mid = (act_h + act_l) / 2
        direction = "BULLISH" if cur_p >= mid else "BEARISH"
        return build_res(
            direction,
            "HOLD",
            "INSIDE STRUCTURE",
            act_h,
            act_l,
            act_h if direction == "BULLISH" else act_l,
            b_brk_lvl if direction == "BULLISH" else s_brk_lvl,
            act_h if direction == "BULLISH" else act_l,
            act_l if direction == "BULLISH" else act_h,
            "HOLD — price inside 15m swing range. Wait for confirmed break & retest.",
            "No body-close break beyond 0.30 ATR buffer.",
            "LOW",
            [],
            [
                "0.30 ATR body close",
                "Volume >= 1.20x",
                "Second 15m close",
                "Retest confirmation",
            ],
            [],
            "No confirmed break yet",
        )

    is_bull = b_idx is not None and (s_idx is None or b_idx > s_idx)
    if is_bull:
        brk_i = b_idx
        direction, final_sig = "BULLISH", "BUY"
        prot_lvl, brk_lvl, inval_lvl = act_h, b_brk_lvl, act_l
        second_close_ok = any(
            closes[i] > act_h for i in range(brk_i + 1, len(candles))
        )
        retest_seen = final_conf = failed_brk = False
        for i in range(brk_i + 1, len(candles)):
            if closes[i] < act_h - retest_tol:
                failed_brk = True
            if lows[i] <= act_h + retest_tol:
                retest_seen = True
            if (
                retest_seen
                and closes[i] > opens[i]
                and closes[i] > act_h
                and lows[i] <= act_h + retest_tol
            ):
                final_conf = True
        mom_ok, t_1h_ok, t_4h_ok = (
            bull_mom_ok,
            bull_1h_ok,
            not bull_4h_blocked,
        )
    else:
        brk_i = s_idx
        direction, final_sig = "BEARISH", "SELL"
        prot_lvl, brk_lvl, inval_lvl = act_l, s_brk_lvl, act_h
        second_close_ok = any(
            closes[i] < act_l for i in range(brk_i + 1, len(candles))
        )
        retest_seen = final_conf = failed_brk = False
        for i in range(brk_i + 1, len(candles)):
            if closes[i] > act_l + retest_tol:
                failed_brk = True
            if highs[i] >= act_l - retest_tol:
                retest_seen = True
            if (
                retest_seen
                and closes[i] < opens[i]
                and closes[i] < act_l
                and highs[i] >= act_l - retest_tol
            ):
                final_conf = True
        mom_ok, t_1h_ok, t_4h_ok = (
            bear_mom_ok,
            bear_1h_ok,
            not bear_4h_blocked,
        )

    passed, waiting, failed = ["0.30 ATR body-close break"], [], []
    if vol_ok:
        passed.append(f"Break volume x{eff_vol_r:.2f} >= 1.20x")
    else:
        failed.append(f"Break volume x{eff_vol_r:.2f} < 1.20x")
    if second_close_ok:
        passed.append("Second 15m candle close confirmed")
    else:
        waiting.append("Second 15m direction close")
    if t_1h_ok:
        passed.append("1h trend aligned")
    else:
        failed.append(f"1h trend conflict: {trend_1h or 'unknown'}")
    if t_4h_ok:
        passed.append("No strong opposite 4h trend")
    else:
        failed.append(f"Strong opposite 4h trend: {trend_4h}")
    if mom_ok:
        passed.append("15m RSI + MACD aligned")
    else:
        failed.append("15m RSI + MACD not aligned")
    if retest_seen:
        passed.append("Retest detected")
    else:
        waiting.append("Retest pending")
    if final_conf:
        passed.append("Retest confirmation candle")
    else:
        waiting.append("Retest confirmation candle")

    if failed_brk:
        return build_res(
            direction,
            "HOLD",
            "BREAK FAILED / BACK INSIDE",
            act_h,
            act_l,
            prot_lvl,
            brk_lvl,
            prot_lvl,
            inval_lvl,
            "HOLD — break failed; price returned inside swing range.",
            "Price accepted back inside previous range.",
            "LOW",
            passed,
            waiting,
            failed,
            "Break failed; returned inside",
        )

    if (
        vol_ok
        and second_close_ok
        and t_1h_ok
        and t_4h_ok
        and mom_ok
        and retest_seen
        and final_conf
    ):
        return build_res(
            direction,
            final_sig,
            f"{final_sig} CONFIRMED STRUCTURE",
            act_h,
            act_l,
            prot_lvl,
            brk_lvl,
            prot_lvl,
            inval_lvl,
            f"{final_sig} — 15m breakout, volume, alignment and retest passed.",
            "All mandatory structure filters passed.",
            "HIGH",
            passed,
            waiting,
            failed,
            (
                "Bullish break + support retest hold"
                if direction == "BULLISH"
                else "Bearish break + resistance retest hold"
            ),
        )

    return build_res(
        direction,
        "HOLD",
        f"{direction} BREAK / FILTERS PENDING",
        act_h,
        act_l,
        prot_lvl,
        brk_lvl,
        prot_lvl,
        inval_lvl,
        f"HOLD — {direction} break developing, filters pending.",
        "Breakout requires complete filter validation.",
        "MEDIUM" if len(failed) <= 1 else "LOW",
        passed,
        waiting,
        failed,
        f"{direction} break awaiting filters",
    )


def calculate_market_indicators(candles, interval):
    if len(candles) < 200:
        raise ValueError("Need 200 candles for full market analysis.")
    highs = [float(c[2]) for c in candles]
    lows = [float(c[3]) for c in candles]
    closes = [float(c[4]) for c in candles]
    volumes = [float(c[5]) for c in candles]
    q_volumes = [float(c[7]) for c in candles]
    t_counts = [int(c[8]) for c in candles]
    taker_buys = [float(c[9]) for c in candles]
    last_c = closes[-1]
    e20, e50, e200 = ema(closes, 20), ema(closes, 50), ema(closes, 200)
    atr_v = atr(highs, lows, closes)
    avg_v20 = average(volumes[-20:-1])
    cur_v = volumes[-1]
    vol_r = cur_v / avg_v20 if avg_v20 else 0
    tot_v20 = sum(volumes[-20:])
    tb_tot = sum(taker_buys[-20:])
    tb_r = (tb_tot / tot_v20) * 100 if tot_v20 else 50
    sup, res = min(lows[-20:]), max(highs[-20:])
    p_res, p_sup = max(highs[-21:-1]), min(lows[-21:-1])
    breakout = (
        "Bullish breakout"
        if last_c > p_res and vol_r >= 1.2
        else (
            "Bearish breakdown"
            if last_c < p_sup and vol_r >= 1.2
            else "No confirmed breakout"
        )
    )
    trend = (
        "Strong bullish"
        if last_c > e20 > e50 > e200
        else (
            "Bullish"
            if last_c > e20 > e50
            else (
                "Strong bearish"
                if last_c < e20 < e50 < e200
                else "Bearish" if last_c < e20 < e50 else "Mixed"
            )
        )
    )
    mom_p = percentage_change(closes[-13], last_c)
    return {
        "timeframe": interval,
        "price": round_value(last_c),
        "trend": trend,
        "ema": {
            "ema_20": round_value(e20),
            "ema_50": round_value(e50),
            "ema_200": round_value(e200),
        },
        "sma": {
            "sma_20": round_value(sma(closes, 20)),
            "sma_50": round_value(sma(closes, 50)),
        },
        "rsi_14": round_value(rsi(closes, 14)),
        "macd": macd(closes),
        "adx": adx(highs, lows, closes),
        "atr_14": round_value(atr_v),
        "atr_percent": round_value((atr_v / last_c) * 100),
        "bollinger_bands": bollinger_bands(closes),
        "volume": {
            "current": round_value(cur_v, 4),
            "average_20": round_value(avg_v20, 4),
            "volume_ratio": round_value(vol_r),
            "quote_volume_current": round_value(q_volumes[-1], 2),
            "trade_count_current": t_counts[-1],
            "taker_buy_ratio_20_percent": round_value(tb_r),
        },
        "obv": obv(closes, volumes),
        "mfi_14": round_value(mfi(highs, lows, closes, volumes)),
        "momentum_percent": round_value(mom_p),
        "support_resistance": {
            "support_20": round_value(sup),
            "resistance_20": round_value(res),
        },
        "pivots": pivot_levels(highs, lows, closes),
        "fibonacci": fibonacci_levels(highs, lows),
        "candle_pattern": candle_pattern(candles),
        "market_structure": market_structure(closes, highs, lows, e20, e50),
        "breakout_status": breakout,
        "swing_failure_structure": None,
    }


def timeframe_signal_from_indicators(indicators):
    trend = str(indicators.get("trend", "")).lower()
    m_state = str(indicators.get("macd", {}).get("state", "")).lower()
    r_val = float(indicators.get("rsi_14", 50))
    mom = float(indicators.get("momentum_percent", 0))
    b_score = (
        (2 if "bull" in trend else 0)
        + (1 if "bull" in m_state else 0)
        + (1 if r_val >= 52 else 0)
        + (1 if mom > 0 else 0)
    )
    s_score = (
        (2 if "bear" in trend else 0)
        + (1 if "bear" in m_state else 0)
        + (1 if r_val <= 48 else 0)
        + (1 if mom < 0 else 0)
    )
    return (
        "BUY"
        if b_score >= 3 and b_score > s_score
        else "SELL" if s_score >= 3 and s_score > b_score else "HOLD"
    )


def trend_score(ind):
    t = str(ind.get("trend", "")).lower()
    return (
        2
        if "strong bullish" in t
        else (
            1
            if t == "bullish"
            else -2 if "strong bearish" in t else -1 if t == "bearish" else 0
        )
    )


def macd_score(ind):
    s = str(ind.get("macd", {}).get("state", "")).lower()
    return (
        2
        if "bullish" in s and "strengthening" in s
        else (
            1
            if "bullish" in s
            else (
                -2
                if "bearish" in s and "strengthening" in s
                else -1 if "bearish" in s else 0
            )
        )
    )


def momentum_score(ind):
    r = float(ind.get("rsi_14", 50))
    m = float(ind.get("momentum_percent", 0))
    return (
        2
        if r >= 58 and m > 0
        else (
            1
            if r >= 50 and m >= 0
            else -2 if r <= 42 and m < 0 else -1 if r <= 50 and m <= 0 else 0
        )
    )


def breakout_score(ind):
    b = str(ind.get("breakout_status", "")).lower()
    return (
        2
        if "bullish breakout" in b
        else -2 if "bearish breakdown" in b else 0
    )


def volume_score(ind):
    vr = float(ind.get("volume", {}).get("volume_ratio", 0))
    tb = float(ind.get("volume", {}).get("taker_buy_ratio_20_percent", 50))
    return 1 if vr >= 1.2 and tb >= 52 else -1 if vr >= 1.2 and tb <= 48 else 0


def calculate_score_breakdown(market_data):
    tf = market_data["timeframes"]
    w = {"15m": 0.25, "1h": 0.35, "4h": 0.40}
    comps = {
        "trend": trend_score,
        "macd": macd_score,
        "momentum": momentum_score,
        "breakout": breakout_score,
        "volume": volume_score,
    }
    res, tot, max_p = {}, 0.0, 0.0
    for name, scorer in comps.items():
        w_score = sum(scorer(tf[t]) * weight for t, weight in w.items())
        c_max = 2 if name != "volume" else 1
        res[name] = {
            "score": round_value(w_score, 2),
            "minimum": -c_max,
            "maximum": c_max,
        }
        tot += w_score
        max_p += c_max
    align_p = ((tot + max_p) / (2 * max_p)) * 100
    bias = (
        "Bullish"
        if tot >= 2
        else "Bearish" if tot <= -2 else "Neutral / mixed"
    )
    return {
        **res,
        "total_score": round_value(tot, 2),
        "score_range": {"minimum": -9, "maximum": 9},
        "technical_alignment_percent": round_value(align_p),
        "bias": bias,
    }


def calculate_timeframe_agreement(market_data):
    tf_signals = {
        t: timeframe_signal_from_indicators(ind)
        for t, ind in market_data["timeframes"].items()
    }
    vals = list(tf_signals.values())
    bc, sc, hc = vals.count("BUY"), vals.count("SELL"), vals.count("HOLD")
    pct = round_value((max(bc, sc, hc) / len(vals)) * 100)
    d = (
        "Fully bullish"
        if bc == 3
        else (
            "Fully bearish"
            if sc == 3
            else (
                "Mostly bullish"
                if bc >= 2
                else "Mostly bearish" if sc >= 2 else "Mixed"
            )
        )
    )
    return {
        "percent": pct,
        "direction": d,
        "bullish_votes": bc,
        "bearish_votes": sc,
        "hold_votes": hc,
        "signals": tf_signals,
    }


def calculate_market_regime(market_data):
    analyses = list(market_data["timeframes"].values())
    avg_adx = average([float(i.get("adx", {}).get("adx_14", 0)) for i in analyses])
    avg_atr = average([float(i.get("atr_percent", 0)) for i in analyses])
    avg_bb = average(
        [
            float(i.get("bollinger_bands", {}).get("width_percent", 0))
            for i in analyses
        ]
    )
    trends = [str(i.get("trend", "")).lower() for i in analyses]
    bc = sum("bull" in t for t in trends)
    sc = sum("bear" in t for t in trends)
    if avg_atr >= 2.2 or avg_bb >= 8:
        label, detail = (
            "High Volatility",
            "Price swings elevated; reduce trade frequency.",
        )
    elif avg_adx >= 25 and (bc >= 2 or sc >= 2):
        label, detail = (
            "Trending",
            "Directional trend present across multiple timeframes.",
        )
    elif avg_adx < 18 and avg_atr < 0.8:
        label, detail = (
            "Low Volatility",
            "Compressed movement; wait for expansion.",
        )
    else:
        label, detail = "Ranging", "Mixed conditions; key levels matter most."
    return {
        "label": label,
        "detail": detail,
        "average_adx": round_value(avg_adx),
        "average_atr_percent": round_value(avg_atr),
        "average_bollinger_width_percent": round_value(avg_bb),
    }


def calculate_key_level_distance(market_data):
    res = {}
    for t, a in market_data["timeframes"].items():
        p = float(a.get("price", 0))
        s = float(a.get("support_resistance", {}).get("support_20", 0))
        r = float(a.get("support_resistance", {}).get("resistance_20", 0))
        res[t] = {
            "price": round_value(p),
            "support": round_value(s),
            "resistance": round_value(r),
            "support_distance_percent": (
                round_value(((p - s) / p) * 100) if p and s else None
            ),
            "resistance_distance_percent": (
                round_value(((r - p) / p) * 100) if p and r else None
            ),
        }
    return res


def technical_main_signal(market_data):
    tf = market_data["timeframes"]
    a15, a1h, a4h = tf["15m"], tf["1h"], tf["4h"]
    s15 = timeframe_signal_from_indicators(a15)
    s1h = timeframe_signal_from_indicators(a1h)
    s4h = timeframe_signal_from_indicators(a4h)
    swing = a15.get("swing_failure_structure") or {}
    swing_sig = swing.get("signal", "HOLD")

    # Final deterministic resolution
    if swing_sig == "BUY" and s1h == "BUY" and s4h != "SELL":
        signal, risk, conf = "BUY", "MEDIUM", 78
        reason = (
            "15m body-close breakout, volume, retest and 1h alignment passed."
        )
        status = "BUY confirmed structure and retest passed"
        bias = "Bullish technical bias"
    elif swing_sig == "SELL" and s1h == "SELL" and s4h != "BUY":
        signal, risk, conf = "SELL", "MEDIUM", 78
        reason = (
            "15m breakdown, volume, retest and 1h bearish alignment passed."
        )
        status = "SELL confirmed structure and retest passed"
        bias = "Bearish technical bias"
    else:
        signal, risk, conf = "HOLD", "HIGH", 50
        reason = (
            swing.get("reason")
            or "15m, 1h and 4h signals lack full structural alignment."
        )
        status = "Mixed / retest pending"
        bias = "Neutral / mixed technical bias"

    # Candidate Level Formulas (Handover Contract)
    last_close = float(a15["price"])
    atr_val = float(a15["atr_14"])
    retest_lvl = float(swing.get("retest_level") or last_close)

    entry_p, sl_p, t1_p, t2_p = 0.0, 0.0, 0.0, 0.0
    if signal == "BUY" and retest_lvl > 0 and atr_val > 0:
        entry_p = round_value(last_close)
        sl_p = round_value(retest_lvl - (0.25 * atr_val))
        r = entry_p - sl_p
        if r > 0:
            t1_p = round_value(entry_p + (1.0 * r))
            t2_p = round_value(entry_p + (2.0 * r))
    elif signal == "SELL" and retest_lvl > 0 and atr_val > 0:
        entry_p = round_value(last_close)
        sl_p = round_value(retest_lvl + (0.25 * atr_val))
        r = sl_p - entry_p
        if r > 0:
            t1_p = round_value(entry_p - (1.0 * r))
            t2_p = round_value(entry_p - (2.0 * r))

    if signal == "HOLD":
        entry_p, sl_p, t1_p, t2_p = 0.0, 0.0, 0.0, 0.0

    def tf_obj(a, s):
        return {
            "signal": s,
            "summary": f"{a['trend']} trend; RSI {a['rsi_14']}; {a['macd']['state']}.",
            "key_level": (
                f"${a['support_resistance']['support_20']:,.2f} /"
                f" ${a['support_resistance']['resistance_20']:,.2f}"
            ),
        }

    return {
        "signal": signal,
        "confidence": conf,
        "risk": risk,
        "market_bias": bias,
        "setup_status": status,
        "reason": reason,
        "confirmation_needed": (
            "No extra confirmation required by current engine rules."
            if signal != "HOLD"
            else "Wait for 15m breakout & retest confirmation."
        ),
        "entry_idea": (
            f"Candidate entry: ${entry_p:,.2f}"
            if entry_p > 0
            else "Candidate entry: $0.00"
        ),
        "stop_loss_idea": (
            f"Candidate invalidation: ${sl_p:,.2f}"
            if sl_p > 0
            else "Candidate invalidation: $0.00"
        ),
        "target_1": f"${t1_p:,.2f}" if t1_p > 0 else "$0.00",
        "target_2": f"${t2_p:,.2f}" if t2_p > 0 else "$0.00",
        "entry_price": entry_p,
        "stop_loss_price": sl_p,
        "target_1_price": t1_p,
        "target_2_price": t2_p,
        "overlay_allowed": False,  # Engine NEVER draws on live chart
        "provider": "ENGINE",
        "manual_run_only": False,
        "timeframes": {
            "15m": tf_obj(a15, s15),
            "1h": tf_obj(a1h, s1h),
            "4h": tf_obj(a4h, s4h),
        },
    }


def build_setup_quality(market_data, technical_result):
    tf = market_data.get("timeframes", {})
    m15, m1h, m4h = tf.get("15m", {}), tf.get("1h", {}), tf.get("4h", {})
    agreement = calculate_timeframe_agreement(market_data)
    regime = calculate_market_regime(market_data)
    levels = calculate_key_level_distance(market_data)
    signal = str(technical_result.get("signal", "HOLD")).upper()
    direction = (
        "BUY" if "BUY" in signal else "SELL" if "SELL" in signal else "NEUTRAL"
    )
    items, flags = [], []

    def add(key, label, state, reason):
        items.append(
            {"key": key, "label": label, "state": state, "reason": reason}
        )

    ag_pct = float(agreement.get("percent", 0))
    if direction != "NEUTRAL" and ag_pct >= 67:
        add(
            "trend_alignment",
            "Multi-timeframe trend alignment",
            "PASS",
            f"{agreement.get('direction', 'Aligned')} alignment ({ag_pct:.0f}%).",
        )
    elif ag_pct >= 67:
        add(
            "trend_alignment",
            "Multi-timeframe trend alignment",
            "WAIT",
            f"Timeframes agree on HOLD ({ag_pct:.0f}%).",
        )
    else:
        add(
            "trend_alignment",
            "Multi-timeframe trend alignment",
            "FAIL",
            f"Timeframes mixed ({ag_pct:.0f}%).",
        )
        flags.append("Mixed timeframe direction")

    reg_l = str(regime.get("label", "Ranging"))
    adx_v = float(regime.get("average_adx", 0))
    if reg_l == "Trending":
        add(
            "market_regime",
            "Market regime suitability",
            "PASS",
            f"Trending regime (ADX {adx_v:.1f}).",
        )
    elif reg_l == "High Volatility":
        add(
            "market_regime",
            "Market regime suitability",
            "WAIT",
            "High volatility; wider invalidation needed.",
        )
        flags.append("High volatility")
    else:
        add(
            "market_regime",
            "Market regime suitability",
            "WAIT",
            f"{reg_l} conditions need extra confirmation.",
        )

    rsis = [
        float(m15.get("rsi_14", 50)),
        float(m1h.get("rsi_14", 50)),
        float(m4h.get("rsi_14", 50)),
    ]
    moms = [
        float(m15.get("momentum_percent", 0)),
        float(m1h.get("momentum_percent", 0)),
        float(m4h.get("momentum_percent", 0)),
    ]
    mom_ok = (
        direction == "BUY"
        and sum(50 <= v <= 72 for v in rsis) >= 2
        and sum(v >= 0 for v in moms) >= 2
    ) or (
        direction == "SELL"
        and sum(28 <= v <= 50 for v in rsis) >= 2
        and sum(v <= 0 for v in moms) >= 2
    )
    add(
        "momentum",
        "RSI & Momentum confirmation",
        "PASS" if mom_ok else "WAIT",
        (
            "At least 2 timeframes support live direction."
            if mom_ok
            else "Momentum not yet confirmed."
        ),
    )

    macds = [
        str(i.get("macd", {}).get("state", "")).lower() for i in [m15, m1h, m4h]
    ]
    m_count = (
        sum("bullish" in s for s in macds)
        if direction == "BUY"
        else sum("bearish" in s for s in macds) if direction == "SELL" else 0
    )
    add(
        "macd",
        "MACD confirmation",
        "PASS" if m_count >= 2 else "WAIT",
        f"MACD aligns on {m_count}/3 timeframes.",
    )

    v15 = float(m15.get("volume", {}).get("volume_ratio", 0))
    v1h = float(m1h.get("volume", {}).get("volume_ratio", 0))
    tb_r = float(m15.get("volume", {}).get("taker_buy_ratio_20_percent", 50))
    vol_ok = (v15 >= 1.0 or v1h >= 1.0) and (
        (direction == "BUY" and tb_r >= 50)
        or (direction == "SELL" and tb_r <= 50)
    )
    add(
        "volume",
        "Volume confirmation",
        "PASS" if vol_ok else "WAIT",
        f"Volume: 15m x{v15:.2f}, 1h x{v1h:.2f}.",
    )

    brk = str(m15.get("breakout_status", "No breakout"))
    strct = str(m1h.get("market_structure", "Range"))
    s_ok = (
        direction == "BUY"
        and ("bullish" in brk.lower() or "bullish" in strct.lower())
    ) or (
        direction == "SELL"
        and ("bearish" in brk.lower() or "bearish" in strct.lower())
    )
    add(
        "structure",
        "Market Structure / Breakout",
        "PASS" if s_ok else "WAIT",
        f"15m: {brk}, 1h: {strct}.",
    )

    l15 = levels.get("15m", {})
    s_dist = float(l15.get("support_distance_percent") or 0)
    r_dist = float(l15.get("resistance_distance_percent") or 0)
    lvl_ok = (
        r_dist >= 0.35
        if direction == "BUY"
        else s_dist >= 0.35 if direction == "SELL" else False
    )
    add(
        "key_levels",
        "Support/Resistance distance",
        "PASS" if lvl_ok else "WAIT",
        (
            f"Nearest level: +{r_dist:.2f}%"
            if direction == "BUY"
            else f"Nearest level: -{s_dist:.2f}%"
        ),
    )

    add(
        "ai_alignment",
        "AI vs Live Technical Alignment",
        "WAIT",
        "Click manual AI Review for fresh alignment check.",
    )

    passed = sum(i["state"] == "PASS" for i in items)
    waiting = sum(i["state"] == "WAIT" for i in items)
    failed = sum(i["state"] == "FAIL" for i in items)

    grade = (
        "A"
        if passed >= 6 and failed == 0
        else (
            "B"
            if passed >= 4 and failed <= 1
            else "C" if passed >= 2 else "D"
        )
    )
    state = (
        "READY"
        if grade == "A"
        else (
            "WAIT FOR TRIGGER"
            if grade == "B"
            else "AVOID" if grade == "D" else "WAIT / LOW QUALITY"
        )
    )

    return {
        "grade": grade,
        "execution_state": state,
        "direction": direction,
        "score": {
            "passed": passed,
            "waiting": waiting,
            "failed": failed,
            "total": len(items),
        },
        "decision_reason": (
            "Technical alignment confirmed."
            if grade in ("A", "B")
            else "Conditions mixed; wait for clear structure."
        ),
        "risk_flags": flags,
        "items": items,
    }


def build_market_data():
    ticker = get_btc_ticker()
    a15 = calculate_market_indicators(
        get_btc_klines(interval="15m", limit=250), "15m"
    )
    a1h = calculate_market_indicators(
        get_btc_klines(interval="1h", limit=250), "1h"
    )
    a4h = calculate_market_indicators(
        get_btc_klines(interval="4h", limit=250), "4h"
    )
    a15["swing_failure_structure"] = calculate_swing_failure_structure(
        get_btc_klines(interval="15m", limit=250),
        a15["atr_14"],
        volume_ratio=a15["volume"]["volume_ratio"],
        rsi_value=a15["rsi_14"],
        macd_state=a15["macd"]["state"],
        trend_1h=a1h["trend"],
        trend_4h=a4h["trend"],
    )
    return {
        "symbol": "BTCUSDT",
        "current_price_usdt": round_value(ticker["lastPrice"]),
        "price_change_24h_percent": round_value(ticker["priceChangePercent"]),
        "high_24h_usdt": round_value(ticker["highPrice"]),
        "low_24h_usdt": round_value(ticker["lowPrice"]),
        "quote_volume_24h_usdt": round_value(ticker["quoteVolume"]),
        "timeframes": {"15m": a15, "1h": a1h, "4h": a4h},
    }


def get_technical_market_data(force_refresh=False):
    now = time.time()
    cache_age = now - technical_cache["updated_at"]
    if (
        not force_refresh
        and technical_cache["data"]
        and cache_age < TECHNICAL_CACHE_SECONDS
    ):
        return technical_cache["data"], True, cache_age, None
    try:
        market_data = build_market_data()
        technical_cache["data"], technical_cache["updated_at"] = (
            market_data,
            now,
        )
        return market_data, False, 0.0, None
    except (requests.exceptions.RequestException, ValueError) as error:
        if technical_cache["data"]:
            return (
                technical_cache["data"],
                True,
                now - technical_cache["updated_at"],
                str(error),
            )
        raise HTTPException(
            status_code=502, detail="Live market data temporarily unavailable."
        ) from error


def build_data_health(cached, cache_age, refresh_error=None):
    if refresh_error:
        status = (
            "DELAYED" if cache_age <= TECHNICAL_DELAYED_SECONDS else "ERROR"
        )
        message = "Live refresh failed. Showing last saved technical data."
    elif cached:
        status, message = (
            "CACHED",
            "Recent technical data served from cache.",
        )
    else:
        status, message = "LIVE", "Fresh Binance data received."
    return {
        "status": status,
        "message": message,
        "cached": cached,
        "cache_age_seconds": round_value(max(cache_age, 0), 1),
        "refresh_error": refresh_error,
        "technical_cache_seconds": TECHNICAL_CACHE_SECONDS,
    }


def build_technical_response(
    market_data, cached=False, cache_age=0.0, refresh_error=None
):
    result = technical_main_signal(market_data)
    result.update(
        {
            "market_data": market_data,
            "source": "Binance live technical analysis",
            "analysis_mode": "deterministic_engine",
            "cached": cached,
            "updated_at": int(time.time()),
            "data_health": build_data_health(cached, cache_age, refresh_error),
            "score_breakdown": calculate_score_breakdown(market_data),
            "market_regime": calculate_market_regime(market_data),
            "timeframe_agreement": calculate_timeframe_agreement(market_data),
            "key_level_distance": calculate_key_level_distance(market_data),
            "setup_quality": build_setup_quality(market_data, result),
            "disclaimer": (
                "Educational market analysis only. Not financial advice or an"
                " automated trading instruction."
            ),
        }
    )
    return result


def validate_ai_payload(data: dict, provider: str, current_price: float) -> dict:
    data = data if isinstance(data, dict) else {}
    signal = normalize_signal(data.get("signal", "HOLD"))

    try:
        conf = max(0, min(100, int(float(data.get("confidence", 50) or 50))))
    except (TypeError, ValueError):
        conf = 50

    def get_num(key):
        try:
            val = float(data.get(key, 0) or 0)
            return round(val, 2) if val > 0 else 0.0
        except (TypeError, ValueError):
            return 0.0

    entry = get_num("entry_price")
    sl = get_num("stop_loss_price")
    t1 = get_num("target_1_price")
    t2 = get_num("target_2_price")

    is_valid = False
    if signal == "BUY" and (sl < entry < t1 < t2) and sl > 0:
        is_valid = True
    elif signal == "SELL" and (t2 < t1 < entry < sl) and t2 > 0:
        is_valid = True

    if not is_valid:
        signal = "HOLD"
        entry, sl, t1, t2 = 0.0, 0.0, 0.0, 0.0

    return {
        "signal": signal,
        "confidence": conf,
        "risk": data.get("risk", "MEDIUM"),
        "market_bias": data.get("market_bias", "Neutral bias"),
        "setup_status": data.get(
            "setup_status",
            f"{provider} educational review complete.",
        ),
        "reason": (
            data.get("reason", "")
            or "Structure not confirmed for a directional trade."
        ),
        "confirmation_needed": data.get(
            "confirmation_needed", "Wait for confirmed structure."
        ),
        "entry_idea": f"${entry:,.2f}" if entry > 0 else "--",
        "stop_loss_idea": f"${sl:,.2f}" if sl > 0 else "--",
        "target_1": f"${t1:,.2f}" if t1 > 0 else "--",
        "target_2": f"${t2:,.2f}" if t2 > 0 else "--",
        "entry_price": entry,
        "stop_loss_price": sl,
        "target_1_price": t1,
        "target_2_price": t2,
        "valid_position": is_valid,
        "overlay_allowed": is_valid,
        "provider": provider,
        "manual_run_only": True,
        "updated_at": int(time.time()),
        "disclaimer": (
            "Educational AI chart analysis only. Not financial advice."
        ),
    }


def parse_json_from_model(text):
    cleaned = str(text or "").strip()
    if cleaned.startswith("```"):
        cleaned = re.sub(
            r"^```(?:json)?\s*|\s*```$", "", cleaned, flags=re.IGNORECASE
        ).strip()
    start, end = cleaned.find("{"), cleaned.rfind("}")
    if start != -1 and end != -1 and end > start:
        cleaned = cleaned[start : end + 1]
    try:
        return json.loads(cleaned)
    except json.JSONDecodeError as error:
        raise ValueError("AI returned invalid JSON.") from error


def ensure_groq_configured():
    api_key = os.getenv("GROQ_API_KEY")
    if not api_key:
        raise HTTPException(
            status_code=503,
            detail="Groq AI is not configured. Add GROQ_API_KEY.",
        )
    return Groq(api_key=api_key)


def cooldown_remaining(cache, cooldown_seconds):
    elapsed = time.time() - cache["updated_at"]
    return max(0, int(math.ceil(cooldown_seconds - elapsed)))


# --- ROUTES ---


@app.get("/api/health")
def health():
    return {
        "status": "ok",
        "message": "BTC Signal Dashboard Backend Live",
        "market_data_source": "Binance",
        "gemini_configured": bool(os.getenv("GEMINI_API_KEY")),
        "groq_configured": bool(os.getenv("GROQ_API_KEY")),
    }


@app.get("/api/btc/price")
def btc_price(force_refresh: bool = False):
    now = time.time()
    cache_age = now - price_cache["updated_at"]
    if not force_refresh and price_cache["data"] and cache_age < 15:
        return {
            **price_cache["data"],
            "cached": True,
            "cache_age_seconds": round(cache_age, 1),
        }
    try:
        ticker = get_btc_ticker()
        current_price = float(ticker["lastPrice"])
        prev_close, d_change = get_btc_daily_change(current_price)
        res = {
            "bitcoin": {
                "usd": current_price,
                "usd_24h_change": d_change,
                "price_change_24h_usd": float(ticker["priceChange"]),
                "open_price_24h_usd": float(ticker["openPrice"]),
                "previous_daily_close": prev_close,
            },
            "source": "Binance",
            "cached": False,
            "updated_at": int(now),
        }
        price_cache["data"], price_cache["updated_at"] = res, now
        return res
    except Exception as error:
        if price_cache["data"]:
            return {**price_cache["data"], "cached": True}
        raise HTTPException(
            status_code=502, detail=f"Price feed error: {error}"
        ) from error


@app.get("/api/btc/chart")
def btc_chart(days: int = 7, interval: str = "1h"):
    now = time.time()
    allowed = {"15m", "1h", "1d", "1w"}
    if interval not in allowed:
        raise HTTPException(status_code=400, detail="Unsupported interval.")
    cache_key = f"{interval}:{days}"
    limit = {"15m": 96, "1h": 168, "1d": 30, "1w": 20}.get(interval, 100)
    cached = chart_cache["data"].get(cache_key)
    if cached and now - cached["updated_at"] < 60:
        return {**cached, "cached": True}
    try:
        candles = get_btc_klines(interval=interval, limit=limit)
        res = {
            "prices": [[int(c[0]), float(c[4])] for c in candles],
            "interval": interval,
            "days": days,
            "source": "Binance",
            "cached": False,
            "updated_at": int(now),
        }
        chart_cache["data"][cache_key], chart_cache["updated_at"] = res, now
        return res
    except Exception as error:
        if cached:
            return {**cached, "cached": True}
        raise HTTPException(
            status_code=502, detail=f"Chart feed error: {error}"
        ) from error


@app.get("/api/btc/candles")
def btc_candles(interval: str = "15m", limit: int = 200):
    allowed = {"1m", "5m", "15m", "1h", "4h", "1d", "1w"}
    if interval not in allowed:
        raise HTTPException(status_code=400, detail="Unsupported interval.")
    try:
        raw = get_btc_klines(interval=interval, limit=min(limit, 500))
        candles = [
            {
                "time": int(int(c[0]) / 1000),
                "open": float(c[1]),
                "high": float(c[2]),
                "low": float(c[3]),
                "close": float(c[4]),
                "volume": float(c[5]),
            }
            for c in raw
        ]
        return {
            "symbol": "BTCUSDT",
            "interval": interval,
            "candles": candles,
            "updated_at": int(time.time()),
        }
    except Exception as error:
        raise HTTPException(
            status_code=502, detail=f"Binance candle error: {error}"
        ) from error


@app.get("/api/technical-signal")
def technical_signal(force_refresh: bool = False):
    market_data, cached, cache_age, refresh_error = get_technical_market_data(
        force_refresh
    )
    return build_technical_response(
        market_data,
        cached=cached,
        cache_age=cache_age,
        refresh_error=refresh_error,
    )


@app.get("/api/rrg")
def rrg(interval: str = "1d"):
    now = time.time()
    if interval not in {"1h", "1d"}:
        raise HTTPException(status_code=400, detail="RRG interval 1h or 1d.")
    cached = rrg_cache["data"].get(interval)
    if cached and now - cached["updated_at"] < 300:
        return {**cached, "cached": True}
    try:
        symbols = ["BTCUSDT", "ETHUSDT", "SOLUSDT"]
        candles = {s: get_klines(s, interval, 120) for s in symbols}
        closes = {s: [float(c[4]) for c in candles[s]] for s in symbols}
        times = [int(c[0]) for c in candles["ETHUSDT"]]
        trails = []
        for s in symbols:
            if s == "ETHUSDT":
                trails.append(
                    {
                        "symbol": "ETHUSDT",
                        "points": [
                            {"x": 100.0, "y": 100.0, "timestamp": times[i]}
                            for i in range(-4, 0)
                        ],
                        "direction": "Flat",
                    }
                )
                continue
            ratios = [(p / b) * 100 for p, b in zip(closes[s], closes["ETHUSDT"])]
            r_sma = [
                average(ratios[i - 20 + 1 : i + 1]) if i >= 19 else None
                for i in range(len(ratios))
            ]
            rs_idx = [
                (ratios[i] / r_sma[i]) * 100 if r_sma[i] else None
                for i in range(len(ratios))
            ]
            m_sma = [
                average(
                    [
                        v
                        for v in rs_idx[i - 9 : i + 1]
                        if v is not None
                    ]
                )
                if i >= 28 and rs_idx[i] is not None
                else None
                for i in range(len(rs_idx))
            ]
            mom_idx = [
                (rs_idx[i] / m_sma[i]) * 100 if m_sma[i] else None
                for i in range(len(rs_idx))
            ]
            pts = [
                {
                    "x": round_value(rs_idx[i]),
                    "y": round_value(mom_idx[i]),
                    "timestamp": times[i],
                }
                for i in range(len(rs_idx))
                if rs_idx[i] and mom_idx[i]
            ]
            trails.append(
                {"symbol": s, "points": pts[-4:], "direction": "North-East"}
            )
        res = {
            "benchmark": "ETHUSDT",
            "interval": interval,
            "trails": trails,
            "updated_at": int(now),
        }
        rrg_cache["data"][interval] = res
        return res
    except Exception as error:
        if cached:
            return {**cached, "cached": True}
        raise HTTPException(
            status_code=502, detail=f"RRG calculation error: {error}"
        ) from error


@app.post("/api/ai-signal/run")
def run_gemini_ai_signal():
    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        raise HTTPException(
            status_code=503, detail="GEMINI_API_KEY is not configured."
        )
    try:
        market_data, _, _, _ = get_technical_market_data(force_refresh=True)
        tech_res = technical_main_signal(market_data)
        client = genai.Client(api_key=api_key)

        prompt = f"""
Analyze this BTC technical data. You must return only BUY, SELL, or HOLD.
Data: {json.dumps(market_data, indent=2)}
Technical Engine: {json.dumps(tech_res, indent=2)}

Rules:
- Signal MUST be strictly BUY, SELL, or HOLD.
- If BUY: stop_loss_price < entry_price < target_1_price < target_2_price.
- If SELL: target_2_price < target_1_price < entry_price < stop_loss_price.
- If HOLD: set entry_price, stop_loss_price, target_1_price, target_2_price to 0.
- Simple Hinglish explanation in 'reason'.
"""
        schema = {
            "type": "object",
            "properties": {
                "signal": {"type": "string", "enum": ["BUY", "SELL", "HOLD"]},
                "confidence": {"type": "integer"},
                "risk": {"type": "string", "enum": ["LOW", "MEDIUM", "HIGH"]},
                "market_bias": {"type": "string"},
                "setup_status": {"type": "string"},
                "reason": {"type": "string"},
                "confirmation_needed": {"type": "string"},
                "entry_price": {"type": "number"},
                "stop_loss_price": {"type": "number"},
                "target_1_price": {"type": "number"},
                "target_2_price": {"type": "number"},
            },
            "required": [
                "signal",
                "confidence",
                "risk",
                "reason",
                "entry_price",
                "stop_loss_price",
                "target_1_price",
                "target_2_price",
            ],
        }

        response = client.models.generate_content(
            model=GEMINI_MODEL,
            contents=prompt,
            config=types.GenerateContentConfig(
                response_mime_type="application/json",
                response_json_schema=schema,
            ),
        )
        parsed = json.loads(response.text)
        result = validate_ai_payload(
            parsed, "GEMINI", market_data["current_price_usdt"]
        )
        result["market_data"] = market_data
        ai_signal_cache["data"], ai_signal_cache["updated_at"] = (
            result,
            time.time(),
        )
        return result
    except Exception as error:
        print(f"Gemini error: {error}")
        raise HTTPException(
            status_code=503, detail=f"Gemini AI error: {error}"
        ) from error


@app.post("/api/groq-live-analysis")
def run_groq_live_analysis():
    rem = cooldown_remaining(groq_live_cache, GROQ_LIVE_COOLDOWN_SECONDS)
    if rem > 0:
        raise HTTPException(
            status_code=429, detail=f"Groq cooldown active ({rem}s)."
        )
    try:
        client = ensure_groq_configured()
        market_data, _, _, _ = get_technical_market_data(force_refresh=True)
        tech_res = technical_main_signal(market_data)

        prompt = f"""
You are a BTC live-chart assistant. Analyze technical data and output strictly BUY, SELL, or HOLD.
Market: {json.dumps(market_data, indent=2)}
Engine: {json.dumps(tech_res, indent=2)}

Return JSON:
{{"signal":"HOLD","confidence":50,"risk":"MEDIUM","market_bias":"Neutral","setup_status":"Review","reason":"Simple Hinglish reason","confirmation_needed":"Wait","entry_price":0,"stop_loss_price":0,"target_1_price":0,"target_2_price":0}}
"""
        completion = client.chat.completions.create(
            model=GROQ_MODEL,
            temperature=0.1,
            max_tokens=800,
            response_format={"type": "json_object"},
            messages=[
                {"role": "system", "content": "Return valid JSON only."},
                {"role": "user", "content": prompt},
            ],
        )
        text = completion.choices[0].message.content if completion.choices else "{}"
        parsed = parse_json_from_model(text)
        result = validate_ai_payload(
            parsed, "GROQ", market_data["current_price_usdt"]
        )
        result["market_data"] = market_data
        groq_live_cache["data"], groq_live_cache["updated_at"] = (
            result,
            time.time(),
        )
        return result
    except Exception as error:
        print(f"Groq live analysis error: {error}")
        raise HTTPException(
            status_code=503, detail=f"Groq live analysis error: {error}"
        ) from error


def strip_html(text):
    text = re.sub(r"<[^>]+>", " ", str(text or ""))
    return " ".join(text.split())


def parse_rss_time(value):
    try:
        p = parsedate_to_datetime(value)
        return (
            p.astimezone(timezone.utc)
            if p.tzinfo
            else p.replace(tzinfo=timezone.utc)
        )
    except Exception:
        return None


def fetch_rss_news():
    import xml.etree.ElementTree as ET

    collected, seen = [], set()
    headers = {"User-Agent": "Mozilla/5.0"}
    for src in RSS_NEWS_SOURCES:
        try:
            r = requests.get(
                src["url"], timeout=RSS_NEWS_TIMEOUT_SECONDS, headers=headers
            )
            root = ET.fromstring(r.content)
            items = root.findall(".//item") or root.findall(
                ".//{[http://www.w3.org/2005/Atom](http://www.w3.org/2005/Atom)}entry"
            )
            for item in items[:20]:
                title = item.find("title")
                title_text = (
                    title.text.strip()
                    if title is not None and title.text
                    else ""
                )
                link = item.find("link")
                link_text = (
                    link.text.strip() if link is not None and link.text else ""
                )
                if not link_text:
                    link_text = item.find(
                        "{[http://www.w3.org/2005/Atom](http://www.w3.org/2005/Atom)}link"
                    ).attrib.get("href", "")
                desc = item.find("description") or item.find(
                    "{[http://www.w3.org/2005/Atom](http://www.w3.org/2005/Atom)}summary"
                )
                desc_text = (
                    desc.text.strip() if desc is not None and desc.text else ""
                )
                if not title_text or not link_text:
                    continue
                if link_text in seen:
                    continue
                seen.add(link_text)
                collected.append(
                    {
                        "headline": strip_html(title_text)[:250],
                        "source": src["name"],
                        "url": link_text,
                        "published_time": "Recent",
                        "summary": strip_html(desc_text)[:400]
                        or "Open article for full details.",
                    }
                )
        except Exception as e:
            print(f"RSS source {src['name']} error: {e}")
    return collected[:AI_NEWS_LIMIT]


@app.post("/api/groq-news")
def run_groq_news():
    news_items = fetch_rss_news()
    overview = (
        "Latest RSS crypto headlines loaded. Open articles for full context."
    )
    sentiment = "NEUTRAL"
    try:
        client = ensure_groq_configured()
        compact = [
            {"headline": i["headline"], "summary": i["summary"][:200]}
            for i in news_items[:6]
        ]
        prompt = f"Summarize sentiment in 2 Hinglish sentences for crypto news: {json.dumps(compact)}. Return JSON with keys: overall_sentiment (BULLISH/BEARISH/NEUTRAL/UNCLEAR), overview."
        comp = client.chat.completions.create(
            model=GROQ_MODEL,
            temperature=0.1,
            max_tokens=300,
            response_format={"type": "json_object"},
            messages=[{"role": "user", "content": prompt}],
        )
        parsed = parse_json_from_model(comp.choices[0].message.content)
        overview = parsed.get("overview", overview)
        sentiment = parsed.get("overall_sentiment", "NEUTRAL")
    except Exception as e:
        print(f"Groq news summary error: {e}")

    return {
        "news": news_items,
        "news_overview": overview,
        "news_market_bias": sentiment,
        "updated_at": int(time.time()),
        "provider": "GROQ",
        "manual_run_only": True,
        "disclaimer": (
            "News context only. Does not generate signals or trade levels."
        ),
    }


@app.post("/api/news/translate")
def translate_news(payload: dict = Body(...)):
    headline = payload.get("headline", "")
    summary = payload.get("summary", "")
    try:
        client = ensure_groq_configured()
        prompt = f"Translate to natural Hindi in JSON: {{\"headline_hi\": \"...\", \"summary_hi\": \"...\"}}\nHeadline: {headline}\nSummary: {summary}"
        comp = client.chat.completions.create(
            model=GROQ_MODEL,
            temperature=0.1,
            max_tokens=500,
            response_format={"type": "json_object"},
            messages=[{"role": "user", "content": prompt}],
        )
        return parse_json_from_model(comp.choices[0].message.content)
    except Exception as e:
        raise HTTPException(
            status_code=503, detail=f"Translation error: {e}"
        ) from e


@app.post("/api/chart-analyser")
async def chart_analyser(file: UploadFile = File(...)):
    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        raise HTTPException(
            status_code=503, detail="GEMINI_API_KEY not configured."
        )
    bytes_data = await file.read()
    try:
        client = genai.Client(api_key=api_key)
        prompt = "Analyze chart screenshot in Hinglish. Output BUY, SELL, or HOLD only. Return valid JSON."
        schema = {
            "type": "object",
            "properties": {
                "signal": {"type": "string", "enum": ["BUY", "SELL", "HOLD"]},
                "confidence": {"type": "integer"},
                "risk": {"type": "string", "enum": ["LOW", "MEDIUM", "HIGH"]},
                "trend": {"type": "string"},
                "pattern": {"type": "string"},
                "support": {"type": "string"},
                "resistance": {"type": "string"},
                "reason": {"type": "string"},
                "entry_idea": {"type": "string"},
                "invalidation_idea": {"type": "string"},
                "warning": {"type": "string"},
            },
            "required": [
                "signal",
                "confidence",
                "risk",
                "trend",
                "pattern",
                "support",
                "resistance",
                "reason",
                "entry_idea",
                "invalidation_idea",
                "warning",
            ],
        }
        res = client.models.generate_content(
            model=GEMINI_MODEL,
            contents=[
                prompt,
                types.Part.from_bytes(
                    data=bytes_data, mime_type=file.content_type
                ),
            ],
            config=types.GenerateContentConfig(
                response_mime_type="application/json",
                response_json_schema=schema,
            ),
        )
        return json.loads(res.text)
    except Exception as e:
        raise HTTPException(
            status_code=503, detail=f"Analyser error: {e}"
        ) from e


app.mount("/frontend", StaticFiles(directory="frontend"), name="frontend")


@app.get("/")
def home():
    return FileResponse("frontend/index.html")
