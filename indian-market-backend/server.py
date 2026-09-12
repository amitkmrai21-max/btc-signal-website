import os
import time
from urllib.parse import quote
from datetime import datetime, timezone

from flask import Flask, jsonify, request
from flask_cors import CORS
from google import genai
import requests

app = Flask(__name__)
CORS(app)

APP_STARTED_AT = time.time()
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "").strip()
GEMINI_MODEL = os.environ.get("GEMINI_MODEL", "gemini-3.6-flash").strip()
UPSTOX_ACCESS_TOKEN = os.environ.get("UPSTOX_ACCESS_TOKEN", "").strip()

UPSTOX_MARKETS = {
    "nifty": {
        "name": "NIFTY 50",
        "instrument_key": "NSE_INDEX|Nifty 50",
    },
    "banknifty": {
        "name": "Bank Nifty",
        "instrument_key": "NSE_INDEX|Nifty Bank",
    },
}

UPSTOX_TIMEFRAMES = {
    "5m": ("minutes", 5),
    "15m": ("minutes", 15),
    "1h": ("hours", 1),
    "1d": ("days", 1),
}
DEMO_MARKETS = {
    "nifty": {
        "name": "NIFTY 50",
        "price": 24680.55,
        "open": 24592.20,
        "high": 24718.90,
        "low": 24540.10,
        "previous_close": 24528.50,
        "volume_ratio": 1.18,
        "rsi_14": 58.4,
        "ema_9": 24654.20,
        "ema_21": 24618.80,
        "ema_50": 24580.10,
        "vwap": 24620.40,
        "macd_histogram": 12.6,
        "atr_14": 118.0,
        "support": 24580.0,
        "resistance": 24760.0,
        "trend_5m": "bullish",
        "trend_15m": "bullish",
        "trend_1h": "neutral",
    },
    "banknifty": {
        "name": "Bank Nifty",
        "price": 55112.40,
        "open": 54940.50,
        "high": 55220.80,
        "low": 54888.10,
        "previous_close": 54886.30,
        "volume_ratio": 1.10,
        "rsi_14": 54.8,
        "ema_9": 55072.30,
        "ema_21": 55020.80,
        "ema_50": 54940.40,
        "vwap": 55035.60,
        "macd_histogram": 18.2,
        "atr_14": 248.0,
        "support": 54920.0,
        "resistance": 55250.0,
        "trend_5m": "bullish",
        "trend_15m": "neutral",
        "trend_1h": "bullish",
    },
}

# How long a live market snapshot stays cached before re-fetching from Upstox,
# so simultaneous dashboard/technical-engine requests don't each hit the API.
LIVE_SNAPSHOT_CACHE_SECONDS = 20
_live_snapshot_cache = {}


def now_utc():
    return datetime.now(timezone.utc).isoformat()


# ===================== Upstox live data + indicators =====================

def fetch_upstox_candles(instrument_key, unit, interval):
    """Fetches intraday candles from Upstox V3 and returns them in
    chronological order as a list of dicts. Raises on any failure so callers
    can decide how to fall back."""
    if not UPSTOX_ACCESS_TOKEN:
        raise RuntimeError("Upstox access token is not configured on the server.")

    encoded_instrument_key = quote(instrument_key, safe="")
    url = f"https://api.upstox.com/v3/historical-candle/intraday/{encoded_instrument_key}/{unit}/{interval}"
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json",
        "Authorization": f"Bearer {UPSTOX_ACCESS_TOKEN}",
    }

    response = requests.get(url, headers=headers, timeout=20)
    if not response.ok:
        raise RuntimeError(f"Upstox candle request failed: status={response.status_code}")

    payload = response.json()
    raw_candles = (payload.get("data") or {}).get("candles") or []

    candles = [
        {
            "time": row[0],
            "open": float(row[1]),
            "high": float(row[2]),
            "low": float(row[3]),
            "close": float(row[4]),
            "volume": float(row[5]),
        }
        for row in reversed(raw_candles)
        if isinstance(row, list) and len(row) >= 6
    ]
    return candles


