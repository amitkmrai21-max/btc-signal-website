let btcChart;

async function loadBTCData() {
  try {
    const priceRes = await fetch("/api/btc/price");
    const priceData = await priceRes.json();

    const chartRes = await fetch("/api/btc/chart?days=7");
    const chartData = await chartRes.json();

    const btc = priceData.bitcoin;
    const price = btc.usd;
    const change = btc.usd_24h_change || 0;

    document.getElementById("btcPrice").textContent = `$${price.toLocaleString()}`;
    document.getElementById("btcChange").textContent = `${change.toFixed(2)}%`;

    let signal = "HOLD";
    let signalText = "Market is neutral. Wait for confirmation.";
    let signalColor = "#facc15";

    if (change > 1) {
      signal = "BUY";
      signalText = "AI signal says bullish momentum is active. Buy zone possible.";
      signalColor = "#22c55e";
    } else if (change < -1) {
      signal = "SELL";
      signalText = "AI signal says bearish pressure is high. Sell or avoid fresh entry.";
      signalColor = "#ef4444";
    }

    document.getElementById("signalBox").textContent = signal;
    document.getElementById("signalBox").style.color = signalColor;
    document.getElementById("aiSignalText").textContent = signalText;

    const labels = chartData.prices.map(item =>
      new Date(item[0]).toLocaleDateString()
    );
    const prices = chartData.prices.map(item => item[1]);

    renderChart(labels, prices);
  } catch (error) {
    document.getElementById("aiSignalText").textContent =
      "Error loading BTC data.";
    console.error(error);
  }
}

function renderChart(labels, data) {
  const ctx = document.getElementById("btcChart").getContext("2d");

  if (btcChart) {
    btcChart.destroy();
  }

  btcChart = new Chart(ctx, {
    type: "line",
    data: {
      labels: labels,
      datasets: [{
        label: "BTC/USD",
        data: data,
        borderColor: "#22c55e",
        backgroundColor: "rgba(34, 197, 94, 0.15)",
        borderWidth: 2,
        fill: true,
        tension: 0.3
      }]
    },
    options: {
      responsive: true,
      plugins: {
        legend: {
          labels: {
            color: "#ffffff"
          }
        }
      },
      scales: {
        x: {
          ticks: { color: "#cbd5e1" },
          grid: { color: "#1e293b" }
        },
        y: {
          ticks: { color: "#cbd5e1" },
          grid: { color: "#1e293b" }
        }
      }
    }
  });
}

function setupPaperTrading() {
  const btn = document.getElementById("calcTradeBtn");
  btn.addEventListener("click", () => {
    const capital = parseFloat(document.getElementById("capitalInput").value);
    const priceText = document.getElementById("btcPrice").textContent.replace(/[$,]/g, "");
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
      `With ₹${capital.toLocaleString()}, you can paper trade about ${qty.toFixed(6)} BTC at approx ₹${btcPriceInr.toLocaleString()} per BTC.`;
  });
}

function setupUpload() {
  const input = document.getElementById("fileInput");
  input.addEventListener("change", (event) => {
    const file = event.target.files[0];
    if (file) {
      document.getElementById("uploadStatus").textContent =
        `Uploaded file: ${file.name}`;
    }
  });
}

document.getElementById("refreshBtn").addEventListener("click", loadBTCData);

loadBTCData();
setupPaperTrading();
setupUpload();
const timeframeButtons = document.querySelectorAll(".timeframe-btn");

timeframeButtons.forEach((button) => {
  button.addEventListener("click", () => {
    timeframeButtons.forEach((item) => item.classList.remove("active"));
    button.classList.add("active");

    console.log(`Selected timeframe: ${button.dataset.timeframe}`);
  });
});
