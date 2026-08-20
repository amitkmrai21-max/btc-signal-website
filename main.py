import json
import math
import os
import time

import requests
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from google import genai
from google.genai import types

app = FastAPI(title="BTC Signal Website")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

BINANCE_BASE_URL = "https://data-api.binance.vision"
GEMINI_MODEL = "gemini-3.6-flash"

price_cache = {"data": None, "updated_at": 0}
chart_cache = {"data": {}, "updated_at": 0}
ai_signal_cache = {"data": None, "updated_at": 0}
technical_cache = {"data": None, "updated_at": 0}
rrg_cache = {"data": {}, "updated_at": 0}


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


def average(values):
    return sum(values) / len(values) if values else 0.0


def round_value(value, digits=2):
    return round(float(value), digits)


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
    changes = [values[index] - values[index - 1] for index in range(1, len(values))]
    recent = changes[-period:]
    avg_gain = average([max(change, 0) for change in recent])
    avg_loss = average([max(-change, 0) for change in recent])
    if avg_loss == 0:
        return 100.0
    relative_strength = avg_gain / avg_loss
    return 100 - (100 / (1 + relative_strength))


def standard_deviation(values):
    if not values:
        return 0.0
    mean = average(values)
    return math.sqrt(average([(value - mean) ** 2 for value in values]))


def percentage_change(start_value, end_value):
    if start_value == 0:
        return 0.0
    return ((end_value - start_value) / start_value) * 100


def macd(values, fast=12, slow=26, signal=9):
    if len(values) < slow + signal:
        raise ValueError("Not enough candle data for MACD.")
    fast_series = ema_series(values, fast)
    slow_series = ema_series(values, slow)
    macd_line_series = [
        fast_value - slow_value
        for fast_value, slow_value in zip(fast_series, slow_series)
        if fast_value is not None and slow_value is not None
    ]
    signal_line_series = ema_series(macd_line_series, signal)
    macd_line = macd_line_series[-1]
    signal_line = signal_line_series[-1]
    histogram = macd_line - signal_line
    previous_histogram = macd_line_series[-2] - signal_line_series[-2] if len(macd_line_series) > 1 else histogram
    direction = "Bullish" if macd_line > signal_line else "Bearish"
    strength = "Strengthening" if histogram > previous_histogram else "Weakening"
    return {
        "macd_line": round_value(macd_line, 4),
        "signal_line": round_value(signal_line, 4),
        "histogram": round_value(histogram, 4),
        "state": f"{direction}, {strength}",
    }


def atr(highs, lows, closes, period=14):
    if len(closes) < period + 1:
        raise ValueError("Not enough candle data for ATR.")
    true_ranges = []
    for index in range(1, len(closes)):
        true_ranges.append(max(highs[index] - lows[index], abs(highs[index] - closes[index - 1]), abs(lows[index] - closes[index - 1])))
    return average(true_ranges[-period:])


def adx(highs, lows, closes, period=14):
    if len(closes) < (period * 2) + 1:
        raise ValueError("Not enough candle data for ADX.")
    plus_dm, minus_dm, true_ranges = [], [], []
    for index in range(1, len(closes)):
        up_move = highs[index] - highs[index - 1]
        down_move = lows[index - 1] - lows[index]
        plus_dm.append(up_move if up_move > down_move and up_move > 0 else 0)
        minus_dm.append(down_move if down_move > up_move and down_move > 0 else 0)
        true_ranges.append(max(highs[index] - lows[index], abs(highs[index] - closes[index - 1]), abs(lows[index] - closes[index - 1])))
    dx_values, plus_di_values, minus_di_values = [], [], []
    for index in range(period - 1, len(true_ranges)):
        tr_average = average(true_ranges[index - period + 1:index + 1])
        plus_average = average(plus_dm[index - period + 1:index + 1])
        minus_average = average(minus_dm[index - period + 1:index + 1])
        plus_di = 100 * plus_average / tr_average if tr_average else 0
        minus_di = 100 * minus_average / tr_average if tr_average else 0
        total_di = plus_di + minus_di
        dx = 100 * abs(plus_di - minus_di) / total_di if total_di else 0
        plus_di_values.append(plus_di)
        minus_di_values.append(minus_di)
        dx_values.append(dx)
    adx_value = average(dx_values[-period:])
    return {
        "adx_14": round_value(adx_value),
        "plus_di_14": round_value(plus_di_values[-1]),
        "minus_di_14": round_value(minus_di_values[-1]),
        "trend_strength": "Strong" if adx_value >= 25 else "Moderate" if adx_value >= 20 else "Weak / ranging",
    }