def ema_series(values, period):
    """Returns the full EMA series (same length as values, with leading None
    entries before the series has enough data to seed the average)."""
    if len(values) < period:
        return [None] * len(values)
    multiplier = 2 / (period + 1)
    result = [None] * (period - 1)
    seed = sum(values[:period]) / period
    result.append(seed)
    previous = seed
    for value in values[period:]:
        current = (value - previous) * multiplier + previous
        result.append(current)
        previous = current
    return result


def last_ema(values, period):
    series = ema_series(values, period)
    return series[-1] if series and series[-1] is not None else (values[-1] if values else 0)


def calculate_rsi(closes, period=14):
    if len(closes) < period + 1:
        return 50.0
    gains, losses = [], []
    for i in range(1, len(closes)):
        change = closes[i] - closes[i - 1]
        gains.append(max(change, 0))
        losses.append(max(-change, 0))
    avg_gain = sum(gains[:period]) / period
    avg_loss = sum(losses[:period]) / period
    for i in range(period, len(gains)):
        avg_gain = (avg_gain * (period - 1) + gains[i]) / period
        avg_loss = (avg_loss * (period - 1) + losses[i]) / period
    if avg_loss == 0:
        return 100.0
    rs = avg_gain / avg_loss
    return round(100 - (100 / (1 + rs)), 2)


def calculate_macd_histogram(closes):
    if len(closes) < 26:
        return 0.0
    ema12 = ema_series(closes, 12)
    ema26 = ema_series(closes, 26)
    macd_line = [
        (a - b) if (a is not None and b is not None) else None
        for a, b in zip(ema12, ema26)
    ]
    macd_values = [value for value in macd_line if value is not None]
    if len(macd_values) < 9:
        return round(macd_values[-1], 2) if macd_values else 0.0
    signal = ema_series(macd_values, 9)
    if not signal or signal[-1] is None:
        return round(macd_values[-1], 2)
    return round(macd_values[-1] - signal[-1], 2)


def calculate_atr(candles, period=14):
    if len(candles) < period + 1:
        return 0.0
    true_ranges = []
    for i in range(1, len(candles)):
        high, low = candles[i]["high"], candles[i]["low"]
        prev_close = candles[i - 1]["close"]
        true_ranges.append(max(high - low, abs(high - prev_close), abs(low - prev_close)))
    return round(sum(true_ranges[-period:]) / period, 2)


def calculate_vwap(candles):
    cumulative_pv, cumulative_volume = 0.0, 0.0
    for candle in candles:
        typical_price = (candle["high"] + candle["low"] + candle["close"]) / 3
        cumulative_pv += typical_price * candle["volume"]
        cumulative_volume += candle["volume"]
    if cumulative_volume == 0:
        return candles[-1]["close"] if candles else 0.0
    return round(cumulative_pv / cumulative_volume, 2)


def resample_candles(candles, group_size):
    """Aggregates consecutive candles into larger buckets (e.g. 3x 5m -> 15m)."""
    resampled = []
    for i in range(0, len(candles), group_size):
        chunk = candles[i:i + group_size]
        if not chunk:
            continue
        resampled.append(
            {
                "time": chunk[0]["time"],
                "open": chunk[0]["open"],
                "high": max(c["high"] for c in chunk),
                "low": min(c["low"] for c in chunk),
                "close": chunk[-1]["close"],
                "volume": sum(c["volume"] for c in chunk),
            }
        )
    return resampled


def classify_trend(candles, fast_period=9, slow_period=21):
    """Bullish/bearish/neutral from EMA alignment on a candle series."""
    closes = [c["close"] for c in candles]
    if len(closes) < slow_period:
        return "neutral"
    fast = last_ema(closes, fast_period)
    slow = last_ema(closes, slow_period)
    price = closes[-1]
    if price > fast > slow:
        return "bullish"
    if price < fast < slow:
        return "bearish"
    return "neutral"


