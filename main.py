import json
import math
import os
import time

import requests
from fastapi import FastAPI, HTTPException
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
chart_cache = {"data": None, "updated_at": 0}
ai_signal_cache = {"data": None, "updated_at": 0}


def get_btc_ticker():
    response = requests.get(
        f"{BINANCE_BASE_URL}/api/v3/ticker/24hr",
        params={"symbol": "BTCUSDT"},
        timeout=15,
    )
    response.raise_for_status()
    return response.json()


def get_btc_klines(interval="1h", limit=250):
    response = requests.get(
        f"{BINANCE_BASE_URL}/api/v3/klines",
        params={
            "symbol": "BTCUSDT",
            "interval": interval,
            "limit": limit,
        },
        timeout=15,
    )
    response.raise_for_status()
    return response.json()


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

    changes = [
        values[index] - values[index - 1]
        for index in range(1, len(values))
    ]
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
    previous_histogram = (
        macd_line_series[-2] - signal_line_series[-2]
        if len(macd_line_series) > 1
        else histogram
    )

    direction = "Bullish" if macd_line > signal_line else "Bearish"
    strength = (
        "Strengthening"
        if histogram > previous_histogram
        else "Weakening"
    )

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
        true_ranges.append(
            max(
                highs[index] - lows[index],
                abs(highs[index] - closes[index - 1]),
                abs(lows[index] - closes[index - 1]),
            )
        )

    return average(true_ranges[-period:])