def bollinger_bands(values, period=20, multiplier=2):
    if len(values) < period:
        raise ValueError("Not enough candle data for Bollinger Bands.")
    window = values[-period:]
    middle = average(window)
    deviation = standard_deviation(window)
    upper = middle + multiplier * deviation
    lower = middle - multiplier * deviation
    width_percent = ((upper - lower) / middle) * 100 if middle else 0
    position_percent = ((values[-1] - lower) / (upper - lower)) * 100 if upper != lower else 50
    return {
        "upper": round_value(upper),
        "middle": round_value(middle),
        "lower": round_value(lower),
        "width_percent": round_value(width_percent),
        "price_position_percent": round_value(position_percent),
    }


def obv(closes, volumes):
    value = 0.0
    values = [value]
    for index in range(1, len(closes)):
        if closes[index] > closes[index - 1]:
            value += volumes[index]
        elif closes[index] < closes[index - 1]:
            value -= volumes[index]
        values.append(value)
    direction = "Rising" if values[-1] > values[-6] else "Falling" if values[-1] < values[-6] else "Flat"
    return {"value": round_value(values[-1], 2), "direction_5_candles": direction}


def mfi(highs, lows, closes, volumes, period=14):
    if len(closes) < period + 1:
        raise ValueError("Not enough candle data for MFI.")
    typical_prices = [(high + low + close) / 3 for high, low, close in zip(highs, lows, closes)]
    positive_flow, negative_flow = [], []
    for index in range(1, len(typical_prices)):
        raw_flow = typical_prices[index] * volumes[index]
        if typical_prices[index] > typical_prices[index - 1]:
            positive_flow.append(raw_flow)
            negative_flow.append(0)
        elif typical_prices[index] < typical_prices[index - 1]:
            positive_flow.append(0)
            negative_flow.append(raw_flow)
        else:
            positive_flow.append(0)
            negative_flow.append(0)
    positive_sum = sum(positive_flow[-period:])
    negative_sum = sum(negative_flow[-period:])
    if negative_sum == 0:
        return 100.0
    money_ratio = positive_sum / negative_sum
    return 100 - (100 / (1 + money_ratio))


def candle_pattern(candles):
    current = candles[-1]
    previous = candles[-2]
    open_price, high_price, low_price, close_price = float(current[1]), float(current[2]), float(current[3]), float(current[4])
    previous_open, previous_high, previous_low, previous_close = float(previous[1]), float(previous[2]), float(previous[3]), float(previous[4])
    body = abs(close_price - open_price)
    full_range = max(high_price - low_price, 0.00000001)
    upper_wick = high_price - max(open_price, close_price)
    lower_wick = min(open_price, close_price) - low_price
    if high_price < previous_high and low_price > previous_low:
        return "Inside bar / consolidation"
    if close_price > open_price and previous_close < previous_open and close_price >= previous_open and open_price <= previous_close:
        return "Bullish engulfing"
    if close_price < open_price and previous_close > previous_open and close_price <= previous_open and open_price >= previous_close:
        return "Bearish engulfing"
    if body / full_range < 0.12:
        return "Doji / indecision"
    if lower_wick > body * 2 and upper_wick < body:
        return "Hammer-like bullish rejection"
    if upper_wick > body * 2 and lower_wick < body:
        return "Shooting-star-like bearish rejection"
    return "Bullish candle" if close_price > open_price else "Bearish candle"


def market_structure(closes, highs, lows, ema_20_value, ema_50_value):
    recent_high, recent_low = max(highs[-20:]), min(lows[-20:])
    prior_high, prior_low = max(highs[-40:-20]), min(lows[-40:-20])
    last_close = closes[-1]
    if recent_high > prior_high and recent_low > prior_low and last_close > ema_20_value > ema_50_value:
        return "Bullish: Higher highs and higher lows"
    if recent_high < prior_high and recent_low < prior_low and last_close < ema_20_value < ema_50_value:
        return "Bearish: Lower highs and lower lows"
    return "Range / mixed structure"


