let btcChart;
let activeTimeframe = "1D";
let currentBtcPriceUsd = null;
let currentBtcPriceInr = null;
let aiRefreshInProgress = false;

const USD_INR_RATE = 83;
const PAPER_STORAGE_KEY = "btcAiSignalPaperPortfolioV1";
const DEFAULT_PAPER_CASH = 100000;

const timeframeSettings = {
  "1W": {
    days: 90,
    interval: "1w",
    label: "Weekly",
    dateOptions: { month: "short", year: "numeric" },
    maxPoints: 20
  },
  "1D": {
    days: 30,
    interval: "1d",
    label: "Daily",
    dateOptions: { month: "short", day: "numeric" },
    maxPoints: 31
  },
  "1H": {
    days: 7,
    interval: "1h",
    label: "Hourly",
    dateOptions: {
      month: "short",
      day: "numeric",
      hour: "2-digit"
    },
    maxPoints: 120
  },
  "15M": {
    days: 1,
    interval: "15m",
    label: "15 Min",
    dateOptions: {
      hour: "2-digit",
      minute: "2-digit"
    },
    maxPoints: 120
  }
};

function getElement(id) {
  return document.getElementById(id);
}

function setText(id, value) {
  const element = getElement(id);

  if (element) {
    element.textContent = value ?? "--";
  }
}

function formatDateForSignal() {
  return new Date().toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric"
  });
}

function formatUpdatedAt(timestamp) {
  if (!timestamp) {
    return "Update time unavailable";
  }

  return new Date(timestamp * 1000).toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

function formatUsd(value) {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    return "--";
  }

  return `$${number.toLocaleString("en-US", {
    maximumFractionDigits: 2
  })}`;
}

function formatInr(value) {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    return "₹--";
  }

  return `₹${number.toLocaleString("en-IN", {
    maximumFractionDigits: 2
  })}`;
}

function formatBtc(value) {
  const number = Number(value);

  if (!Number.isFinite(number)) {
    return "0.000000 BTC";
  }

  return `${number.toFixed(6)} BTC`;
}

function getSignalColor(signal) {
  if (signal === "BUY") {
    return "#22c55e";
  }

  if (signal === "SELL") {
    return "#ef4444";
  }

  return "#facc15";
}

function setSignal(signal, reason) {
  const normalizedSignal = ["BUY", "SELL", "HOLD"].includes(signal)
    ? signal
    : "HOLD";

  const color = getSignalColor(normalizedSignal);
  const signalBox = getElement("signalBox");
  const signalAction = getElement("signal-action");

  if (signalBox) {
    signalBox.textContent = normalizedSignal;
    signalBox.style.color = color;
  }

  if (signalAction) {
    signalAction.textContent = normalizedSignal;
    signalAction.style.color = color;
  }

  setText("aiSignalText", reason);
}

function setMiniSignal(id, signal) {
  const element = getElement(id);

  if (!element) {
    return;
  }

  const normalizedSignal = ["BUY", "SELL", "HOLD"].includes(signal)
    ? signal
    : "HOLD";

  const color = getSignalColor(normalizedSignal);

  element.textContent = normalizedSignal;
  element.style.color = color;
  element.style.borderColor = color;
}

function setRiskBadge(risk) {
  const badge = getElement("riskBadge");

  if (!badge) {
    return;
  }

  const normalizedRisk = ["LOW", "MEDIUM", "HIGH"].includes(risk)
    ? risk
    : "HIGH";

  badge.textContent = `Risk: ${normalizedRisk}`;
  badge.className = `risk-badge risk-${normalizedRisk.toLowerCase()}`;
}

function getDefaultPaperPortfolio() {
  return {
    cashInr: DEFAULT_PAPER_CASH,
    btcHolding: 0,
    totalCostInr: 0,
    history: []
  };
}

function loadPaperPortfolio() {
  try {
    const saved = localStorage.getItem(PAPER_STORAGE_KEY);

    if (!saved) {
      return getDefaultPaperPortfolio();
    }

    const portfolio = JSON.parse(saved);

    if (
      !Number.isFinite(Number(portfolio.cashInr)) ||
      !Number.isFinite(Number(portfolio.btcHolding)) ||
      !Array.isArray(portfolio.history)
    ) {
      return getDefaultPaperPortfolio();
    }

    return {
      cashInr: Number(portfolio.cashInr),
      btcHolding: Number(portfolio.btcHolding),
      totalCostInr: Number(portfolio.totalCostInr || 0),
      history: portfolio.history.slice(0, 50)
    };
  } catch (error) {
    return getDefaultPaperPortfolio();
  }
}

