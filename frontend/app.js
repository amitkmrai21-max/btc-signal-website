let btcChart;
let activeTimeframe = "1D";

const timeframeSettings = {
  "1W": {
    days: 90,
    label: "Weekly",
    dateOptions: { month: "short", day: "numeric" }
  },
  "1D": {
    days: 30,
    label: "Daily",
    dateOptions: { month: "short", day: "numeric" }
  },
  "1H": {
    days: 7,
    label: "Hourly",
    dateOptions: { month: "short", day: "numeric", hour: "2-digit" }
  },
  "15M": {
    days: 1,
    label: "15 Min",
    dateOptions: { hour: "2-digit", minute: "2-digit" }
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

function formatPrice(value) {
  const price = Number(value);

  if (!Number.isFinite(price)) {
    return "--";
  }

  return `$${price.toLocaleString("en-US", {
    maximumFractionDigits: 2
  })}`;
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

function setSignal(signal, signalText) {
  const normalizedSignal = ["BUY", "SELL", "HOLD"].includes(signal)
    ? signal
    : "HOLD";

  const signalColor = getSignalColor(normalizedSignal);
  const signalBox = getElement("signalBox");
  const signalAction = getElement("signal-action");

  if (signalBox) {
    signalBox.textContent = normalizedSignal;
    signalBox.style.color = signalColor;
  }

  if (signalAction) {
    signalAction.textContent = normalizedSignal;
    signalAction.style.color = signalColor;
  }

  setText("aiSignalText", signalText);
}

function setMiniSignal(id, signal) {
  const element = getElement(id);

  if (!element) {
    return;
  }

  const normalizedSignal = ["BUY", "SELL", "HOLD"].includes(signal)
    ? signal
    : "HOLD";

  element.textContent = normalizedSignal;
  element.style.color = getSignalColor(normalizedSignal);
  element.style.borderColor = getSignalColor(normalizedSignal);
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

function formatUpdatedAt(timestamp) {
  if (!timestamp) {
    return "Analysis update time unavailable";
  }

  return new Date(timestamp * 1000).toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

function updatePrice(priceData) {
  const btc = priceData?.bitcoin;
  const price = Number(btc?.usd);
  const change = Number(btc?.usd_24h_change || 0);

  if (!Number.isFinite(price)) {
    throw new Error("Live BTC price was not received.");
  }

  setText(
    "btcPrice",
    `$${price.toLocaleString("en-US", {
      maximumFractionDigits: 2
    })}`
  );

  const btcChange = getElement("btcChange");

  if (btcChange) {
    btcChange.textContent =
      `${change >= 0 ? "+" : ""}${change.toFixed(2)}%`;
    btcChange.style.color = change >= 0 ? "#22c55e" : "#ef4444";
  }
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
    `${market15m?.adx?.adx_14 ?? "--"} (${market15m?.adx?.trend_strength ?? "--"})`
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
    `${market1h?.adx?.adx_14 ?? "--"} (${market1h?.adx?.trend_strength ?? "--"})`
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
    formatPrice(market15m?.support_resistance?.support_20)
  );
  setText(
    "resistance15m",
    formatPrice(market15m?.support_resistance?.resistance_20)
  );
  setText(
    "support1h",
    formatPrice(market1h?.support_resistance?.support_20)
  );
  setText(
    "resistance1h",
    formatPrice(market1h?.support_resistance?.resistance_20)
  );
  setText("structure1h", market1h.market_structure);
}

async function loadBTCData() {
  const selected = timeframeSettings[activeTimeframe];
  const refreshButton = getElement("refreshBtn");

  if (refreshButton) {
    refreshButton.disabled = true;
    refreshButton.textContent = "Updating...";
  }

  setText("aiSignalText", "Updating live BTC data and Gemini AI analysis...");
  setText("analysisUpdatedAt", "Updating analysis...");

  try {
    const [priceRes, chartRes, aiRes] = await Promise.all([
      fetch("/api/btc/price", { cache: "no-store" }),
      fetch(`/api/btc/chart?days=${selected.days}`, {
        cache: "no-store"
      }),
      fetch("/api/ai-signal", { cache: "no-store" })
    ]);

    if (!priceRes.ok) {
      throw new Error("Price API could not be loaded.");
    }

    if (!chartRes.ok) {
      throw new Error("Chart API could not be loaded.");
    }

    if (!aiRes.ok) {
      throw new Error("AI signal API could not be loaded.");
    }

    const [priceData, chartData, aiData] = await Promise.all([
      priceRes.json(),
      chartRes.json(),
      aiRes.json()
    ]);

    updatePrice(priceData);
    updateAiAnalysis(aiData);

    const rawPrices = Array.isArray(chartData.prices)
      ? chartData.prices
      : [];

    if (!rawPrices.length) {
      throw new Error("No chart data was received.");
    }

    const maxPoints = activeTimeframe === "15M"
      ? 96
      : activeTimeframe === "1H"
        ? 84
        : activeTimeframe === "1D"
          ? 30
          : 13;

    const step = Math.max(1, Math.ceil(rawPrices.length / maxPoints));
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
  } catch (error) {
    console.error(error);

    setSignal(
      "HOLD",
      "Live market analysis temporarily unavailable. Please refresh again."
    );
    setText("analysisUpdatedAt", "Analysis could not be loaded.");
    setRiskBadge("HIGH");
  } finally {
    if (refreshButton) {
      refreshButton.disabled = false;
      refreshButton.textContent = "Refresh Analysis";
    }
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
        tension: 0.3,
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
              return `BTC: $${Number(context.raw).toLocaleString("en-US", {
                maximumFractionDigits: 2
              })}`;
            }
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
              return `$${Number(value).toLocaleString("en-US")}`;
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

function setupPaperTrading() {
  const button = getElement("calcTradeBtn");

  if (!button) {
    return;
  }

  button.addEventListener("click", () => {
    const capital = parseFloat(getElement("capitalInput")?.value);
    const priceText = getElement("btcPrice")?.textContent
      .replace(/[$,]/g, "");
    const btcPrice = parseFloat(priceText);

    if (!capital || !btcPrice) {
      setText(
        "tradeResult",
        "Please enter capital and load BTC price first."
      );
      return;
    }

    const usdInr = 83;
    const btcPriceInr = btcPrice * usdInr;
    const quantity = capital / btcPriceInr;

    setText(
      "tradeResult",
      `With ₹${capital.toLocaleString()}, you can paper trade about ` +
      `${quantity.toFixed(6)} BTC at approx ` +
      `₹${btcPriceInr.toLocaleString("en-IN", {
        maximumFractionDigits: 0
      })} per BTC.`
    );
  });
}

function setupUpload() {
  const input = getElement("fileInput");

  if (!input) {
    return;
  }

  input.addEventListener("change", (event) => {
    const file = event.target.files[0];

    if (file) {
      setText("uploadStatus", `Selected file: ${file.name}`);
    }
  });
}

function setupTimeframeButtons() {
  const timeframeButtons = document.querySelectorAll(".timeframe-btn");

  timeframeButtons.forEach((button) => {
    button.addEventListener("click", () => {
      const selectedTimeframe = button.dataset.timeframe;

      if (!timeframeSettings[selectedTimeframe]) {
        return;
      }

      activeTimeframe = selectedTimeframe;

      timeframeButtons.forEach((item) => {
        item.classList.remove("active");
      });

      button.classList.add("active");
      loadBTCData();
    });
  });
}

const refreshButton = getElement("refreshBtn");

if (refreshButton) {
  refreshButton.addEventListener("click", loadBTCData);
}

setText("signal-date", formatDateForSignal());
setupPaperTrading();
setupUpload();
setupTimeframeButtons();
loadBTCData();