def pivot_levels(highs, lows, closes):
    prior_high, prior_low, prior_close = max(highs[-25:-1]), min(lows[-25:-1]), closes[-2]
    pivot = (prior_high + prior_low + prior_close) / 3
    return {
        "pivot": round_value(pivot),
        "support_1": round_value((2 * pivot) - prior_high),
        "support_2": round_value(pivot - (prior_high - prior_low)),
        "resistance_1": round_value((2 * pivot) - prior_low),
        "resistance_2": round_value(pivot + (prior_high - prior_low)),
    }


def fibonacci_levels(highs, lows):
    swing_high, swing_low = max(highs[-50:]), min(lows[-50:])
    price_range = swing_high - swing_low
    return {
        "swing_high": round_value(swing_high),
        "swing_low": round_value(swing_low),
        "level_23_6": round_value(swing_high - price_range * 0.236),
        "level_38_2": round_value(swing_high - price_range * 0.382),
        "level_50_0": round_value(swing_high - price_range * 0.5),
        "level_61_8": round_value(swing_high - price_range * 0.618),
        "level_78_6": round_value(swing_high - price_range * 0.786),
    }


def calculate_market_indicators(candles, interval):
    if len(candles) < 200:
        raise ValueError("Need 200 candles for full market analysis.")
    highs = [float(candle[2]) for candle in candles]
    lows = [float(candle[3]) for candle in candles]
    closes = [float(candle[4]) for candle in candles]
    volumes = [float(candle[5]) for candle in candles]
    quote_volumes = [float(candle[7]) for candle in candles]
    trade_counts = [int(candle[8]) for candle in candles]
    taker_buy_volumes = [float(candle[9]) for candle in candles]
    last_close = closes[-1]
    ema_20_value, ema_50_value, ema_200_value = ema(closes, 20), ema(closes, 50), ema(closes, 200)
    sma_20_value, sma_50_value = sma(closes, 20), sma(closes, 50)
    atr_value = atr(highs, lows, closes)
    average_volume_20 = average(volumes[-20:-1])
    current_volume = volumes[-1]
    volume_ratio = current_volume / average_volume_20 if average_volume_20 else 0
    total_volume_20 = sum(volumes[-20:])
    taker_buy_total_20 = sum(taker_buy_volumes[-20:])
    taker_buy_ratio = (taker_buy_total_20 / total_volume_20) * 100 if total_volume_20 else 50
    support, resistance = min(lows[-20:]), max(highs[-20:])
    prior_resistance, prior_support = max(highs[-21:-1]), min(lows[-21:-1])
    breakout = "Bullish breakout" if last_close > prior_resistance and volume_ratio >= 1.2 else "Bearish breakdown" if last_close < prior_support and volume_ratio >= 1.2 else "No confirmed breakout"
    trend = "Strong bullish" if last_close > ema_20_value > ema_50_value > ema_200_value else "Bullish" if last_close > ema_20_value > ema_50_value else "Strong bearish" if last_close < ema_20_value < ema_50_value < ema_200_value else "Bearish" if last_close < ema_20_value < ema_50_value else "Mixed"
    momentum_percent = percentage_change(closes[-13], last_close)
    return {
        "timeframe": interval,
        "price": round_value(last_close),
        "trend": trend,
        "ema": {"ema_20": round_value(ema_20_value), "ema_50": round_value(ema_50_value), "ema_200": round_value(ema_200_value)},
        "sma": {"sma_20": round_value(sma_20_value), "sma_50": round_value(sma_50_value)},
        "rsi_14": round_value(rsi(closes, 14)),
        "macd": macd(closes),
        "adx": adx(highs, lows, closes),
        "atr_14": round_value(atr_value),
        "atr_percent": round_value((atr_value / last_close) * 100),
        "bollinger_bands": bollinger_bands(closes),
        "volume": {"current": round_value(current_volume, 4), "average_20": round_value(average_volume_20, 4), "volume_ratio": round_value(volume_ratio), "quote_volume_current": round_value(quote_volumes[-1], 2), "trade_count_current": trade_counts[-1], "taker_buy_ratio_20_percent": round_value(taker_buy_ratio)},
        "obv": obv(closes, volumes),
        "mfi_14": round_value(mfi(highs, lows, closes, volumes)),
        "momentum_percent": round_value(momentum_percent),
        "support_resistance": {"support_20": round_value(support), "resistance_20": round_value(resistance)},
        "pivots": pivot_levels(highs, lows, closes),
        "fibonacci": fibonacci_levels(highs, lows),
        "candle_pattern": candle_pattern(candles),
        "market_structure": market_structure(closes, highs, lows, ema_20_value, ema_50_value),
        "breakout_status": breakout,
    }