function savePaperPortfolio(portfolio) {
  localStorage.setItem(PAPER_STORAGE_KEY, JSON.stringify(portfolio));
}

function getPaperPortfolio() {
  return loadPaperPortfolio();
}

function renderPaperTrading() {
  const portfolio = getPaperPortfolio();
  const holdingValueInr = currentBtcPriceInr
    ? portfolio.btcHolding * currentBtcPriceInr
    : 0;

  const portfolioValueInr = portfolio.cashInr + holdingValueInr;
  const pnlInr = portfolioValueInr - DEFAULT_PAPER_CASH;
  const pnlPercent = (pnlInr / DEFAULT_PAPER_CASH) * 100;
  const averageBuyPriceInr = portfolio.btcHolding > 0
    ? portfolio.totalCostInr / portfolio.btcHolding
    : 0;

  setText("paperCash", formatInr(portfolio.cashInr));
  setText("paperBtcHolding", formatBtc(portfolio.btcHolding));
  setText(
    "paperAvgPrice",
    portfolio.btcHolding > 0 ? formatInr(averageBuyPriceInr) : "No holding"
  );
  setText("paperPortfolioValue", formatInr(portfolioValueInr));

  const pnlElement = getElement("paperPnl");

  if (pnlElement) {
    const prefix = pnlInr >= 0 ? "+" : "";
    pnlElement.textContent =
      `${prefix}${formatInr(pnlInr)} (${prefix}${pnlPercent.toFixed(2)}%)`;
    pnlElement.style.color = pnlInr >= 0 ? "#22c55e" : "#ef4444";
  }

  renderPaperHistory(portfolio.history);
}

function renderPaperHistory(history) {
  const container = getElement("paperTradeHistory");

  if (!container) {
    return;
  }

  if (!history.length) {
    container.textContent = "No virtual trades yet.";
    return;
  }

  container.innerHTML = "";

  history.forEach((trade) => {
    const item = document.createElement("div");
    const typeClass = trade.type === "BUY" ? "history-buy" : "history-sell";
    const date = new Date(trade.timestamp).toLocaleString("en-IN", {
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit"
    });

    item.className = `history-item ${typeClass}`;
    item.textContent =
      `${trade.type} • ${formatInr(trade.amountInr)} • ` +
      `${formatBtc(trade.btcAmount)} • ${date}`;

    container.appendChild(item);
  });
}

function updatePrice(priceData) {
  const btc = priceData?.bitcoin;
  const priceUsd = Number(btc?.usd);
  const change = Number(btc?.usd_24h_change || 0);

  if (!Number.isFinite(priceUsd)) {
    throw new Error("Live BTC price was not received.");
  }

  currentBtcPriceUsd = priceUsd;
  currentBtcPriceInr = priceUsd * USD_INR_RATE;

  setText("btcPrice", formatUsd(priceUsd));

  const btcChange = getElement("btcChange");

  if (btcChange) {
    btcChange.textContent =
      `${change >= 0 ? "+" : ""}${change.toFixed(2)}%`;
    btcChange.style.color = change >= 0 ? "#22c55e" : "#ef4444";
  }

  setText(
    "marketUpdatedAt",
    `Live price updated: ${formatUpdatedAt(priceData.updated_at)}${
      priceData.cached ? " (cached)" : ""
    }`
  );

  renderPaperTrading();
}

function updateAiAnalysis(aiData) {
  setSignal(aiData.signal, aiData.reason);
  setText("aiConfidence", `${Number(aiData.confidence || 0)}%`);
  setText("entryIdea", aiData.entry_idea);
  setText("stopLossIdea", aiData.stop_loss_idea);
  setText("disclaimerText", aiData.disclaimer);

  setText(
    "analysisUpdatedAt",
    `Last analysis: ${formatUpdatedAt(aiData.updated_at)}${
      aiData.cached ? " (cached)" : ""
    }`
  );

  setRiskBadge(aiData.risk);

  const analysis15m = aiData?.timeframes?.["15m"] || {};
  const analysis1h = aiData?.timeframes?.["1h"] || {};

  setMiniSignal("signal15m", analysis15m.signal);
  setMiniSignal("signal1h", analysis1h.signal);

  setText("summary15m", analysis15m.summary);
  setText("summary1h", analysis1h.summary);
  setText("keyLevel15m", analysis15m.key_level);
  setText("keyLevel1h", analysis1h.key_level);

  const market15m = aiData?.market_data?.timeframes?.["15m"] || {};
  const market1h = aiData?.market_data?.timeframes?.["1h"] || {};

  updateIndicators(market15m, market1h);
}

