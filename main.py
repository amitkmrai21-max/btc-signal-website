from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
import requests

app = FastAPI(title="BTC Signal Website")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

COINGECKO_URL = "https://api.coingecko.com/api/v3"

@app.get("/api/health")
def health():
    return {"status": "ok", "message": "BTC Signal Website backend running"}

@app.get("/api/btc/price")
def btc_price():
    response = requests.get(
        f"{COINGECKO_URL}/simple/price",
        params={
            "ids": "bitcoin",
            "vs_currencies": "usd",
            "include_24hr_change": "true"
        },
        timeout=15
    )
    response.raise_for_status()
    return response.json()

@app.get("/api/btc/chart")
def btc_chart(days: int = 7):
    response = requests.get(
        f"{COINGECKO_URL}/coins/bitcoin/market_chart",
        params={
            "vs_currency": "usd",
            "days": days,
            "interval": "hourly"
        },
        timeout=15
    )
    response.raise_for_status()
    return response.json()

app.mount("/", StaticFiles(directory="frontend", html=True), name="frontend")

@app.get("/")
def home():
    return FileResponse("frontend/index.html")