def timeframe_signal_from_indicators(indicators):
    trend = str(indicators.get("trend", "")).lower()
    macd_state = str(indicators.get("macd", {}).get("state", "")).lower()
    rsi_value = float(indicators.get("rsi_14", 50))
    momentum = float(indicators.get("momentum_percent", 0))
    if "bull" in trend and "bull" in macd_state and rsi_value >= 50 and momentum >= 0:
        return "BUY"
    if "bear" in trend and "bear" in macd_state and rsi_value <= 50 and momentum <= 0:
        return "SELL"
    return "HOLD"


def technical_main_signal(market_data):
    timeframes = market_data["timeframes"]
    analysis_15m, analysis_1h, analysis_4h = timeframes["15m"], timeframes["1h"], timeframes["4h"]
    signal_15m = timeframe_signal_from_indicators(analysis_15m)
    signal_1h = timeframe_signal_from_indicators(analysis_1h)
    signal_4h = timeframe_signal_from_indicators(analysis_4h)
    buy_count = [signal_15m, signal_1h, signal_4h].count("BUY")
    sell_count = [signal_15m, signal_1h, signal_4h].count("SELL")
    if buy_count >= 2 and signal_4h != "SELL":
        signal, risk = "BUY WATCH", "MEDIUM"
        reason = "Technical fallback: higher-timeframe trend and momentum are mostly bullish. Wait for entry confirmation near the listed key levels."
        setup_status, market_bias = "Technical bullish setup — confirmation required", "Bullish technical bias"
    elif sell_count >= 2 and signal_4h != "BUY":
        signal, risk = "SELL WATCH", "MEDIUM"
        reason = "Technical fallback: higher-timeframe trend and momentum are mostly bearish. Wait for entry confirmation near the listed key levels."
        setup_status, market_bias = "Technical bearish setup — confirmation required", "Bearish technical bias"
    else:
        signal, risk = "NO TRADE", "HIGH"
        reason = "Technical fallback: 15m, 1h and 4h signals are mixed or lack enough alignment. Wait for clearer confirmation."
        setup_status, market_bias = "Mixed technical setup — wait", "Neutral / mixed technical bias"
    resistance = analysis_15m["support_resistance"]["resistance_20"]
    support = analysis_15m["support_resistance"]["support_20"]
    atr_value = analysis_15m["atr_14"]
    if signal == "BUY WATCH":
        confirmation = f"15m candle close above ${resistance:,.2f} with volume confirmation"
        entry_idea = f"Educational idea: wait for bullish confirmation above ${resistance:,.2f}."
        stop_loss = f"Educational invalidation: below ${support:,.2f} or the recent 15m support."
        target_1, target_2 = f"${resistance + atr_value:,.2f}", f"${resistance + (atr_value * 2):,.2f}"
    elif signal == "SELL WATCH":
        confirmation = f"15m candle close below ${support:,.2f} with volume confirmation"
        entry_idea = f"Educational idea: wait for bearish confirmation below ${support:,.2f}."
        stop_loss = f"Educational invalidation: above ${resistance:,.2f} or the recent 15m resistance."
        target_1, target_2 = f"${support - atr_value:,.2f}", f"${support - (atr_value * 2):,.2f}"
    else:
        confirmation = "Wait for 15m, 1h and 4h trend/momentum alignment."
        entry_idea = "No educational entry idea while technical signals are mixed."
        stop_loss, target_1, target_2 = "No trade is preferred until a clearer setup appears.", "--", "--"
    return {
        "signal": signal,
        "confidence": None,
        "reason": reason,
        "risk": risk,
        "market_bias": market_bias,
        "setup_status": setup_status,
        "confirmation_needed": confirmation,
        "entry_idea": entry_idea,
        "stop_loss_idea": stop_loss,
        "target_1": target_1,
        "target_2": target_2,
        "timeframes": {
            "15m": {"signal": signal_15m, "summary": f"{analysis_15m['trend']} trend; RSI {analysis_15m['rsi_14']}; {analysis_15m['macd']['state']}.", "key_level": f"${analysis_15m['support_resistance']['support_20']:,.2f} / ${analysis_15m['support_resistance']['resistance_20']:,.2f}"},
            "1h": {"signal": signal_1h, "summary": f"{analysis_1h['trend']} trend; RSI {analysis_1h['rsi_14']}; {analysis_1h['macd']['state']}.", "key_level": f"${analysis_1h['support_resistance']['support_20']:,.2f} / ${analysis_1h['support_resistance']['resistance_20']:,.2f}"},
            "4h": {"signal": signal_4h, "summary": f"{analysis_4h['trend']} trend; RSI {analysis_4h['rsi_14']}; {analysis_4h['macd']['state']}.", "key_level": f"${analysis_4h['support_resistance']['support_20']:,.2f} / ${analysis_4h['support_resistance']['resistance_20']:,.2f}"},
        },
    }