def get_real_market_snapshot(market_key):
    """Builds a market dict with the SAME shape as DEMO_MARKETS entries, but
    populated from real Upstox data, so calculate_confirmation_engine can
    consume it unchanged. Raises on failure so the caller can fall back."""
    market = UPSTOX_MARKETS[market_key]
    cached = _live_snapshot_cache.get(market_key)
    if cached and time.time() - cached["fetched_at"] < LIVE_SNAPSHOT_CACHE_SECONDS:
        return cached["data"]

    candles_5m = fetch_upstox_candles(market["instrument_key"], "minutes", 5)
    if len(candles_5m) < 30:
        raise RuntimeError("Not enough live candle history yet for a reliable snapshot.")

    closes = [c["close"] for c in candles_5m]
    price = closes[-1]
    session_open = candles_5m[0]["open"]
    session_high = max(c["high"] for c in candles_5m)
    session_low = min(c["low"] for c in candles_5m)
    # Upstox's intraday endpoint only covers the current session, so the
    # session's own open is used as the reference point for change%.
    previous_close = session_open

    recent_volumes = [c["volume"] for c in candles_5m[-20:]]
    avg_volume = sum(recent_volumes[:-1]) / max(len(recent_volumes) - 1, 1)
    volume_ratio = round(candles_5m[-1]["volume"] / avg_volume, 2) if avg_volume else 1.0

    support = round(min(c["low"] for c in candles_5m[-40:]), 2)
    resistance = round(max(c["high"] for c in candles_5m[-40:]), 2)

    candles_15m = resample_candles(candles_5m, 3)
    candles_1h = resample_candles(candles_5m, 12)

    snapshot = {
        "name": market["name"],
        "price": round(price, 2),
        "open": round(session_open, 2),
        "high": round(session_high, 2),
        "low": round(session_low, 2),
        "previous_close": round(previous_close, 2),
        "volume_ratio": volume_ratio,
        "rsi_14": calculate_rsi(closes),
        "ema_9": round(last_ema(closes, 9), 2),
        "ema_21": round(last_ema(closes, 21), 2),
        "ema_50": round(last_ema(closes, 50), 2) if len(closes) >= 50 else round(last_ema(closes, 21), 2),
        "vwap": calculate_vwap(candles_5m),
        "macd_histogram": calculate_macd_histogram(closes),
        "atr_14": calculate_atr(candles_5m),
        "support": support,
        "resistance": resistance,
        "trend_5m": classify_trend(candles_5m),
        "trend_15m": classify_trend(candles_15m) if len(candles_15m) >= 21 else "neutral",
        "trend_1h": classify_trend(candles_1h) if len(candles_1h) >= 21 else "neutral",
        "data_source": "upstox_live",
    }
    _live_snapshot_cache[market_key] = {"data": snapshot, "fetched_at": time.time()}
    return snapshot


def get_market_snapshot_with_fallback(market_key):
    """Tries real live data first; falls back to demo data (clearly labelled)
    if Upstox isn't configured, the market is closed, or the request fails."""
    try:
        return get_real_market_snapshot(market_key), True
    except Exception as error:
        app.logger.warning("Live snapshot for %s unavailable, using demo data: %s", market_key, error)
        demo = dict(DEMO_MARKETS[market_key])
        demo["data_source"] = "demo_fallback"
        return demo, False


# ===================== Routes =====================

@app.get("/")
def home():
    return jsonify(
        {
            "service": "Indian Market AI Dashboard API",
            "status": "running",
            "uptime_seconds": round(time.time() - APP_STARTED_AT, 1),
            "message": "Research and paper-trading API only. No broker or real-money trading.",
        }
    )


@app.get("/api/health")
def health():
    return jsonify(
        {
            "ok": True,
            "service": "indian-market-api",
            "time_utc": now_utc(),
        }
    )


def status_from_bool(value, bullish_text, bearish_text, neutral_text):
    if value > 0:
        return {
            "state": "bullish",
            "score": 1,
            "reason": bullish_text,
        }

    if value < 0:
        return {
            "state": "bearish",
            "score": -1,
            "reason": bearish_text,
        }

    return {
        "state": "neutral",
        "score": 0,
        "reason": neutral_text,
    }


