from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
import requests
import time

app = FastAPI(title="BTC Signal Website")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

BINANCE_BASE_URL = "https://data-api.binance.vision"

price_cache = {
    "data": None,
    "updated_at": 0,
}

chart_cache = {
    "data": None,
    "updated_at": 0,
}


@app.get("/api/health")
def health():
    return {
        "status": "ok",
        "message": "BTC Signal Website backend running",
        "market_data_source": "Binance",
    }


@app.get("/api/btc/price")
def btc_price():
    now = time.time()

    # Refresh Binance data only once per 30 seconds.
    if price_cache["data"] and now - price_cache["updated_at"] < 30:
        return price_cache["data"]

    try:
        response = requests.get(
            f"{BINANCE_BASE_URL}/api/v3/ticker/24hr",
            params={"symbol": "BTCUSDT"},
            timeout=15,
        )
        response.raise_for_status()
        ticker = response.json()

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

    # 7-day hourly chart changes slowly; refresh at most once per 5 minutes.
    if chart_cache["data"] and now - chart_cache["updated_at"] < 300:
        return chart_cache["data"]

    try:
        hours = max(24, min(days * 24, 1000))

        response = requests.get(
            f"{BINANCE_BASE_URL}/api/v3/klines",
            params={
                "symbol": "BTCUSDT",
                "interval": "1h",
                "limit": hours,
            },
            timeout=15,
        )
        response.raise_for_status()
        candles = response.json()

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


app.mount("/frontend", StaticFiles(directory="frontend"), name="frontend")


@app.get("/")
def home():
    return FileResponse("frontend/index.html")