def build_market_data():
    ticker = get_btc_ticker()
    analysis_15m = calculate_market_indicators(get_btc_klines(interval="15m", limit=250), "15m")
    analysis_1h = calculate_market_indicators(get_btc_klines(interval="1h", limit=250), "1h")
    analysis_4h = calculate_market_indicators(get_btc_klines(interval="4h", limit=250), "4h")
    return {
        "symbol": "BTCUSDT",
        "current_price_usdt": round_value(ticker["lastPrice"]),
        "price_change_24h_percent": round_value(ticker["priceChangePercent"]),
        "high_24h_usdt": round_value(ticker["highPrice"]),
        "low_24h_usdt": round_value(ticker["lowPrice"]),
        "quote_volume_24h_usdt": round_value(ticker["quoteVolume"]),
        "timeframes": {"15m": analysis_15m, "1h": analysis_1h, "4h": analysis_4h},
    }


def get_technical_market_data(force_refresh=False):
    now = time.time()
    cache_age = now - technical_cache["updated_at"]
    if not force_refresh and technical_cache["data"] and cache_age < 30:
        return technical_cache["data"], True
    try:
        market_data = build_market_data()
        technical_cache["data"] = market_data
        technical_cache["updated_at"] = now
        return market_data, False
    except (requests.exceptions.RequestException, ValueError) as error:
        if technical_cache["data"]:
            return technical_cache["data"], True
        raise HTTPException(status_code=502, detail="Live technical market data is temporarily unavailable.") from error


def build_technical_response(market_data, cached=False):
    result = technical_main_signal(market_data)
    result["market_data"] = market_data
    result["source"] = "Binance live technical analysis"
    result["analysis_mode"] = "technical_fallback"
    result["cached"] = cached
    result["updated_at"] = int(time.time())
    result["disclaimer"] = "Educational market analysis only. Not financial advice or an automated trading instruction."
    return result


def build_ai_prompt(market_data):
    return f"""
You are an advanced but cautious BTCUSDT market-analysis assistant for an educational dashboard. Analyze only the supplied live Binance market data.

DATA:
{json.dumps(market_data, indent=2)}

Return only the requested JSON object in simple Hindi-English (Hinglish).

SIGNAL DEFINITIONS:
- STRONG BUY: 4h and 1h trend are bullish, 15m supports an entry, momentum/volume confirms, and risk is acceptable.
- BUY WATCH: Higher timeframe bias is bullish but an entry confirmation, pullback completion, breakout, or volume confirmation is still needed.
- STRONG SELL: 4h and 1h trend are bearish, 15m supports an entry, momentum/volume confirms, and risk is acceptable.
- SELL WATCH: Higher timeframe bias is bearish but an entry confirmation, rebound rejection, breakdown, or volume confirmation is still needed.
- NO TRADE: Market is choppy/ranging, timeframes are strongly mixed, key levels are too close, risk is high, or data is unclear.

DECISION RULES:
1. Use 4h for broad bias, 1h for setup quality, and 15m for entry timing.
2. Use EMA trend, RSI, MACD, ADX, volume ratio, taker-buy ratio, market structure, candle pattern, breakout status, support, resistance, pivots, Fibonacci levels, and ATR where relevant.
3. Never promise profit, certainty, or guaranteed targets.
4. Entry zone, invalidation/stop loss, and targets are educational ideas only; never automatic orders.
5. Explain primary evidence and what confirmation is still needed for WATCH signals.
6. Strong signals should normally have higher confidence than WATCH; use NO TRADE whenever setup is weak or unclear.
"""


