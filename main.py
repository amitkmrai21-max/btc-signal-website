import json
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
GEMINI_MODEL = "gemini-2.5-flash"

price_cache = {
    "data": None,
    "updated_at": 0,
}

chart_cache = {
    "data": None,
    "updated_at": 0,
}

ai_signal_cache = {
    "data": None,
    "updated_at": 0,
}


def get_btc_ticker():
    response = requests.get(
        f"{BINANCE_BASE_URL}/api/v3/ticker/24hr",
        params={"symbol": "BTCUSDT"},
        timeout=15,
    )
    response.raise_for_status()
    return response.json()


def get_btc_klines(limit=100):
    response = requests.get(
        f"{BINANCE_BASE_URL}/api/v3/klines",
        params={
            "symbol": "BTCUSDT",
            "interval": "1h",
            "limit": limit,
        },
        timeout=15,
    )
    response.raise_for_status()
    return response.json()


def calculate_market_indicators(candles):
    closes = [float(candle[4]) for candle in candles]
    volumes = [float(candle[5]) for candle in candles]

    if len(closes) < 30:
        raise ValueError("Not enough Binance candle data for analysis.")

    ema_20 = sum(closes[-20:]) / 20
    ema_50 = sum(closes[-50:]) / 50 if len(closes) >= 50 else sum(closes) / len(closes)

    changes = [closes[i] - closes[i - 1] for i in range(1, len(closes))]
    recent_changes = changes[-14:]
    gains = [change for change in recent_changes if change > 0]
    losses = [-change for change in recent_changes if change < 0]

    avg_gain = sum(gains) / 14
    avg_loss = sum(losses) / 14

    if avg_loss == 0:
        rsi_14 = 100.0
    else:
        relative_strength = avg_gain / avg_loss
        rsi_14 = 100 - (100 / (1 + relative_strength))

    return {
        "last_close": round(closes[-1], 2),
        "ema_20": round(ema_20, 2),
        "ema_50": round(ema_50, 2),
        "rsi_14": round(rsi_14, 2),
        "recent_24h_high": round(max(closes[-24:]), 2),
        "recent_24h_low": round(min(closes[-24:]), 2),
        "recent_24h_volume": round(sum(volumes[-24:]), 2),
    }


def safe_hold_signal(reason):
    return {
        "signal": "HOLD",
        "confidence": 0,
        "reason": reason,
        "risk": "HIGH",
        "entry_idea": "Wait for a clearer setup.",
        "stop_loss_idea": "Do not open a position based on this unavailable analysis.",
        "disclaimer": "Educational market analysis only. Not financial advice or an automated trading instruction.",
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

    except requests.exceptions.RequestException as e:
        if price_cache["data"]:
            return {
                **price_cache["data"],
                "cached": True,
                "warning": "Live market feed is temporarily unavailable. Showing last saved price.",
            }

        raise HTTPException(
            status_code=502,
            detail=f"Failed to fetch BTC price from Binance: {str(e)}",
        )


@app.get("/api/btc/chart")
def btc_chart(days: int = 7):
    now = time.time()

    if chart_cache["data"] and now - chart_cache["updated_at"] < 300:
        return chart_cache["data"]

    try:
        hours = max(24, min(days * 24, 1000))
        candles = get_btc_klines(limit=hours)

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

    except requests.exceptions.RequestException as e:
        if chart_cache["data"]:
            return {
                **chart_cache["data"],
                "cached": True,
                "warning": "Live chart feed is temporarily unavailable. Showing last saved chart.",
            }

        raise HTTPException(
            status_code=502,
            detail=f"Failed to fetch BTC chart from Binance: {str(e)}",
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
            "Gemini API key is not configured on the server. Add GEMINI_API_KEY in Render Environment Variables."
        )

    try:
        ticker = get_btc_ticker()
        candles = get_btc_klines(limit=100)
        indicators = calculate_market_indicators(candles)

        market_data = {
            "symbol": "BTCUSDT",
            "current_price_usdt": round(float(ticker["lastPrice"]), 2),
            "price_change_24h_percent": round(float(ticker["priceChangePercent"]), 2),
            "high_24h_usdt": round(float(ticker["highPrice"]), 2),
            "low_24h_usdt": round(float(ticker["lowPrice"]), 2),
            "quote_volume_24h_usdt": round(float(ticker["quoteVolume"]), 2),
            "indicators_1h": indicators,
        }

        prompt = f"""
You are a cautious Bitcoin market-analysis assistant for an educational dashboard.

Analyze only the BTCUSDT Binance market snapshot below. Do not claim certainty,
do not promise profits, and do not instruct automatic trading. A HOLD result is
preferred when signals conflict or market conditions are unclear.

Market snapshot:
{json.dumps(market_data, indent=2)}

Return exactly one JSON object matching the requested schema.
Use simple Hindi-English (Hinglish) in the text fields.
"""

        client = genai.Client(api_key=api_key)

        response = client.models.generate_content(
            model=GEMINI_MODEL,
            contents=prompt,
            config=types.GenerateContentConfig(
                 
                response_mime_type="application/json",
                response_schema={
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
                        "reason": {
                            "type": "string",
                        },
                        "risk": {
                            "type": "string",
                            "enum": ["LOW", "MEDIUM", "HIGH"],
                        },
                        "entry_idea": {
                            "type": "string",
                        },
                        "stop_loss_idea": {
                            "type": "string",
                        },
                    },
                    "required": [
                        "signal",
                        "confidence",
                        "reason",
                        "risk",
                        "entry_idea",
                        "stop_loss_idea",
                    ],
                },
            ),
        )

        result = json.loads(response.text)
        result["market_data"] = market_data
        result["source"] = "Binance market data + Gemini AI analysis"
        result["cached"] = False
        result["updated_at"] = int(now)
        result["disclaimer"] = (
            "Educational market analysis only. Not financial advice or an automated trading instruction."
        )

        ai_signal_cache["data"] = result
        ai_signal_cache["updated_at"] = now
        return result

    except (requests.exceptions.RequestException, ValueError, json.JSONDecodeError) as e:
        return safe_hold_signal(
            f"Market or AI analysis is temporarily unavailable. {str(e)}"
        )

   except Exception as e:
    return safe_hold_signal(
        f"AI analysis is temporarily unavailable: {type(e).__name__}: {str(e)}"
    ) 


app.mount("/frontend", StaticFiles(directory="frontend"), name="frontend")


@app.get("/")
def home():
    return FileResponse("frontend/index.html")