function updateIndicators(market15m, market1h) {
  setText("trend15m", market15m.trend);
  setText("rsi15m", market15m.rsi_14);
  setText("macd15m", market15m?.macd?.state);
  setText(
    "adx15m",
    `${market15m?.adx?.adx_14 ?? "--"} ` +
    `(${market15m?.adx?.trend_strength ?? "--"})`
  );
  setText(
    "momentum15m",
    `${market15m?.momentum_percent ?? "--"}%`
  );

  setText("trend1h", market1h.trend);
  setText("rsi1h", market1h.rsi_14);
  setText("macd1h", market1h?.macd?.state);
  setText(
    "adx1h",
    `${market1h?.adx?.adx_14 ?? "--"} ` +
    `(${market1h?.adx?.trend_strength ?? "--"})`
  );
  setText(
    "momentum1h",
    `${market1h?.momentum_percent ?? "--"}%`
  );

  setText(
    "volume15m",
    `x${market15m?.volume?.volume_ratio ?? "--"}`
  );
  setText(
    "volume1h",
    `x${market1h?.volume?.volume_ratio ?? "--"}`
  );
  setText("pattern15m", market15m.candle_pattern);
  setText("pattern1h", market1h.candle_pattern);
  setText("breakout15m", market15m.breakout_status);

  setText(
    "support15m",
    formatUsd(market15m?.support_resistance?.support_20)
  );
  setText(
    "resistance15m",
    formatUsd(market15m?.support_resistance?.resistance_20)
  );
  setText(
    "support1h",
    formatUsd(market1h?.support_resistance?.support_20)
  );
  setText(
    "resistance1h",
    formatUsd(market1h?.support_resistance?.resistance_20)
  );
  setText("structure1h", market1h.market_structure);
}

async function loadPrice() {
  const response = await fetch("/api/btc/price", {
    cache: "no-store"
  });

  if (!response.ok) {
    throw new Error("Price API could not be loaded.");
  }

  const data = await response.json();
  updatePrice(data);
}

async function loadChart() {
  const selected = timeframeSettings[activeTimeframe];

  const response = await fetch(
    `/api/btc/chart?days=${selected.days}&interval=${selected.interval}`,
    {
      cache: "no-store"
    }
  );

  if (!response.ok) {
    throw new Error("Chart API could not be loaded.");
  }

  const chartData = await response.json();
  const rawPrices = Array.isArray(chartData.prices)
    ? chartData.prices
    : [];

  if (!rawPrices.length) {
    throw new Error("No chart data was received.");
  }

  const step = Math.max(
    1,
    Math.ceil(rawPrices.length / selected.maxPoints)
  );

  const chartPoints = rawPrices.filter((_, index) => {
    return index % step === 0 || index === rawPrices.length - 1;
  });

  const labels = chartPoints.map((item) => {
    return new Date(item[0]).toLocaleString(
      "en-IN",
      selected.dateOptions
    );
  });

  const prices = chartPoints.map((item) => item[1]);

  renderChart(labels, prices, selected.label);
}

async function loadAiAnalysis() {
  if (aiRefreshInProgress) {
    return;
  }

  aiRefreshInProgress = true;
  setText("analysisUpdatedAt", "Updating Gemini AI analysis...");

  try {
    const response = await fetch("/api/ai-signal", {
      cache: "no-store"
    });

    if (!response.ok) {
      throw new Error("AI signal API could not be loaded.");
    }

    const data = await response.json();
    updateAiAnalysis(data);
  } catch (error) {
    console.error(error);

    setSignal(
      "HOLD",
      "AI analysis temporarily unavailable. Live price and paper trading still work."
    );
    setRiskBadge("HIGH");
    setText("analysisUpdatedAt", "AI analysis could not be loaded.");
  } finally {
    aiRefreshInProgress = false;
  }
}