def get_ai_response_schema():
    timeframe_schema = {
        "type": "object",
        "properties": {
            "signal": {"type": "string", "enum": ["BULLISH", "BEARISH", "NEUTRAL"]},
            "summary": {"type": "string"},
            "key_level": {"type": "string"},
        },
        "required": ["signal", "summary", "key_level"],
    }
    return {
        "type": "object",
        "properties": {
            "signal": {"type": "string", "enum": ["STRONG BUY", "BUY WATCH", "NO TRADE", "SELL WATCH", "STRONG SELL"]},
            "confidence": {"type": "integer", "minimum": 0, "maximum": 100},
            "risk": {"type": "string", "enum": ["LOW", "MEDIUM", "HIGH"]},
            "market_bias": {"type": "string"},
            "setup_status": {"type": "string"},
            "reason": {"type": "string"},
            "confirmation_needed": {"type": "string"},
            "entry_idea": {"type": "string"},
            "stop_loss_idea": {"type": "string"},
            "target_1": {"type": "string"},
            "target_2": {"type": "string"},
            "timeframes": {"type": "object", "properties": {"15m": timeframe_schema, "1h": timeframe_schema, "4h": timeframe_schema}, "required": ["15m", "1h", "4h"]},
        },
        "required": ["signal", "confidence", "risk", "market_bias", "setup_status", "reason", "confirmation_needed", "entry_idea", "stop_loss_idea", "target_1", "target_2", "timeframes"],
    }


def build_rrg_data(interval):
    settings = {"1h": {"limit": 220, "lookback": 60, "tail": 4}, "1d": {"limit": 220, "lookback": 30, "tail": 4}}
    if interval not in settings:
        raise ValueError("Unsupported RRG interval.")
    config = settings[interval]
    benchmark_symbol = "ETHUSDT"
    plotted_symbols = ["BTCUSDT", "ETHUSDT", "SOLUSDT"]
    candle_sets = {symbol: get_klines(symbol, interval, config["limit"]) for symbol in plotted_symbols}
    close_sets = {symbol: [float(candle[4]) for candle in candle_sets[symbol]] for symbol in plotted_symbols}
    timestamps = [int(candle[0]) for candle in candle_sets[benchmark_symbol]]
    benchmark = close_sets[benchmark_symbol]
    lookback, tail, trails = config["lookback"], config["tail"], []
    for symbol in plotted_symbols:
        if symbol == benchmark_symbol:
            points = [{"x": 100.0, "y": 100.0, "timestamp": timestamps[index]} for index in range(max(0, len(timestamps) - tail), len(timestamps))]
            trails.append({"symbol": benchmark_symbol, "points": points, "direction": "Flat"})
            continue
        closes = close_sets[symbol]
        ratios = [(asset_close / benchmark_close) * 100 for asset_close, benchmark_close in zip(closes, benchmark)]
        ratio_sma = [average(ratios[index - lookback + 1:index + 1]) if index >= lookback - 1 else None for index in range(len(ratios))]
        ratio_index = [(ratios[index] / ratio_sma[index]) * 100 if ratio_sma[index] else None for index in range(len(ratios))]
        momentum_sma = [average([value for value in ratio_index[index - 9:index + 1] if value is not None]) if index >= lookback + 8 and ratio_index[index] is not None else None for index in range(len(ratio_index))]
        momentum_index = [(ratio_index[index] / momentum_sma[index]) * 100 if momentum_sma[index] else None for index in range(len(ratio_index))]
        valid_points = [{"x": round_value(ratio_index[index], 2), "y": round_value(momentum_index[index], 2), "timestamp": timestamps[index]} for index in range(len(ratio_index)) if ratio_index[index] is not None and momentum_index[index] is not None]
        latest_direction = "Flat"
        if len(valid_points) >= 2:
            delta_x = valid_points[-1]["x"] - valid_points[-2]["x"]
            delta_y = valid_points[-1]["y"] - valid_points[-2]["y"]
            if abs(delta_x) < 0.03 and abs(delta_y) < 0.03:
                latest_direction = "Flat"
            elif delta_x >= 0 and delta_y >= 0:
                latest_direction = "North-East"
            elif delta_x >= 0 and delta_y < 0:
                latest_direction = "South-East"
            elif delta_x < 0 and delta_y >= 0:
                latest_direction = "North-West"
            else:
                latest_direction = "South-West"
        trails.append({"symbol": symbol, "points": valid_points[-tail:], "direction": latest_direction})
    return {
        "benchmark": benchmark_symbol,
        "interval": interval,
        "tail_points": tail,
        "trails": trails,
        "source": "Binance market data",
        "updated_at": int(time.time()),
        "disclaimer": "BTC and SOL are compared with ETH as the benchmark in this RRG-style normalized relative-strength visualization. It is not official JdK RRG and is not financial advice.",
    }