def calculate_confirmation_engine(market):
    price = market["price"]
    open_price = market["open"]
    previous_close = market["previous_close"]
    rsi = market["rsi_14"]
    ema_9 = market["ema_9"]
    ema_21 = market["ema_21"]
    ema_50 = market["ema_50"]
    vwap = market["vwap"]
    macd_histogram = market["macd_histogram"]
    volume_ratio = market["volume_ratio"]
    atr = market["atr_14"]
    support = market["support"]
    resistance = market["resistance"]

    confirmations = []

    ema_signal = 0
    if price > ema_9 > ema_21 > ema_50:
        ema_signal = 1
    elif price < ema_9 < ema_21 < ema_50:
        ema_signal = -1

    confirmations.append(
        {
            "name": "EMA alignment",
            "weight": 2,
            **status_from_bool(
                ema_signal,
                "Price and EMA 9/21/50 are aligned bullish.",
                "Price and EMA 9/21/50 are aligned bearish.",
                "EMA alignment is mixed.",
            ),
        }
    )

    vwap_signal = 1 if price > vwap else -1 if price < vwap else 0
    confirmations.append(
        {
            "name": "VWAP position",
            "weight": 2,
            **status_from_bool(
                vwap_signal,
                "Price is trading above VWAP.",
                "Price is trading below VWAP.",
                "Price is at VWAP.",
            ),
        }
    )

    rsi_signal = 1 if rsi >= 55 else -1 if rsi <= 45 else 0
    confirmations.append(
        {
            "name": "RSI momentum",
            "weight": 1,
            **status_from_bool(
                rsi_signal,
                f"RSI {rsi:.1f} supports bullish momentum.",
                f"RSI {rsi:.1f} supports bearish momentum.",
                f"RSI {rsi:.1f} is neutral.",
            ),
        }
    )

    macd_signal = 1 if macd_histogram > 0 else -1 if macd_histogram < 0 else 0
    confirmations.append(
        {
            "name": "MACD momentum",
            "weight": 1,
            **status_from_bool(
                macd_signal,
                "MACD histogram is positive.",
                "MACD histogram is negative.",
                "MACD histogram is flat.",
            ),
        }
    )

    volume_signal = 1 if volume_ratio >= 1.05 else 0
    confirmations.append(
        {
            "name": "Volume participation",
            "weight": 1,
            **status_from_bool(
                volume_signal,
                f"Volume is {volume_ratio:.2f}x its reference average.",
                "Volume filter does not support a bearish setup by itself.",
                f"Volume is only {volume_ratio:.2f}x its reference average.",
            ),
        }
    )

    timeframe_values = {
        "bullish": 1,
        "bearish": -1,
        "neutral": 0,
    }

    timeframe_score = (
        timeframe_values[market["trend_5m"]]
        + timeframe_values[market["trend_15m"]]
        + timeframe_values[market["trend_1h"]]
    )

    confirmations.append(
        {
            "name": "Multi-timeframe trend",
            "weight": 2,
            **status_from_bool(
                1 if timeframe_score >= 2 else -1 if timeframe_score <= -2 else 0,
                "5m, 15m, and 1h trend alignment is bullish.",
                "5m, 15m, and 1h trend alignment is bearish.",
                "Timeframes are not fully aligned.",
            ),
        }
    )

    level_signal = 0
    midpoint = (support + resistance) / 2

    if price > midpoint and price < resistance:
        level_signal = 1
    elif price < midpoint and price > support:
        level_signal = -1

    confirmations.append(
        {
            "name": "Support and resistance context",
            "weight": 1,
            **status_from_bool(
                level_signal,
                "Price is in the upper half of its current research range.",
                "Price is in the lower half of its current research range.",
                "Price is at an important range midpoint or boundary.",
            ),
        }
    )

    weighted_score = sum(item["score"] * item["weight"] for item in confirmations)
    max_score = sum(item["weight"] for item in confirmations)
    bullish_count = sum(1 for item in confirmations if item["state"] == "bullish")
    bearish_count = sum(1 for item in confirmations if item["state"] == "bearish")

    change = price - previous_close
    change_percent = (change / previous_close) * 100

    decision = "WAIT"
    decision_reason = "Confirmations are mixed. Wait for a clearer aligned setup."

    if weighted_score >= 7 and bullish_count >= 5 and price < resistance:
        decision = "BUY SETUP"
        decision_reason = "Strong bullish confluence with a defined risk plan."
    elif weighted_score <= -7 and bearish_count >= 5 and price > support:
        decision = "SELL SETUP"
        decision_reason = "Strong bearish confluence with a defined risk plan."
    elif weighted_score >= 4:
        decision = "WAIT FOR BUY CONFIRMATION"
        decision_reason = "Bullish factors exist, but wait for stronger alignment or a clean breakout."
    elif weighted_score <= -4:
        decision = "WAIT FOR SELL CONFIRMATION"
        decision_reason = "Bearish factors exist, but wait for stronger alignment or a clean breakdown."

    risk_buffer = atr * 0.35

    if decision in {"BUY SETUP", "WAIT FOR BUY CONFIRMATION"}:
        entry_zone = {
            "from": round(max(price, vwap), 2),
            "to": round(max(price, vwap) + atr * 0.15, 2),
            "condition": "Use only after a confirmed bullish candle close or a successful retest.",
        }
        stop_loss = round(min(support, vwap) - risk_buffer, 2)
        risk = max(entry_zone["from"] - stop_loss, atr * 0.25)
        target_1 = round(entry_zone["from"] + risk, 2)
        target_2 = round(entry_zone["from"] + risk * 2, 2)
        exit_rule = "Exit if stop-loss is hit, price loses VWAP and EMA 21, or an opposite confirmed signal appears."
    elif decision in {"SELL SETUP", "WAIT FOR SELL CONFIRMATION"}:
        entry_zone = {
            "from": round(min(price, vwap) - atr * 0.15, 2),
            "to": round(min(price, vwap), 2),
            "condition": "Use only after a confirmed bearish candle close or a failed retest.",
        }
        stop_loss = round(max(resistance, vwap) + risk_buffer, 2)
        risk = max(stop_loss - entry_zone["to"], atr * 0.25)
        target_1 = round(entry_zone["to"] - risk, 2)
        target_2 = round(entry_zone["to"] - risk * 2, 2)
        exit_rule = "Exit if stop-loss is hit, price regains VWAP and EMA 21, or an opposite confirmed signal appears."
    else:
        entry_zone = {
            "from": None,
            "to": None,
            "condition": "No entry. Wait until multiple confirmations align.",
        }
        stop_loss = None
        target_1 = None
        target_2 = None
        exit_rule = "No position. Reassess after the next confirmed technical refresh."

    return {
        "market": market["name"],
        "updated_at": now_utc(),
        "data_source": market.get("data_source", "demo_fallback"),
        "price": price,
        "open": open_price,
        "high": market["high"],
        "low": market["low"],
        "previous_close": previous_close,
        "change": round(change, 2),
        "change_percent": round(change_percent, 2),
        "indicators": {
            "rsi_14": rsi,
            "ema_9": ema_9,
            "ema_21": ema_21,
            "ema_50": ema_50,
            "vwap": vwap,
            "macd_histogram": macd_histogram,
            "volume_ratio": volume_ratio,
            "atr_14": atr,
        },
        "levels": {
            "support": support,
            "resistance": resistance,
        },
        "timeframes": {
            "5m": market["trend_5m"],
            "15m": market["trend_15m"],
            "1h": market["trend_1h"],
        },
        "confirmations": confirmations,
        "decision": {
            "label": decision,
            "weighted_score": weighted_score,
            "max_score": max_score,
            "bullish_count": bullish_count,
            "bearish_count": bearish_count,
            "reason": decision_reason,
        },
        "trade_plan": {
            "entry_zone": entry_zone,
            "stop_loss": stop_loss,
            "target_1": target_1,
            "target_2": target_2,
            "exit_rule": exit_rule,
        },
        "disclaimer": "Research and paper-trading only. This is not financial advice and does not place orders.",
    }