async function refreshFastData() {
  try {
    await Promise.all([
      loadPrice(),
      loadChart()
    ]);
  } catch (error) {
    console.error(error);
    setText(
      "marketUpdatedAt",
      "Live price/chart could not be updated. Please try again."
    );
  }
}

async function refreshAllData() {
  const refreshButton = getElement("refreshBtn");

  if (refreshButton) {
    refreshButton.disabled = true;
    refreshButton.textContent = "Refreshing...";
  }

  await Promise.all([
    refreshFastData(),
    loadAiAnalysis()
  ]);

  if (refreshButton) {
    refreshButton.disabled = false;
    refreshButton.textContent = "Refresh Analysis";
  }
}

function renderChart(labels, data, timeframeLabel) {
  const canvas = getElement("btcChart");

  if (!canvas) {
    return;
  }

  const ctx = canvas.getContext("2d");

  if (btcChart) {
    btcChart.destroy();
  }

  btcChart = new Chart(ctx, {
    type: "line",
    data: {
      labels,
      datasets: [{
        label: `BTC/USD • ${timeframeLabel}`,
        data,
        borderColor: "#22c55e",
        backgroundColor: "rgba(34, 197, 94, 0.15)",
        borderWidth: 2,
        fill: true,
        tension: 0.28,
        pointRadius: 0,
        pointHoverRadius: 4
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      interaction: {
        intersect: false,
        mode: "index"
      },
      plugins: {
        legend: {
          labels: {
            color: "#ffffff"
          }
        },
        tooltip: {
          callbacks: {
            label(context) {
              return `BTC: ${formatUsd(context.raw)}`;
            }
          }
        },
        zoom: {
          limits: {
            x: {
              min: "original",
              max: "original",
              minRange: 5
            }
          },
          pan: {
            enabled: true,
            mode: "x",
            modifierKey: "shift"
          },
          zoom: {
            wheel: {
              enabled: true
            },
            pinch: {
              enabled: true
            },
            drag: {
              enabled: true,
              backgroundColor: "rgba(59, 130, 246, 0.18)",
              borderColor: "#60a5fa",
              borderWidth: 1
            },
            mode: "x"
          }
        }
      },
      scales: {
        x: {
          ticks: {
            color: "#cbd5e1",
            maxTicksLimit: 7
          },
          grid: {
            color: "#1e293b"
          }
        },
        y: {
          ticks: {
            color: "#cbd5e1",
            callback(value) {
              return formatUsd(value);
            }
          },
          grid: {
            color: "#1e293b"
          }
        }
      }
    }
  });
}

function executePaperBuy() {
  const input = getElement("paperAmountInput");
  const amountInr = Number(input?.value);

  if (!currentBtcPriceInr) {
    setText(
      "paperTradeStatus",
      "Waiting for live BTC price. Please wait a few seconds."
    );
    return;
  }

  if (!Number.isFinite(amountInr) || amountInr < 100) {
    setText(
      "paperTradeStatus",
      "Please enter a valid virtual amount of at least ₹100."
    );
    return;
  }

  const portfolio = getPaperPortfolio();

  if (amountInr > portfolio.cashInr) {
    setText(
      "paperTradeStatus",
      "Not enough virtual cash for this trade."
    );
    return;
  }

  const btcAmount = amountInr / currentBtcPriceInr;

  portfolio.cashInr -= amountInr;
  portfolio.btcHolding += btcAmount;
  portfolio.totalCostInr += amountInr;

  portfolio.history.unshift({
    type: "BUY",
    amountInr,
    btcAmount,
    priceInr: currentBtcPriceInr,
    timestamp: Date.now()
  });

  portfolio.history = portfolio.history.slice(0, 50);
  savePaperPortfolio(portfolio);

  if (input) {
    input.value = "";
  }

  setText(
    "paperTradeStatus",
    `Virtual BUY complete: ${formatBtc(btcAmount)} at ${formatInr(currentBtcPriceInr)} per BTC.`
  );

  renderPaperTrading();
}

function executePaperSell() {
  const input = getElement("paperAmountInput");
  const amountInr = Number(input?.value);

  if (!currentBtcPriceInr) {
    setText(
      "paperTradeStatus",
      "Waiting for live BTC price. Please wait a few seconds."
    );
    return;
  }

  if (!Number.isFinite(amountInr) || amountInr < 100) {
    setText(
      "paperTradeStatus",
      "Please enter a valid virtual amount of at least ₹100."
    );
    return;
  }

  const portfolio = getPaperPortfolio();
  const btcAmount = amountInr / currentBtcPriceInr;

  if (btcAmount > portfolio.btcHolding + 0.0000000001) {
    setText(
      "paperTradeStatus",
      "Not enough virtual BTC holding to sell this amount."
    );
    return;
  }

  const averageCostPerBtc = portfolio.btcHolding > 0
    ? portfolio.totalCostInr / portfolio.btcHolding
    : 0;

  portfolio.cashInr += amountInr;
  portfolio.btcHolding -= btcAmount;
  portfolio.totalCostInr -= btcAmount * averageCostPerBtc;

  if (portfolio.btcHolding < 0.00000001) {
    portfolio.btcHolding = 0;
    portfolio.totalCostInr = 0;
  }

  portfolio.history.unshift({
    type: "SELL",
    amountInr,
    btcAmount,
    priceInr: currentBtcPriceInr,
    timestamp: Date.now()
  });

  portfolio.history = portfolio.history.slice(0, 50);
  savePaperPortfolio(portfolio);

  if (input) {
    input.value = "";
  }

  setText(
    "paperTradeStatus",
    `Virtual SELL complete: ${formatBtc(btcAmount)} at ${formatInr(currentBtcPriceInr)} per BTC.`
  );

  renderPaperTrading();
}

function resetPaperTrading() {
  const shouldReset = window.confirm(
    "Reset virtual paper portfolio to ₹100,000 and remove all virtual trades?"
  );

  if (!shouldReset) {
    return;
  }

  savePaperPortfolio(getDefaultPaperPortfolio());
  setText(
    "paperTradeStatus",
    "Virtual portfolio reset to ₹100,000."
  );
  renderPaperTrading();
}

function setupPaperTrading() {
  const buyButton = getElement("paperBuyBtn");
  const sellButton = getElement("paperSellBtn");
  const resetButton = getElement("resetPaperBtn");

  if (buyButton) {
    buyButton.addEventListener("click", executePaperBuy);
  }

  if (sellButton) {
    sellButton.addEventListener("click", executePaperSell);
  }

  if (resetButton) {
    resetButton.addEventListener("click", resetPaperTrading);
  }

  renderPaperTrading();
}

function setupTimeframeButtons() {
  const buttons = document.querySelectorAll(".timeframe-btn");

  buttons.forEach((button) => {
    button.addEventListener("click", async () => {
      const selectedTimeframe = button.dataset.timeframe;

      if (!timeframeSettings[selectedTimeframe]) {
        return;
      }

      activeTimeframe = selectedTimeframe;

      buttons.forEach((item) => {
        item.classList.remove("active");
      });

      button.classList.add("active");

      try {
        await loadChart();
      } catch (error) {
        console.error(error);
        setText(
          "marketUpdatedAt",
          "Selected chart timeframe could not be loaded."
        );
      }
    });
  });
}

function setupZoomButtons() {
  const zoomInButton = getElement("zoomInBtn");
  const zoomOutButton = getElement("zoomOutBtn");
  const resetZoomButton = getElement("resetZoomBtn");

  if (zoomInButton) {
    zoomInButton.addEventListener("click", () => {
      if (btcChart) {
        btcChart.zoom({ x: 1.3 });
      }
    });
  }

  if (zoomOutButton) {
    zoomOutButton.addEventListener("click", () => {
      if (btcChart) {
        btcChart.zoom({ x: 0.75 });
      }
    });
  }

  if (resetZoomButton) {
    resetZoomButton.addEventListener("click", () => {
      if (btcChart) {
        btcChart.resetZoom();
      }
    });
  }
}

const refreshButton = getElement("refreshBtn");

if (refreshButton) {
  refreshButton.addEventListener("click", refreshAllData);
}

setText("signal-date", formatDateForSignal());
setupPaperTrading();
setupTimeframeButtons();
setupZoomButtons();
refreshAllData();

setInterval(loadPrice, 30000);
setInterval(loadChart, 60000);
setInterval(loadAiAnalysis, 300000);