@app.get("/api/health")
def health():
    return {"status": "ok", "message": "BTC Signal Website backend running", "market_data_source": "Binance", "gemini_configured": bool(os.getenv("GEMINI_API_KEY"))}


@app.get("/api/btc/price")
def btc_price(force_refresh: bool = False):
    now = time.time()
    cache_age = now - price_cache["updated_at"]
    if not force_refresh and price_cache["data"] and cache_age < 15:
        return {**price_cache["data"], "cached": True, "cache_age_seconds": round(cache_age, 1)}
    try:
        ticker = get_btc_ticker()
        current_price = float(ticker["lastPrice"])
        previous_daily_close, daily_change_percent = get_btc_daily_change(current_price)
        result = {
            "bitcoin": {"usd": current_price, "usd_24h_change": daily_change_percent, "price_change_24h_usd": float(ticker["priceChange"]), "open_price_24h_usd": float(ticker["openPrice"]), "previous_daily_close": previous_daily_close},
            "source": "Binance",
            "daily_change_basis": "Previous completed UTC daily candle close",
            "cached": False,
            "updated_at": int(now),
        }
        price_cache["data"], price_cache["updated_at"] = result, now
        return result
    except (requests.exceptions.RequestException, ValueError) as error:
        if price_cache["data"]:
            return {**price_cache["data"], "cached": True, "warning": "Live market feed is temporarily unavailable. Showing last saved price."}
        raise HTTPException(status_code=502, detail=f"Failed to fetch BTC price from Binance: {str(error)}")


@app.get("/api/btc/chart")
def btc_chart(days: int = 7, interval: str = "1h"):
    now = time.time()
    allowed_intervals = {"15m", "1h", "1d", "1w"}
    if interval not in allowed_intervals:
        raise HTTPException(status_code=400, detail="Unsupported chart interval.")
    safe_days = max(1, min(days, 3650))
    cache_key = f"{interval}:{safe_days}"
    candles_needed = {"15m": min(max(safe_days * 96, 48), 1000), "1h": min(max(safe_days * 24, 24), 1000), "1d": min(max(safe_days, 7), 1000), "1w": min(max(math.ceil(safe_days / 7), 8), 1000)}[interval]
    cached_chart = chart_cache["data"].get(cache_key)
    if cached_chart and now - cached_chart["updated_at"] < 60:
        return {**cached_chart, "cached": True}
    try:
        candles = get_btc_klines(interval=interval, limit=candles_needed)
        result = {"prices": [[int(candle[0]), float(candle[4])] for candle in candles], "interval": interval, "days": safe_days, "source": "Binance", "cached": False, "updated_at": int(now)}
        chart_cache["data"][cache_key], chart_cache["updated_at"] = result, now
        return result
    except requests.exceptions.RequestException as error:
        if cached_chart:
            return {**cached_chart, "cached": True, "warning": "Live chart feed is temporarily unavailable. Showing last saved chart."}
        raise HTTPException(status_code=502, detail=f"Failed to fetch BTC chart from Binance: {str(error)}")


@app.get("/api/technical-signal")
def technical_signal(force_refresh: bool = False):
    market_data, cached = get_technical_market_data(force_refresh)
    return build_technical_response(market_data, cached)


@app.get("/api/rrg")
def rrg(interval: str = "1d"):
    now = time.time()
    if interval not in {"1h", "1d"}:
        raise HTTPException(status_code=400, detail="RRG interval must be 1h or 1d.")
    cached_data = rrg_cache["data"].get(interval)
    cache_ttl = 300 if interval == "1h" else 900
    if cached_data and now - cached_data["updated_at"] < cache_ttl:
        return {**cached_data, "cached": True}
    try:
        result = build_rrg_data(interval)
        rrg_cache["data"][interval], rrg_cache["updated_at"] = result, now
        return result
    except requests.exceptions.RequestException as error:
        if cached_data:
            return {**cached_data, "cached": True, "warning": "RRG feed unavailable. Showing cached data."}
        raise HTTPException(status_code=502, detail=f"Failed to build RRG data: {str(error)}")