@app.get("/api/market/<market_key>")
def market_analysis(market_key):
    market_key = market_key.lower().strip()

    if market_key not in DEMO_MARKETS:
        return jsonify(
            {
                "ok": False,
                "error": "Unknown market. Use: nifty or banknifty.",
            }
        ), 404

    market_data, is_live = get_market_snapshot_with_fallback(market_key)
    analysis = calculate_confirmation_engine(market_data)

    return jsonify(
        {
            "ok": True,
            "data": analysis,
        }
    )


@app.get("/api/markets")
def all_markets_analysis():
    markets = {}
    for market_key in DEMO_MARKETS:
        market_data, _ = get_market_snapshot_with_fallback(market_key)
        markets[market_key] = calculate_confirmation_engine(market_data)

    return jsonify(
        {
            "ok": True,
            "updated_at": now_utc(),
            "markets": markets,
        }
    )


@app.get("/api/live/status")
def live_status():
    return jsonify(
        {
            "ok": True,
            "provider": "upstox",
            "token_configured": bool(UPSTOX_ACCESS_TOKEN),
            "mode": "intraday-candle-polling",
            "markets": list(UPSTOX_MARKETS.keys()),
            "supported_timeframes": list(UPSTOX_TIMEFRAMES.keys()),
            "note": (
                "Read-only market-data endpoint. This service does not place, "
                "modify, or cancel orders."
            ),
            "updated_at": now_utc(),
        }
    )