def adx(highs, lows, closes, period=14):
    if len(closes) < (period * 2) + 1:
        raise ValueError("Not enough candle data for ADX.")

    plus_dm = []
    minus_dm = []
    true_ranges = []

    for index in range(1, len(closes)):
        up_move = highs[index] - highs[index - 1]
        down_move = lows[index - 1] - lows[index]

        plus_dm.append(up_move if up_move > down_move and up_move > 0 else 0)
        minus_dm.append(
            down_move if down_move > up_move and down_move > 0 else 0
        )
        true_ranges.append(
            max(
                highs[index] - lows[index],
                abs(highs[index] - closes[index - 1]),
                abs(lows[index] - closes[index - 1]),
            )
        )

    dx_values = []
    plus_di_values = []
    minus_di_values = []

    for index in range(period - 1, len(true_ranges)):
        tr_average = average(true_ranges[index - period + 1:index + 1])
        plus_average = average(plus_dm[index - period + 1:index + 1])
        minus_average = average(minus_dm[index - period + 1:index + 1])

        plus_di = 100 * plus_average / tr_average if tr_average else 0
        minus_di = 100 * minus_average / tr_average if tr_average else 0
        total_di = plus_di + minus_di

        dx = (
            100 * abs(plus_di - minus_di) / total_di
            if total_di
            else 0
        )

        plus_di_values.append(plus_di)
        minus_di_values.append(minus_di)
        dx_values.append(dx)

    adx_value = average(dx_values[-period:])

    return {
        "adx_14": round_value(adx_value),
        "plus_di_14": round_value(plus_di_values[-1]),
        "minus_di_14": round_value(minus_di_values[-1]),
        "trend_strength": (
            "Strong"
            if adx_value >= 25
            else "Moderate"
            if adx_value >= 20
            else "Weak / ranging"
        ),
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

    position_percent = (
        ((values[-1] - lower) / (upper - lower)) * 100
        if upper != lower
        else 50
    )

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

    direction = (
        "Rising"
        if values[-1] > values[-6]
        else "Falling"
        if values[-1] < values[-6]
        else "Flat"
    )

    return {
        "value": round_value(values[-1], 2),
        "direction_5_candles": direction,
    }


def mfi(highs, lows, closes, volumes, period=14):
    if len(closes) < period + 1:
        raise ValueError("Not enough candle data for MFI.")

    typical_prices = [
        (high + low + close) / 3
        for high, low, close in zip(highs, lows, closes)
    ]

    positive_flow = []
    negative_flow = []

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

    open_price = float(current[1])
    high_price = float(current[2])
    low_price = float(current[3])
    close_price = float(current[4])

    previous_open = float(previous[1])
    previous_high = float(previous[2])
    previous_low = float(previous[3])
    previous_close = float(previous[4])

    body = abs(close_price - open_price)
    full_range = max(high_price - low_price, 0.00000001)
    upper_wick = high_price - max(open_price, close_price)
    lower_wick = min(open_price, close_price) - low_price

    if high_price < previous_high and low_price > previous_low:
        return "Inside bar / consolidation"

    if (
        close_price > open_price
        and previous_close < previous_open
        and close_price >= previous_open
        and open_price <= previous_close
    ):
        return "Bullish engulfing"

    if (
        close_price < open_price
        and previous_close > previous_open
        and close_price <= previous_open
        and open_price >= previous_close
    ):
        return "Bearish engulfing"

    if body / full_range < 0.12:
        return "Doji / indecision"

    if lower_wick > body * 2 and upper_wick < body:
        return "Hammer-like bullish rejection"

    if upper_wick > body * 2 and lower_wick < body:
        return "Shooting-star-like bearish rejection"

    return "Bullish candle" if close_price > open_price else "Bearish candle"


def market_structure(closes, highs, lows, ema_20_value, ema_50_value):
    recent_high = max(highs[-20:])
    recent_low = min(lows[-20:])
    prior_high = max(highs[-40:-20])
    prior_low = min(lows[-40:-20])
    last_close = closes[-1]

    if (
        recent_high > prior_high
        and recent_low > prior_low
        and last_close > ema_20_value > ema_50_value
    ):
        return "Bullish: Higher highs and higher lows"

    if (
        recent_high < prior_high
        and recent_low < prior_low
        and last_close < ema_20_value < ema_50_value
    ):
        return "Bearish: Lower highs and lower lows"

    return "Range / mixed structure"


def pivot_levels(highs, lows, closes):
    prior_high = max(highs[-25:-1])
    prior_low = min(lows[-25:-1])
    prior_close = closes[-2]

    pivot = (prior_high + prior_low + prior_close) / 3
    resistance_1 = (2 * pivot) - prior_low
    support_1 = (2 * pivot) - prior_high
    resistance_2 = pivot + (prior_high - prior_low)
    support_2 = pivot - (prior_high - prior_low)

    return {
        "pivot": round_value(pivot),
        "support_1": round_value(support_1),
        "support_2": round_value(support_2),
        "resistance_1": round_value(resistance_1),
        "resistance_2": round_value(resistance_2),
    }


def fibonacci_levels(highs, lows):
    swing_high = max(highs[-50:])
    swing_low = min(lows[-50:])
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
    ema_20_value = ema(closes, 20)
    ema_50_value = ema(closes, 50)
    ema_200_value = ema(closes, 200)
    sma_20_value = sma(closes, 20)
    sma_50_value = sma(closes, 50)

    atr_value = atr(highs, lows, closes)
    average_volume_20 = average(volumes[-20:-1])
    current_volume = volumes[-1]
    volume_ratio = (
        current_volume / average_volume_20
        if average_volume_20
        else 0
    )

    total_volume_20 = sum(volumes[-20:])
    taker_buy_total_20 = sum(taker_buy_volumes[-20:])
    taker_buy_ratio = (
        (taker_buy_total_20 / total_volume_20) * 100
        if total_volume_20
        else 50
    )

    support = min(lows[-20:])
    resistance = max(highs[-20:])
    prior_resistance = max(highs[-21:-1])
    prior_support = min(lows[-21:-1])

    breakout = (
        "Bullish breakout"
        if last_close > prior_resistance and volume_ratio >= 1.2
        else "Bearish breakdown"
        if last_close < prior_support and volume_ratio >= 1.2
        else "No confirmed breakout"
    )

    trend = (
        "Strong bullish"
        if last_close > ema_20_value > ema_50_value > ema_200_value
        else "Bullish"
        if last_close > ema_20_value > ema_50_value
        else "Strong bearish"
        if last_close < ema_20_value < ema_50_value < ema_200_value
        else "Bearish"
        if last_close < ema_20_value < ema_50_value
        else "Mixed"
    )

    momentum_percent = percentage_change(closes[-13], last_close)

    return {
        "timeframe": interval,
        "price": round_value(last_close),
        "trend": trend,
        "ema": {
            "ema_20": round_value(ema_20_value),
            "ema_50": round_value(ema_50_value),
            "ema_200": round_value(ema_200_value),
        },
        "sma": {
            "sma_20": round_value(sma_20_value),
            "sma_50": round_value(sma_50_value),
        },
        "rsi_14": round_value(rsi(closes, 14)),
        "macd": macd(closes),
        "adx": adx(highs, lows, closes),
        "atr_14": round_value(atr_value),
        "atr_percent": round_value((atr_value / last_close) * 100),
        "bollinger_bands": bollinger_bands(closes),
        "volume": {
            "current": round_value(current_volume, 4),
            "average_20": round_value(average_volume_20, 4),
            "volume_ratio": round_value(volume_ratio),
            "quote_volume_current": round_value(quote_volumes[-1], 2),
            "trade_count_current": trade_counts[-1],
            "taker_buy_ratio_20_percent": round_value(taker_buy_ratio),
        },
        "obv": obv(closes, volumes),
        "mfi_14": round_value(mfi(highs, lows, closes, volumes)),
        "momentum_percent": round_value(momentum_percent),
        "support_resistance": {
            "support_20": round_value(support),
            "resistance_20": round_value(resistance),
        },
        "pivots": pivot_levels(highs, lows, closes),
        "fibonacci": fibonacci_levels(highs, lows),
        "candle_pattern": candle_pattern(candles),
        "market_structure": market_structure(
            closes,
            highs,
            lows,
            ema_20_value,
            ema_50_value,
        ),
        "breakout_status": breakout,
    }


def safe_hold_signal(reason):
    return {
        "signal": "HOLD",
        "confidence": 0,
        "reason": reason,
        "risk": "HIGH",
        "entry_idea": "Wait for a clearer setup and confirmation.",
        "stop_loss_idea": (
            "Do not open a position based on unavailable analysis."
        ),
        "timeframes": {
            "15m": {
                "signal": "HOLD",
                "summary": "Analysis unavailable.",
            },
            "1h": {
                "signal": "HOLD",
                "summary": "Analysis unavailable.",
            },
        },
        "disclaimer": (
            "Educational market analysis only. Not financial advice "
            "or an automated trading instruction."
        ),
    }


@app.get("/api/health")
def health():
    return {
        "status": "ok",
        "message": "BTC Signal Website backend running",
        "market_data_source": "Binance",
        "gemini_configured": bool(os.getenv("GEMINI_API_KEY")),
    }


@app.get("/api/btc/price")
def btc_price():
    now = time.time()

    if price_cache["data"] and now - price_cache["updated_at"] < 30:
        return price_cache["data"]

    try:
        ticker = get_btc_ticker()
        result = {
            "bitcoin": {
                "usd": float(ticker["lastPrice"]),
                "usd_24h_change": float(ticker["priceChangePercent"]),
            },
            "source": "Binance",
            "cached": False,
            "updated_at": int(now),
        }

        price_cache["data"] = result
        price_cache["updated_at"] = now
        return result

    except requests.exceptions.RequestException as error:
        if price_cache["data"]:
            return {
                **price_cache["data"],
                "cached": True,
                "warning": (
                    "Live market feed is temporarily unavailable. "
                    "Showing last saved price."
                ),
            }

        raise HTTPException(
            status_code=502,
            detail=f"Failed to fetch BTC price from Binance: {str(error)}",
        )


@app.get("/api/btc/chart")
def btc_chart(days: int = 7):
    now = time.time()

    if chart_cache["data"] and now - chart_cache["updated_at"] < 300:
        return chart_cache["data"]

    try:
        hours = max(24, min(days * 24, 1000))
        candles = get_btc_klines(interval="1h", limit=hours)

        result = {
            "prices": [
                [int(candle[0]), float(candle[4])]
                for candle in candles
            ],
            "source": "Binance",
            "cached": False,
            "updated_at": int(now),
        }

        chart_cache["data"] = result
        chart_cache["updated_at"] = now
        return result

    except requests.exceptions.RequestException as error:
        if chart_cache["data"]:
            return {
                **chart_cache["data"],
                "cached": True,
                "warning": (
                    "Live chart feed is temporarily unavailable. "
                    "Showing last saved chart."
                ),
            }

        raise HTTPException(
            status_code=502,
            detail=f"Failed to fetch BTC chart from Binance: {str(error)}",
        )


@app.get("/api/ai-signal")
def ai_signal():
    now = time.time()

    if ai_signal_cache["data"] and now - ai_signal_cache["updated_at"] < 300:
        return {
            **ai_signal_cache["data"],
            "cached": True,
        }

    api_key = os.getenv("GEMINI_API_KEY")
    if not api_key:
        return safe_hold_signal(
            "Gemini API key is not configured on the server."
        )

    try:
        ticker = get_btc_ticker()
        candles_15m = get_btc_klines(interval="15m", limit=250)
        candles_1h = get_btc_klines(interval="1h", limit=250)

        analysis_15m = calculate_market_indicators(candles_15m, "15m")
        analysis_1h = calculate_market_indicators(candles_1h, "1h")

        market_data = {
            "symbol": "BTCUSDT",
            "current_price_usdt": round_value(ticker["lastPrice"]),
            "price_change_24h_percent": round_value(
                ticker["priceChangePercent"]
            ),
            "high_24h_usdt": round_value(ticker["highPrice"]),
            "low_24h_usdt": round_value(ticker["lowPrice"]),
            "quote_volume_24h_usdt": round_value(ticker["quoteVolume"]),
            "timeframes": {
                "15m": analysis_15m,
                "1h": analysis_1h,
            },
        }

        prompt = f"""
You are a cautious BTCUSDT market-analysis assistant for an
educational dashboard. Analyze only the supplied live Binance data.

DATA:
{json.dumps(market_data, indent=2)}

Return only the requested JSON object in simple Hindi-English (Hinglish).

DECISION RULES:
1. BUY only when 15m and 1h broadly agree bullish, trend strength is
   adequate, and volume/price action provides confirmation.
2. SELL only when 15m and 1h broadly agree bearish, trend strength is
   adequate, and volume/price action provides confirmation.
3. HOLD whenever timeframes conflict, ADX says range/weak trend,
   price is near key resistance/support without confirmation, or data
   is otherwise unclear.
4. Never promise profit, certainty, or guaranteed targets.
5. Entry and stop-loss must be educational ideas based only on the
   supplied support, resistance, pivots, and ATR. Never phrase them as
   an automatic trade instruction.
6. Mention the most important evidence: trend, RSI/MACD, ADX, volume,
   candle/structure, and key level.
"""

        response_schema = {
            "type": "object",
            "properties": {
                "signal": {
                    "type": "string",
                    "enum": ["BUY", "SELL", "HOLD"],
                },
                "confidence": {
                    "type": "integer",
                    "minimum": 0,
                    "maximum": 100,
                },
                "risk": {
                    "type": "string",
                    "enum": ["LOW", "MEDIUM", "HIGH"],
                },
                "reason": {"type": "string"},
                "entry_idea": {"type": "string"},
                "stop_loss_idea": {"type": "string"},
                "timeframes": {
                    "type": "object",
                    "properties": {
                        "15m": {
                            "type": "object",
                            "properties": {
                                "signal": {
                                    "type": "string",
                                    "enum": ["BUY", "SELL", "HOLD"],
                                },
                                "summary": {"type": "string"},
                                "key_level": {"type": "string"},
                            },
                            "required": [
                                "signal",
                                "summary",
                                "key_level",
                            ],
                        },
                        "1h": {
                            "type": "object",
                            "properties": {
                                "signal": {
                                    "type": "string",
                                    "enum": ["BUY", "SELL", "HOLD"],
                                },
                                "summary": {"type": "string"},
                                "key_level": {"type": "string"},
                            },
                            "required": [
                                "signal",
                                "summary",
                                "key_level",
                            ],
                        },
                    },
                    "required": ["15m", "1h"],
                },
            },
            "required": [
                "signal",
                "confidence",
                "risk",
                "reason",
                "entry_idea",
                "stop_loss_idea",
                "timeframes",
            ],
        }

        client = genai.Client(api_key=api_key)
        response = client.models.generate_content(
            model=GEMINI_MODEL,
            contents=prompt,
            config=types.GenerateContentConfig(
                response_mime_type="application/json",
                response_json_schema=response_schema,
            ),
        )

        result = json.loads(response.text)
        result["market_data"] = market_data
        result["source"] = "Binance market data + Gemini AI analysis"
        result["cached"] = False
        result["updated_at"] = int(now)
        result["disclaimer"] = (
            "Educational market analysis only. Not financial advice "
            "or an automated trading instruction."
        )

        ai_signal_cache["data"] = result
        ai_signal_cache["updated_at"] = now
        return result

    except Exception as error:
        return safe_hold_signal(
            "AI analysis is temporarily unavailable: "
            f"{type(error).__name__}: {str(error)}"
        )


app.mount("/frontend", StaticFiles(directory="frontend"), name="frontend")


@app.get("/")
def home():
    return FileResponse("frontend/index.html")