@app.get("/api/ai-signal")
def ai_signal():
    now = time.time()
    if ai_signal_cache["data"] and now - ai_signal_cache["updated_at"] < 90:
        return {**ai_signal_cache["data"], "cached": True}
    market_data, market_data_cached = get_technical_market_data()
    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        raise HTTPException(status_code=503, detail="Gemini AI is not configured. Live technical fallback is active.")
    try:
        client = genai.Client(api_key=api_key)
        response = client.models.generate_content(
            model=GEMINI_MODEL,
            contents=build_ai_prompt(market_data),
            config=types.GenerateContentConfig(response_mime_type="application/json", response_json_schema=get_ai_response_schema()),
        )
        result = json.loads(response.text)
        result["market_data"] = market_data
        result["source"] = "Binance market data + Gemini advanced analysis"
        result["analysis_mode"] = "ai"
        result["cached"] = False
        result["market_data_cached"] = market_data_cached
        result["updated_at"] = int(now)
        result["disclaimer"] = "Educational market analysis only. Not financial advice or an automated trading instruction."
        ai_signal_cache["data"], ai_signal_cache["updated_at"] = result, now
        return result
    except Exception:
        raise HTTPException(status_code=503, detail="Gemini AI quota or service is temporarily unavailable. Live technical fallback is active.")


@app.post("/api/chart-analyser")
async def chart_analyser(file: UploadFile = File(...)):
    allowed_types = {"image/png", "image/jpeg", "image/webp"}
    max_file_size = 8 * 1024 * 1024
    if file.content_type not in allowed_types:
        raise HTTPException(status_code=400, detail="Upload a PNG, JPG, or WEBP chart image only.")
    image_bytes = await file.read()
    if not image_bytes:
        raise HTTPException(status_code=400, detail="The uploaded chart image is empty.")
    if len(image_bytes) > max_file_size:
        raise HTTPException(status_code=413, detail="Chart image is too large. Maximum size is 8 MB.")
    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        raise HTTPException(status_code=503, detail="Gemini API key is not configured on the server.")
    prompt = """
You are a cautious technical-analysis assistant for an educational BTC/crypto chart screenshot analyser.
Analyze only visible information in the uploaded chart image. Do not invent exact prices, indicators, symbols, timeframes, or levels that cannot be read clearly from the image.
Return only a JSON object in simple Hinglish.
Rules:
1. Output BUY only if a clear bullish setup and visible confirmation are present.
2. Output SELL only if a clear bearish setup and visible confirmation are present.
3. Output HOLD if the chart is unclear, cropped, has insufficient context, is sideways, or confirmation is missing.
4. Never promise profit, certainty, or guaranteed targets.
5. This is educational analysis only, never an automated trade order.
6. Clearly say "Not visible" when required chart information is absent.
"""
    response_schema = {
        "type": "object",
        "properties": {
            "signal": {"type": "string", "enum": ["BUY", "SELL", "HOLD"]},
            "confidence": {"type": "integer", "minimum": 0, "maximum": 100},
            "risk": {"type": "string", "enum": ["LOW", "MEDIUM", "HIGH"]},
            "trend": {"type": "string"}, "pattern": {"type": "string"}, "support": {"type": "string"}, "resistance": {"type": "string"}, "reason": {"type": "string"}, "entry_idea": {"type": "string"}, "invalidation_idea": {"type": "string"}, "warning": {"type": "string"},
        },
        "required": ["signal", "confidence", "risk", "trend", "pattern", "support", "resistance", "reason", "entry_idea", "invalidation_idea", "warning"],
    }
    try:
        client = genai.Client(api_key=api_key)
        response = client.models.generate_content(
            model=GEMINI_MODEL,
            contents=[prompt, types.Part.from_bytes(data=image_bytes, mime_type=file.content_type)],
            config=types.GenerateContentConfig(response_mime_type="application/json", response_json_schema=response_schema),
        )
        result = json.loads(response.text)
        result["source"] = "Uploaded chart screenshot + Gemini AI analysis"
        result["disclaimer"] = "Educational chart analysis only. Not financial advice or an automated trading instruction."
        return result
    except Exception:
        raise HTTPException(status_code=503, detail="Chart Gemini AI is temporarily unavailable. Please try again later.")


app.mount("/frontend", StaticFiles(directory="frontend"), name="frontend")


@app.get("/")
def home():
    return FileResponse("frontend/index.html")