@app.get("/api/live/candles/<market_key>")
def live_candles(market_key):
    market_key = market_key.lower().strip()
    timeframe = request.args.get("timeframe", "5m").lower().strip()

    if market_key not in UPSTOX_MARKETS:
        return jsonify(
            {
                "ok": False,
                "error": "Unknown market. Use: nifty or banknifty.",
            }
        ), 404

    if timeframe not in UPSTOX_TIMEFRAMES:
        return jsonify(
            {
                "ok": False,
                "error": "Unsupported timeframe. Use: 5m, 15m, 1h, or 1d.",
            }
        ), 400

    if not UPSTOX_ACCESS_TOKEN:
        return jsonify(
            {
                "ok": False,
                "error": "Upstox access token is not configured on the server.",
            }
        ), 503

    market = UPSTOX_MARKETS[market_key]
    unit, interval = UPSTOX_TIMEFRAMES[timeframe]

    try:
        candles = fetch_upstox_candles(market["instrument_key"], unit, interval)

        if not candles:
            return jsonify(
                {
                    "ok": False,
                    "provider": "upstox",
                    "error": "No candle data is available for this instrument and timeframe.",
                }
            ), 502

        latest = candles[-1]

        return jsonify(
            {
                "ok": True,
                "provider": "upstox",
                "mode": "intraday-candle-polling",
                "market": market["name"],
                "market_key": market_key,
                "instrument_key": market["instrument_key"],
                "timeframe": timeframe,
                "updated_at": now_utc(),
                "latest": latest,
                "candles": candles,
                "disclaimer": (
                    "Read-only market data for research and paper trading only. "
                    "No order placement is available."
                ),
            }
        )

    except requests.RequestException:
        app.logger.exception("Upstox candle request failed")

        return jsonify(
            {
                "ok": False,
                "provider": "upstox",
                "error": "Could not reach Upstox candle data right now.",
            }
        ), 502
    except Exception as error:
        app.logger.warning("Upstox candle request failed: %s", error)

        return jsonify(
            {
                "ok": False,
                "provider": "upstox",
                "error": "Upstox candle data is temporarily unavailable.",
            }
        ), 502


