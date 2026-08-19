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

function formatDateForSignal() {
  return new Date().toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric"
  });
}

function setSignal(signal, signalText, signalColor) {
  const signalBox = document.getElementById("signalBox");
  const signalAction = document.getElementById("signal-action");
  const aiSignalText = document.getElementById("aiSignalText");

  signalBox.textContent = signal;
  signalBox.style.color = signalColor;

  signalAction.textContent = signal;
  signalAction.style.color = signal === "BUY"
    ? "#fef08a"
    : signal === "HOLD"
      ? "#fef3c7"
      : "#fecaca";

  aiSignalText.textContent = signalText;
}

async function loadBTCData() {
  const selected = timeframeSettings[activeTimeframe];

  try {
    document.getElementById("aiSignalText").textContent =
      "Updating live BTC market data...";

    const priceRes = await fetch("/api/btc/price", {
      cache: "no-store"
    });

    if (!priceRes.ok) {
      throw new Error("Price API could not be loaded.");
    }

    const priceData = await priceRes.json();

    const chartRes = await fetch(
      `/api/btc/chart?days=${selected.days}`,
      { cache: "no-store" }
    );

    if (!chartRes.ok) {
      throw new Error("Chart API could not be loaded.");
    }

    const chartData = await chartRes.json();

    const btc = priceData.bitcoin;

    if (!btc || typeof btc.usd !== "number") {
      throw new Error("Live BTC price was not received.");
    }

    const price = btc.usd;
    const change = Number(btc.usd_24h_change || 0);

    document.getElementById("btcPrice").textContent =
      `$${price.toLocaleString("en-US", {
        maximumFractionDigits: 2
      })}`;

    const btcChange = document.getElementById("btcChange");
    btcChange.textContent = `${change >= 0 ? "+" : ""}${change.toFixed(2)}%`;
    btcChange.style.color = change >= 0 ? "#22c55e" : "#ef4444";

    let signal = "HOLD";
    let signalText = "Market is neutral. Wait for confirmation.";
    let signalColor = "#facc15";

    if (change > 1) {
      signal = "BUY";
      signalText =
        "AI signal: bullish momentum is active. Buy zone may be possible.";
      signalColor = "#22c55e";
    } else if (change < -1) {
      signal = "SELL";
      signalText =
        "AI signal: bearish pressure is high. Avoid fresh entries or consider selling.";
      signalColor = "#ef4444";
    }

    setSignal(signal, signalText, signalColor);

    const signalDate = document.getElementById("signal-date");

    if (signalDate) {
      signalDate.textContent = formatDateForSignal();
    }

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

    document.getElementById("aiSignalText").textContent =
      "Error loading live BTC data. Please press Refresh again.";

    const signalDate = document.getElementById("signal-date");

    if (signalDate && signalDate.textContent === "Loading...") {
      signalDate.textContent = formatDateForSignal();
    }
  }
}

function renderChart(labels, data, timeframeLabel) {
  const canvas = document.getElementById("btcChart");

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
      labels: labels,
      datasets: [{
        label: `BTC/USD • ${timeframeLabel}`,
        data: data,
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
  const btn = document.getElementById("calcTradeBtn");

  if (!btn) {
    return;
  }

  btn.addEventListener("click", () => {
    const capital = parseFloat(
      document.getElementById("capitalInput").value
    );

    const priceText = document
      .getElementById("btcPrice")
      .textContent
      .replace(/[$,]/g, "");

    const btcPrice = parseFloat(priceText);

    if (!capital || !btcPrice) {
      document.getElementById("tradeResult").textContent =
        "Please enter capital and load BTC price first.";
      return;
    }

    const usdInr = 83;
    const btcPriceInr = btcPrice * usdInr;
    const qty = capital / btcPriceInr;

    document.getElementById("tradeResult").textContent =
      `With ₹${capital.toLocaleString()}, you can paper trade about ${qty.toFixed(6)} BTC at approx ₹${btcPriceInr.toLocaleString("en-IN", {
        maximumFractionDigits: 0
      })} per BTC.`;
  });
}

function setupUpload() {
  const input = document.getElementById("fileInput");

  if (!input) {
    return;
  }

  input.addEventListener("change", (event) => {
    const file = event.target.files[0];

    if (file) {
      document.getElementById("uploadStatus").textContent =
        `Uploaded file: ${file.name}`;
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

const refreshButton = document.getElementById("refreshBtn");

if (refreshButton) {
  refreshButton.addEventListener("click", loadBTCData);
}

const signalDate = document.getElementById("signal-date");

if (signalDate) {
  signalDate.textContent = formatDateForSignal();
}

setupPaperTrading();
setupUpload();
setupTimeframeButtons();
loadBTCData();