@app.post("/api/gemini/review")
def gemini_chart_review():
    payload = request.get_json(silent=True) or {}

    market_key = str(payload.get("market", "")).lower().strip()
    timeframe = str(payload.get("timeframe", "5m")).lower().strip()

    if market_key not in DEMO_MARKETS:
        return jsonify(
            {
                "ok": False,
                "error": "Unknown market. Use: nifty or banknifty.",
            }
        ), 400

    allowed_timeframes = {"5m", "15m", "1h", "1d"}

    if timeframe not in allowed_timeframes:
        return jsonify(
            {
                "ok": False,
                "error": "Unsupported timeframe. Use: 5m, 15m, 1h, or 1d.",
            }
        ), 400

    if not GEMINI_API_KEY:
        return jsonify(
            {
                "ok": False,
                "error": "Gemini is not configured on the server.",
            }
        ), 503

    market_data, is_live = get_market_snapshot_with_fallback(market_key)
    analysis = calculate_confirmation_engine(market_data)

    prompt = f"""
You are a cautious Indian index-market research assistant. This is strictly for educational research
and paper trading only; do not give financial advice, guarantee an outcome, or tell the user to place
a real trade.

Review the following technical-engine snapshot for {analysis["market"]} on the {timeframe} timeframe.
Data source: {"live Upstox market data" if is_live else "demo/reference data (live feed unavailable right now)"}.

Current price: {analysis["price"]}
Open / high / low: {analysis["open"]} / {analysis["high"]} / {analysis["low"]}
Decision: {analysis["decision"]["label"]}
Decision reason: {analysis["decision"]["reason"]}
Weighted score: {analysis["decision"]["weighted_score"]} of {analysis["decision"]["max_score"]}
RSI 14: {analysis["indicators"]["rsi_14"]}
EMA 9 / EMA 21 / EMA 50: {analysis["indicators"]["ema_9"]} / {analysis["indicators"]["ema_21"]} / {analysis["indicators"]["ema_50"]}
VWAP: {analysis["indicators"]["vwap"]}
MACD histogram: {analysis["indicators"]["macd_histogram"]}
Volume ratio: {analysis["indicators"]["volume_ratio"]}
Support / resistance: {analysis["levels"]["support"]} / {analysis["levels"]["resistance"]}
Entry zone: {analysis["trade_plan"]["entry_zone"]["from"]} to {analysis["trade_plan"]["entry_zone"]["to"]}
Entry condition: {analysis["trade_plan"]["entry_zone"]["condition"]}
Stop loss: {analysis["trade_plan"]["stop_loss"]}
Target 1 / Target 2: {analysis["trade_plan"]["target_1"]} / {analysis["trade_plan"]["target_2"]}
Exit rule: {analysis["trade_plan"]["exit_rule"]}

Write a concise Hinglish review with exactly these five headings:
1. Bias
2. Confirmation
3. Levels
4. Invalidation
5. Risk note

Rules:
- Write your own independent analysis in your own words. Do not copy the "Decision reason" text above verbatim — you may agree with it, but explain why in your own phrasing, citing the specific numbers.
- Mention the data source (live vs demo) if relevant.
- Do not invent live news, option-chain data, candle patterns, or unprovided indicators.
- Do not suggest real-money trading or use imperative execution language.
- Keep the reply below 220 words.
"""

    try:
        client = genai.Client(api_key=GEMINI_API_KEY)

        response = client.models.generate_content(
            model=GEMINI_MODEL,
            contents=prompt,
        )

        review_text = (response.text or "").strip()

        if not review_text:
            return jsonify(
                {
                    "ok": False,
                    "error": "Gemini returned an empty review. Please try again.",
                }
            ), 502

        return jsonify(
            {
                "ok": True,
                "market": analysis["market"],
                "timeframe": timeframe,
                "generated_at": now_utc(),
                "valid_for_seconds": 300,
                "review": review_text,
                "disclaimer": "Research and paper-trading only. Not financial advice and not a live-market recommendation.",
            }
        )

    except Exception:
        app.logger.exception("Gemini review request failed")

        return jsonify(
            {
                "ok": False,
                "error": "Gemini review is temporarily unavailable. Please try again later.",
            }
        ), 502


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=False)
