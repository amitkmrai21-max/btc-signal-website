// ==========================================================================
// 1. GLOBAL STATE, CONSTANTS & CONFIGURATION
// ==========================================================================
let liveCandleChart = null;
let liveCandleSeries = null;
let liveChartSocket = null;
let liveChartTimeframe = "15m";
let latestVisibleCandle = null;
let activeAiLevelSeries = [];

let btcHistoryChart = null;
let rrgChartInstance = null;
let activeHistoryTimeframe = "1D";
let activeRrgTimeframe = "1d";

let currentBtcPriceUsd = null;
let currentBtcPriceInr = null;
const USD_INR_RATE = 83;

let isGeminiRunning = false;
let isGroqLiveRunning = false;
let isGroqNewsRunning = false;
let isTechnicalRefreshing = false;

const PAPER_STORAGE_KEY = "btcAiSignalPaperPortfolioV2";
const DEFAULT_PAPER_CASH = 100000;
const PAPER_MIN_TRADE_INR = 100;
const PAPER_EPSILON = 0.00000001;

const ALERT_SETTINGS_STORAGE_KEY = "btcAiSignalAlertSettingsV1";
const ALERT_RUNTIME_STORAGE_KEY = "btcAiSignalAlertRuntimeV1";
const LAYOUT_STORAGE_KEY = "btcAiSignalCustomLayoutV1";
const DASHBOARD_PREFS_KEY = "btcAiSignalDashboardPreferences";

const timeframeSettings = {
  "1W": { days: 90, interval: "1w", label: "Weekly", maxPoints: 20 },
  "1D": { days: 30, interval: "1d", label: "Daily", maxPoints: 31 },
  "1H": { days: 7, interval: "1h", label: "Hourly", maxPoints: 120 },
  "15M": { days: 1, interval: "15m", label: "15 Min", maxPoints: 120 }
};

// ==========================================================================
// 2. HELPER UTILITIES
// ==========================================================================
function getEl(id) { return document.getElementById(id); }
function setText(id, val) { const el = getEl(id); if (el) el.textContent = val ?? "--"; }
function formatUsd(val) { const n = Number(val); return Number.isFinite(n) ? `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : "--"; }
function formatInr(val) { const n = Number(val); return Number.isFinite(n) ? `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}` : "₹--"; }
function formatBtc(val) { const n = Number(val); return Number.isFinite(n) ? `${n.toFixed(6)} BTC` : "0.000000 BTC"; }
function formatPct(val) { const n = Number(val); return Number.isFinite(n) ? `${n >= 0 ? "+" : ""}${n.toFixed(2)}%` : "--"; }

function setSignalBadge(elementId, signal) {
  const badge = getEl(elementId);
  if (!badge) return;
  const s = String(signal || "HOLD").toUpperCase();
  badge.textContent = s;
  badge.className = `signal-badge badge-${s.toLowerCase()}`;
}

function setRiskBadge(elementId, risk) {
  const badge = getEl(elementId);
  if (!badge) return;
  const r = String(risk || "MEDIUM").toUpperCase();
  badge.textContent = r;
  badge.className = `risk-badge risk-${r.toLowerCase()}`;
}

// ==========================================================================
// 3. LIVE CANDLESTICK CHART (LIGHTWEIGHT CHARTS 4.2.3)
// ==========================================================================
function initLiveCandlestickChart() {
  const container = getEl("liveCandlestickChart");
  if (!container || liveCandleChart || typeof LightweightCharts === "undefined") return;

  const width = container.clientWidth > 50 ? container.clientWidth : 800;
  const height = window.innerWidth <= 720 ? 360 : 520;

  liveCandleChart = LightweightCharts.createChart(container, {
    width: width,
    height: height,
    layout: {
      background: { color: "#07111f" },
      textColor: "#cbd5e1",
      fontFamily: "Arial, sans-serif"
    },
    grid: {
      vertLines: { color: "rgba(148, 163, 184, 0.12)" },
      horzLines: { color: "rgba(148, 163, 184, 0.12)" }
    },
    rightPriceScale: { borderColor: "rgba(148, 163, 184, 0.22)" },
    timeScale: {
      borderColor: "rgba(148, 163, 184, 0.22)",
      timeVisible: true,
      secondsVisible: false,
      rightOffset: 25
    },
    crosshair: { mode: LightweightCharts.CrosshairMode.Normal }
  });

  liveCandleSeries = liveCandleChart.addCandlestickSeries({
    upColor: "#22c55e",
    downColor: "#ef4444",
    borderVisible: false,
    wickUpColor: "#4ade80",
    wickDownColor: "#f87171"
  });

  new ResizeObserver((entries) => {
    if (!entries[0] || !liveCandleChart) return;
    const nextWidth = entries[0].contentRect.width;
    if (nextWidth > 50) {
      liveCandleChart.applyOptions({
        width: nextWidth,
        height: window.innerWidth <= 720 ? 360 : 520
      });
    }
  }).observe(container);
}

async function loadLiveCandles() {
  initLiveCandlestickChart();
  setText("liveChartStatus", `Loading ${liveChartTimeframe} candles from Binance...`);

  try {
    const res = await fetch(`/api/btc/candles?interval=${liveChartTimeframe}&limit=200`, { cache: "no-store" });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || "Failed to load candles.");

    const candles = Array.isArray(data.candles) ? data.candles : [];
    if (!candles.length) throw new Error("No candle data received.");

    if (liveCandleSeries) {
      liveCandleSeries.setData(candles.map(c => ({
        time: Number(c.time),
        open: Number(c.open),
        high: Number(c.high),
        low: Number(c.low),
        close: Number(c.close)
      })));
    }

    latestVisibleCandle = candles[candles.length - 1];
    setText("liveChartTimeframe", liveChartTimeframe);
    setText("liveChartPrice", formatUsd(latestVisibleCandle.close));
    setText("liveChartCandle", `Live • O ${formatUsd(latestVisibleCandle.open)} • H ${formatUsd(latestVisibleCandle.high)} • L ${formatUsd(latestVisibleCandle.low)}`);
    setText("liveChartStatus", `Binance live connected • ${new Date().toLocaleTimeString()}`);

    const connBadge = getEl("liveChartConnection");
    if (connBadge) {
      connBadge.textContent = "Live Connected";
      connBadge.className = "live-chart-connection live-live";
    }

    connectLiveCandleStream();
  } catch (err) {
    console.error("Candle history error:", err);
    setText("liveChartStatus", `Candle error: ${err.message}`);
  }
}

function connectLiveCandleStream() {
  if (liveChartSocket) {
    liveChartSocket.close();
    liveChartSocket = null;
  }

  const stream = `btcusdt@kline_${liveChartTimeframe}`;
  try {
    liveChartSocket = new WebSocket(`wss://stream.binance.com:9443/ws/${stream}`);
    liveChartSocket.onmessage = (event) => {
      const payload = JSON.parse(event.data);
      const k = payload?.k;
      if (!k || !liveCandleSeries) return;

      const candle = {
        time: Math.floor(Number(k.t) / 1000),
        open: Number(k.o),
        high: Number(k.h),
        low: Number(k.l),
        close: Number(k.c)
      };

      liveCandleSeries.update(candle);
      latestVisibleCandle = candle;
      setText("liveChartPrice", formatUsd(candle.close));
      setText("liveChartCandle", `${k.x ? "Closed" : "Live"} • O ${formatUsd(candle.open)} • H ${formatUsd(candle.high)} • L ${formatUsd(candle.low)}`);
    };
  } catch (e) {
    console.warn("WebSocket stream error:", e);
  }
}

// ==========================================================================
// 4. FUTURE-ONLY AI OVERLAY RENDERER (2-POINT LINE SERIES)
// ==========================================================================
function renderLatestAiChartOverlay(aiData, provider) {
  clearLatestAiChartOverlay();
  if (!liveCandleChart || !latestVisibleCandle || typeof LightweightCharts === "undefined") return;

  const signal = String(aiData?.signal || "HOLD").toUpperCase();
  if (signal === "HOLD" || !aiData?.overlay_allowed) {
    return;
  }

  const secondsPerCandle = {
    "1m": 60, "5m": 300, "15m": 900, "1h": 3600,
    "4h": 14400, "1d": 86400, "1w": 604800
  }[liveChartTimeframe] || 900;

  const startTime = Number(latestVisibleCandle.time);
  const endTime = startTime + (secondsPerCandle * 40);

  const levels = [
    { title: `${provider} ENTRY`, price: Number(aiData.entry_price), color: signal === "BUY" ? "#22c55e" : "#ef4444" },
    { title: `${provider} STOP LOSS`, price: Number(aiData.stop_loss_price), color: "#ef4444" },
    { title: `${provider} TARGET 1`, price: Number(aiData.target_1_price), color: "#facc15" },
    { title: `${provider} TARGET 2`, price: Number(aiData.target_2_price), color: "#a78bfa" }
  ];

  levels.forEach(lvl => {
    if (lvl.price > 0) {
      const line = liveCandleChart.addLineSeries({
        color: lvl.color,
        lineWidth: 2,
        lineStyle: LightweightCharts.LineStyle.Dashed,
        lastValueVisible: true,
        priceLineVisible: false,
        crosshairMarkerVisible: false,
        title: lvl.title
      });
      line.setData([
        { time: startTime, value: lvl.price },
        { time: endTime, value: lvl.price }
      ]);
      activeAiLevelSeries.push(line);
    }
  });

  liveCandleChart.timeScale().applyOptions({ rightOffset: 35 });
}

function clearLatestAiChartOverlay() {
  if (liveCandleChart && activeAiLevelSeries.length) {
    activeAiLevelSeries.forEach(series => {
      try { liveCandleChart.removeSeries(series); } catch (e) {}
    });
    activeAiLevelSeries = [];
  }
}

// ==========================================================================
// 5. INDEPENDENT CARDS RENDERERS
// ==========================================================================
function renderEngineCard(data) {
  setSignalBadge("engineSignalBox", data?.signal || "HOLD");
  setText("signalBox", data?.signal || "HOLD");
  setRiskBadge("engineRiskBadge", data?.risk || "MEDIUM");
  setText("engineQuality", `${data?.confidence || 0}%`);
  setText("engineUpdatedAt", new Date().toLocaleTimeString());
  setText("engineReason", data?.reason || "--");
  setText("engineEntry", data?.entry_idea || "--");
  setText("engineStopLoss", data?.stop_loss_idea || "--");
  setText("engineTarget1", data?.target_1 || "--");
  setText("engineTarget2", data?.target_2 || "--");
}

function renderGeminiCard(data) {
  setSignalBadge("geminiSignalAction", data?.signal || "--");
  setRiskBadge("geminiRiskBadge", data?.risk || "--");
  setText("geminiConfidence", `${data?.confidence || 0}%`);
  setText("geminiUpdatedAt", new Date().toLocaleTimeString());
  setText("geminiReason", data?.reason || "--");
  setText("geminiEntry", data?.entry_idea || "--");
  setText("geminiStopLoss", data?.stop_loss_idea || "--");
  setText("geminiTarget1", data?.target_1 || "--");
  setText("geminiTarget2", data?.target_2 || "--");
}

function renderGroqCard(data) {
  setSignalBadge("groqSignalAction", data?.signal || "--");
  setRiskBadge("groqRiskBadge", data?.risk || "--");
  setText("groqConfidence", `${data?.confidence || 0}%`);
  setText("groqUpdatedAt", new Date().toLocaleTimeString());
  setText("groqReason", data?.reason || "--");
  setText("groqEntry", data?.entry_idea || "--");
  setText("groqStopLoSS", data?.stop_loss_idea || "--");
  setText("groqTarget1", data?.target_1 || "--");
  setText("groqTarget2", data?.target_2 || "--");
}

// ==========================================================================
// 6. API ACTIONS & AUTO-REFRESH LOOPS
// ==========================================================================
async function refreshLivePrice() {
  try {
    const res = await fetch("/api/btc/price", { cache: "no-store" });
    const data = await res.json();
    if (!res.ok) return;
    const p = Number(data?.bitcoin?.usd);
    const chg = Number(data?.bitcoin?.usd_24h_change || 0);
    currentBtcPriceUsd = p;
    currentBtcPriceInr = p * USD_INR_RATE;
    setText("btcPrice", formatUsd(p));
    setText("btcChange", formatPct(chg));
    const chgEl = getEl("btcChange");
    if (chgEl) chgEl.style.color = chg >= 0 ? "#22c55e" : "#ef4444";
    setText("marketUpdatedAt", `Live price updated: ${new Date().toLocaleTimeString()}`);
    renderPaperTrading();
    checkPriceAlerts(p);
  } catch (err) {
    console.error("Price fetch error:", err);
  }
}

async function refreshTechnicalAnalysis() {
  if (isTechnicalRefreshing) return;
  isTechnicalRefreshing = true;
  setText("technicalRefreshStatus", "Refreshing deterministic technical model...");

  try {
    const res = await fetch("/api/technical-signal?force_refresh=true", { cache: "no-store" });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || "Technical refresh failed.");

    renderEngineCard(data);
    renderTechnicalIntelligence(data);
    renderSwingFailureStructure(data);
    renderSetupQuality(data);
    checkTechnicalAlerts(data);
    setText("technicalRefreshStatus", `Updated: ${new Date().toLocaleTimeString()}`);
  } catch (err) {
    console.error("Technical engine error:", err);
    setText("technicalRefreshStatus", `Engine error: ${err.message}`);
  } finally {
    isTechnicalRefreshing = false;
  }
}

async function runGeminiAnalysis() {
  if (isGeminiRunning) return;
  const btn = getEl("geminiAiBtn");
  isGeminiRunning = true;
  if (btn) { btn.disabled = true; btn.textContent = "Running Gemini AI..."; }
  setText("geminiReason", "Gemini AI is reading live Binance indicators and structure...");

  try {
    const res = await fetch("/api/ai-signal/run", { method: "POST", cache: "no-store" });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || "Gemini analysis failed.");

    renderGeminiCard(data);
    renderLatestAiChartOverlay(data, "GEMINI");
  } catch (err) {
    console.error("Gemini error:", err);
    setText("geminiReason", `Gemini review unavailable: ${err.message}`);
  } finally {
    isGeminiRunning = false;
    if (btn) { btn.disabled = false; btn.textContent = "Run Gemini AI Analysis"; }
  }
}

async function runGroqLiveAnalysis() {
  if (isGroqLiveRunning) return;
  const btn = getEl("groqLiveBtn");
  isGroqLiveRunning = true;
  if (btn) { btn.disabled = true; btn.textContent = "Running Groq Live Analysis..."; }
  setText("groqReason", "Groq AI is analyzing market structure and generating levels...");

  try {
    const res = await fetch("/api/groq-live-analysis", { method: "POST", cache: "no-store" });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || "Groq analysis failed.");

    renderGroqCard(data);
    renderLatestAiChartOverlay(data, "GROQ");
  } catch (err) {
    console.error("Groq chart error:", err);
    setText("groqReason", `Groq analysis unavailable: ${err.message}`);
  } finally {
    isGroqLiveRunning = false;
    if (btn) { btn.disabled = false; btn.textContent = "Run Groq Live Chart Analysis"; }
  }
}

async function runGroqNews() {
  if (isGroqNewsRunning) return;
  const btn = getEl("groqNewsBtn");
  isGroqNewsRunning = true;
  if (btn) { btn.disabled = true; btn.textContent = "Refreshing News..."; }

  try {
    const res = await fetch("/api/groq-news", { method: "POST", cache: "no-store" });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || "Groq news failed.");

    renderGroqNewsUI(data);
  } catch (err) {
    console.error("Groq news error:", err);
    setText("geminiNewsOverview", `News unavailable: ${err.message}`);
  } finally {
    isGroqNewsRunning = false;
    if (btn) { btn.disabled = false; btn.textContent = "Refresh News with Groq"; }
  }
}

function renderGroqNewsUI(data) {
  setText("geminiNewsOverview", data?.news_overview || "--");
  setText("geminiNewsUpdated", `Last updated: ${new Date().toLocaleTimeString()}`);
  const bias = getEl("geminiNewsBias");
  if (bias) {
    bias.textContent = `News bias: ${data?.news_market_bias || "NEUTRAL"}`;
    bias.className = `news-bias-badge news-impact-${String(data?.news_market_bias || "neutral").toLowerCase()}`;
  }

  const container = getEl("geminiNewsList");
  if (!container) return;
  container.innerHTML = "";

  const items = Array.isArray(data?.news) ? data.news : [];
  if (!items.length) {
    container.innerHTML = '<p class="gemini-news-empty">No RSS headlines found.</p>';
    return;
  }

  items.forEach(item => {
    const card = document.createElement("article");
    card.className = "gemini-news-item";
    
    card.innerHTML = `
      <div class="gemini-news-item-top">
        <span class="gemini-news-source">${item.source || "News"}</span>
        <span class="news-impact-badge news-impact-neutral">RSS</span>
      </div>
      <h3>${item.headline || ""}</h3>
      <p class="gemini-news-summary">${item.summary || ""}</p>
      
      <div class="gemini-news-translation" hidden>
        <h4>हिंदी अनुवाद</h4>
        <p class="gemini-news-hi-headline"></p>
        <p class="gemini-news-hi-summary"></p>
      </div>

      <div class="gemini-news-actions">
        <button class="translate-news-btn" type="button">हिंदी में पढ़ें</button>
        <span class="translation-status" aria-live="polite"></span>
      </div>

      ${item.url ? `<a class="gemini-news-link" href="${item.url}" target="_blank" rel="noopener">Read original article ↗</a>` : ""}
    `;

    const translateBtn = card.querySelector(".translate-news-btn");
    const transBox = card.querySelector(".gemini-news-translation");
    const transStatus = card.querySelector(".translation-status");
    const hiHeadline = card.querySelector(".gemini-news-hi-headline");
    const hiSummary = card.querySelector(".gemini-news-hi-summary");

    translateBtn?.addEventListener("click", async () => {
      if (!transBox.hidden) {
        transBox.hidden = true;
        translateBtn.textContent = "हिंदी में पढ़ें";
        transStatus.textContent = "";
        return;
      }

      translateBtn.disabled = true;
      transStatus.textContent = "Translating...";
      try {
        const res = await fetch("/api/news/translate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ headline: item.headline, summary: item.summary, source: item.source })
        });
        const transData = await res.json();
        if (!res.ok) throw new Error("Translation failed.");

        hiHeadline.textContent = transData.headline_hi || item.headline;
        hiSummary.textContent = transData.summary_hi || item.summary;
        transBox.hidden = false;
        translateBtn.textContent = "हिंदी छुपाएं";
        transStatus.textContent = "";
      } catch (e) {
        transStatus.textContent = "Translation unavailable.";
      } finally {
        translateBtn.disabled = false;
      }
    });

    container.appendChild(card);
  });
}

// ==========================================================================
// 7. TECHNICAL PANELS (INTELLIGENCE, SWING, CHECKLIST)
// ==========================================================================
function renderTechnicalIntelligence(data) {
  const health = data?.data_health || {}, score = data?.score_breakdown || {}, regime = data?.market_regime || {}, agreement = data?.timeframe_agreement || {};
  setText("marketRegime", regime.label || "--");
  setText("marketRegimeDetail", regime.detail || "--");
  setText("regimeStats", `ADX ${regime.average_adx ?? "--"} • ATR ${regime.average_atr_percent ?? "--"}% • BB ${regime.average_bollinger_width_percent ?? "--"}%`);

  const pct = Number(agreement.percent);
  setText("timeframeAgreement", Number.isFinite(pct) ? `${pct.toFixed(0)}%` : "--");
  setText("timeframeAgreementDetail", agreement.direction || "--");
  setText("timeframeVotes", `Bullish ${agreement.bullish_votes ?? 0} • Bearish ${agreement.bearish_votes ?? 0} • Hold ${agreement.hold_votes ?? 0}`);

  const bar = getEl("timeframeAgreementBar");
  if (bar) bar.style.width = `${Number.isFinite(pct) ? Math.max(0, Math.min(100, pct)) : 0}%`;

  setText("scoreTrend", score?.trend?.score ?? "--");
  setText("scoreMacd", score?.macd?.score ?? "--");
  setText("scoreMomentum", score?.momentum?.score ?? "--");
  setText("scoreBreakout", score?.breakout?.score ?? "--");
  setText("scoreVolume", score?.volume?.score ?? "--");
  setText("technicalScoreTotal", `${score?.total_score ?? "--"} / 9`);
  setText("technicalAlignment", `${score?.technical_alignment_percent ?? "--"}% alignment`);
  setText("technicalScoreBias", score?.bias || "--");

  const healthBadge = getEl("technicalDataHealth");
  if (healthBadge) {
    healthBadge.textContent = `Data: ${health.status || "LIVE"}`;
    healthBadge.className = `data-health-badge health-${String(health.status || "live").toLowerCase()}`;
  }
  setText("technicalHealthMessage", health.message || "Binance data stream active.");
}

function renderSwingFailureStructure(data) {
  const s = data?.market_data?.timeframes?.["15m"]?.swing_failure_structure || {};
  setText("swingTimeframe", s.timeframe || "15m");
  setText("swingCurrentPrice", formatUsd(s.current_price));
  setText("swingPriorHigh", formatUsd(s.prior_swing_high));
  setText("swingPriorLow", formatUsd(s.prior_swing_low));
  setText("swingFailedLevel", s.break_event || "No confirmed break");
  setText("swingProtectedLevel", formatUsd(s.protected_break_level));
  setText("swingBreakLevel", s.break_level_text || "--");
  setText("swingBreakStatus", s.break_status || "INSIDE RANGE");
  setText("swingRetestLevel", formatUsd(s.retest_level));
  setText("swingInvalidationLevel", formatUsd(s.invalidation_level));
  setText("swingStructureReason", s.reason || "--");
  setText("swingFinalConclusion", s.final_conclusion || "--");

  const filter = s.filter_checklist || {};
  const passed = Array.isArray(filter.passed) ? filter.passed.length : 0;
  const waiting = Array.isArray(filter.waiting) ? filter.waiting.length : 0;
  const failed = Array.isArray(filter.failed) ? filter.failed.length : 0;
  setText("swingFilterSummary", `Quality: ${s.quality || "LOW"} • Passed ${passed} • Pending ${waiting} • Failed ${failed}`);

  const badge = getEl("swingSignalBadge");
  if (badge) {
    const sig = String(s.signal || "HOLD").toUpperCase();
    badge.textContent = sig;
    badge.className = `swing-signal-badge swing-${sig === "BUY" ? "bullish" : sig === "SELL" ? "bearish" : "neutral"}`;
  }
}

function renderSetupQuality(data) {
  const sq = data?.setup_quality || {};
  setText("setupGrade", sq.grade || "--");
  setText("setupScore", `${sq.score?.passed ?? 0} / ${sq.score?.total ?? 8} passed`);
  setText("setupDirection", sq.direction || "--");
  setText("setupDecisionReason", sq.decision_reason || "--");
  setText("setupRiskFlagCount", sq.risk_flags?.length ? `${sq.risk_flags.length} Flags` : "0 Flags");
  setText("setupRiskFlags", sq.risk_flags?.length ? sq.risk_flags.join(" • ") : "No major technical risk flags detected.");

  const badge = getEl("setupExecutionState");
  if (badge) {
    badge.textContent = sq.execution_state || "WAIT";
    badge.className = `setup-execution-badge setup-state-${String(sq.execution_state || "wait").toLowerCase().replace(/[^a-z]+/g, "-")}`;
  }

  const list = getEl("setupChecklist");
  if (!list) return;
  list.innerHTML = "";
  const items = Array.isArray(sq.items) ? sq.items : [];
  items.forEach(item => {
    const div = document.createElement("article");
    div.className = `setup-check-item setup-check-${String(item.state || "wait").toLowerCase()}`;
    div.innerHTML = `
      <div class="setup-check-top">
        <h3>${item.label}</h3>
        <span class="setup-check-state">${item.state}</span>
      </div>
      <p>${item.reason}</p>
    `;
    list.appendChild(div);
  });
}

// ==========================================================================
// 8. HISTORICAL CHART & RRG ROTATION
// ==========================================================================
async function loadHistoricalBtcChart() {
  if (typeof Chart === "undefined") return;
  const selected = timeframeSettings[activeHistoryTimeframe] || timeframeSettings["1D"];
  try {
    const res = await fetch(`/api/btc/chart?days=${selected.days}&interval=${selected.interval}`, { cache: "no-store" });
    const data = await res.json();
    if (!res.ok) return;

    const prices = Array.isArray(data.prices) ? data.prices : [];
    const canvas = getEl("btcChart");
    if (!canvas) return;

    if (btcHistoryChart) btcHistoryChart.destroy();
    btcHistoryChart = new Chart(canvas.getContext("2d"), {
      type: "line",
      data: {
        labels: prices.map(p => new Date(p[0]).toLocaleDateString("en-IN", { month: "short", day: "numeric" })),
        datasets: [{
          label: "BTC/USD",
          data: prices.map(p => p[1]),
          borderColor: "#22c55e",
          backgroundColor: "rgba(34, 197, 94, 0.12)",
          fill: true,
          tension: 0.2,
          pointRadius: 0
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { ticks: { color: "#cbd5e1", maxTicksLimit: 7 }, grid: { color: "#1e293b" } },
          y: { ticks: { color: "#cbd5e1" }, grid: { color: "#1e293b" } }
        }
      }
    });
  } catch (e) {
    console.error("Historical chart error:", e);
  }
}

async function loadRrg() {
  if (typeof Chart === "undefined") return;
  const status = getEl("rrgStatus");
  if (status) status.textContent = `Loading ${activeRrgTimeframe} RRG-style data...`;
  try {
    const res = await fetch(`/api/rrg?interval=${activeRrgTimeframe}`, { cache: "no-store" });
    const data = await res.json();
    if (!res.ok) throw new Error("RRG API failed");
    renderRrgChart(data);
    if (status) status.textContent = `RRG updated: ${new Date().toLocaleTimeString()}`;
  } catch (e) {
    console.error("RRG error:", e);
    if (status) status.textContent = "RRG chart unavailable.";
  }
}

function renderRrgChart(data) {
  const canvas = getEl("rrgChart");
  if (!canvas || !Array.isArray(data?.trails) || typeof Chart === "undefined") return;
  if (rrgChartInstance) rrgChartInstance.destroy();

  const colors = {
    BTCUSDT: "#facc15",
    ETHUSDT: "#60a5fa",
    SOLUSDT: "#a78bfa"
  };

  const datasets = data.trails.map(t => ({
    label: t.symbol.replace("USDT", ""),
    data: (t.points || []).map(p => ({ x: Number(p.x), y: Number(p.y) })),
    borderColor: colors[t.symbol] || "#fff",
    backgroundColor: colors[t.symbol] || "#fff",
    borderWidth: 2,
    showLine: true,
    tension: 0
  }));

  rrgChartInstance = new Chart(canvas.getContext("2d"), {
    type: "scatter",
    data: { datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { labels: { color: "#fff" } } },
      scales: {
        x: { title: { display: true, text: "Relative Strength Ratio", color: "#cbd5e1" }, ticks: { color: "#cbd5e1" }, grid: { color: "#334155" } },
        y: { title: { display: true, text: "Relative Strength Momentum", color: "#cbd5e1" }, ticks: { color: "#cbd5e1" }, grid: { color: "#334155" } }
      }
    }
  });
}

// ==========================================================================
// 9. PAPER TRADING (INR LONG & SHORT)
// ==========================================================================
function loadPaperPortfolio() {
  try {
    const raw = localStorage.getItem(PAPER_STORAGE_KEY);
    return raw ? JSON.parse(raw) : { cashInr: DEFAULT_PAPER_CASH, btcHolding: 0, totalCostInr: 0, shortBtcHolding: 0, shortProceedsInr: 0, history: [] };
  } catch (e) {
    return { cashInr: DEFAULT_PAPER_CASH, btcHolding: 0, totalCostInr: 0, shortBtcHolding: 0, shortProceedsInr: 0, history: [] };
  }
}

function savePaperPortfolio(p) {
  try { localStorage.setItem(PAPER_STORAGE_KEY, JSON.stringify(p)); } catch (e) {}
}

function renderPaperTrading() {
  const p = loadPaperPortfolio();
  const mark = Number(currentBtcPriceInr) || 0;
  const val = p.cashInr + (p.btcHolding * mark) - (p.shortBtcHolding * mark);
  const pnl = val - DEFAULT_PAPER_CASH;

  setText("paperCash", formatInr(p.cashInr));
  setText("paperBtcHolding", formatBtc(p.btcHolding));
  setText("paperShortBtcHolding", formatBtc(p.shortBtcHolding));
  setText("paperPortfolioValue", formatInr(val));

  const pos = p.btcHolding > PAPER_EPSILON ? "LONG BTC" : p.shortBtcHolding > PAPER_EPSILON ? "SHORT BTC" : "No open position";
  setText("paperPositionType", pos);

  const pnlEl = getEl("paperPnl");
  if (pnlEl) {
    pnlEl.textContent = `${pnl >= 0 ? "+" : ""}${formatInr(pnl)}`;
    pnlEl.style.color = pnl >= 0 ? "#22c55e" : "#ef4444";
  }

  const hist = getEl("paperTradeHistory");
  if (hist && p.history) {
    hist.innerHTML = p.history.length ? "" : "No virtual trades yet.";
    p.history.slice(0, 10).forEach(t => {
      const item = document.createElement("div");
      item.className = `history-item ${t.type.includes("SELL") ? "history-sell" : "history-buy"}`;
      item.textContent = `${t.type} • ${formatInr(t.amountInr)} • ${formatBtc(t.btcAmount)} • ${new Date(t.timestamp).toLocaleTimeString()}`;
      hist.appendChild(item);
    });
  }
}

function executePaperTrade(isBuy) {
  const input = getEl("paperAmountInput");
  const amount = Number(input?.value);
  if (!currentBtcPriceInr || !amount || amount < PAPER_MIN_TRADE_INR) {
    setText("paperTradeStatus", "Enter a valid amount of at least ₹100.");
    return;
  }

  const p = loadPaperPortfolio();
  const btc = amount / currentBtcPriceInr;

  if (isBuy) {
    if (p.cashInr < amount) { setText("paperTradeStatus", "Not enough cash."); return; }
    p.cashInr -= amount;
    p.btcHolding += btc;
    p.history.unshift({ type: "BUY LONG", amountInr: amount, btcAmount: btc, timestamp: Date.now() });
  } else {
    if (p.btcHolding < btc) { setText("paperTradeStatus", "Not enough BTC to sell."); return; }
    p.cashInr += amount;
    p.btcHolding -= btc;
    p.history.unshift({ type: "SELL LONG", amountInr: amount, btcAmount: btc, timestamp: Date.now() });
  }

  savePaperPortfolio(p);
  if (input) input.value = "";
  setText("paperTradeStatus", `Trade executed at ${formatInr(currentBtcPriceInr)}/BTC.`);
  renderPaperTrading();
}

// ==========================================================================
// 10. BROWSER ALERTS & PRICE WATCH
// ==========================================================================
function checkPriceAlerts(price) {
  const above = Number(getEl("priceAboveInput")?.value);
  const below = Number(getEl("priceBelowInput")?.value);
  if (above && price >= above) {
    sendBrowserAlert("BTC Price Alert", `BTC crossed above $${above}! Current: $${price}`);
  }
  if (below && price <= below) {
    sendBrowserAlert("BTC Price Alert", `BTC dropped below $${below}! Current: $${price}`);
  }
}

function checkTechnicalAlerts(data) {
  setText("alertCurrentBtcPrice", formatUsd(currentBtcPriceUsd));
  setText("alertTechnicalWatchStatus", `${data?.signal || "HOLD"} (Risk: ${data?.risk || "MEDIUM"})`);
}

function sendBrowserAlert(title, body) {
  setText("lastAlertStatus", `${title}: ${body} (${new Date().toLocaleTimeString()})`);
  if ("Notification" in window && Notification.permission === "granted") {
    new Notification(title, { body, icon: "/frontend/image-1.png" });
  }
}

// ==========================================================================
// 11. SCREENSHOT ANALYSER (GEMINI AI)
// ==========================================================================
function setupChartAnalyser() {
  const input = getEl("chartImageInput");
  const btn = getEl("analyseChartBtn");
  const preview = getEl("chartImagePreview");
  const resultBox = getEl("chartAnalysisResult");

  input?.addEventListener("change", () => {
    const file = input.files[0];
    if (file) {
      preview.src = URL.createObjectURL(file);
      preview.hidden = false;
      setText("chartAnalyseStatus", `Selected: ${file.name}`);
    }
  });

  btn?.addEventListener("click", async () => {
    const file = input.files[0];
    if (!file) return;
    const form = new FormData();
    form.append("file", file);
    btn.disabled = true;
    btn.textContent = "Analysing...";

    try {
      const res = await fetch("/api/chart-analyser", { method: "POST", body: form });
      const data = await res.json();
      if (!res.ok) throw new Error(data.detail || "Analysis failed.");

      setSignalBadge("uploadedChartSignal", data.signal);
      setText("uploadedChartConfidence", `Confidence: ${data.confidence}%`);
      setText("uploadedChartRisk", data.risk);
      setText("uploadedChartTrend", data.trend);
      setText("uploadedChartPattern", data.pattern);
      setText("uploadedChartSupport", data.support);
      setText("uploadedChartResistance", data.resistance);
      setText("uploadedChartReason", data.reason);
      setText("uploadedChartEntry", data.entry_idea);
      setText("uploadedChartInvalidation", data.invalidation_idea);
      setText("uploadedChartWarning", data.warning);
      resultBox.hidden = false;
    } catch (e) {
      console.error(e);
      setText("chartAnalyseStatus", `Error: ${e.message}`);
    } finally {
      btn.disabled = false;
      btn.textContent = "Analyse with Gemini AI";
    }
  });
}

// ==========================================================================
// 12. LAYOUT EDITOR (DRAG & DROP + HEIGHT RESIZE)
// ==========================================================================
function setupLayoutEditor() {
  const container = getEl("customizableSections");
  const editBtn = getEl("editLayoutBtn");
  const saveBtn = getEl("saveLayoutBtn");
  const resetBtn = getEl("resetLayoutBtn");
  if (!container || !editBtn || !saveBtn || !resetBtn) return;

  let editMode = false;
  let dragged = null;

  const cards = () => [...container.querySelectorAll(":scope > .layout-editable")];
  const setHeight = (card, h) => {
    card.classList.remove("layout-height-compact", "layout-height-normal", "layout-height-tall");
    card.classList.add(`layout-height-${h}`);
  };

  const addToolbar = (card) => {
    if (card.querySelector(".layout-editor-toolbar")) return;
    const bar = document.createElement("div");
    bar.className = "layout-editor-toolbar";
    bar.innerHTML = `
      <button class="layout-editor-btn layout-drag-handle" type="button">Move</button>
      <button class="layout-editor-btn" type="button" data-height="compact">Compact</button>
      <button class="layout-editor-btn" type="button" data-height="normal">Normal</button>
      <button class="layout-editor-btn" type="button" data-height="tall">Tall</button>
    `;
    card.prepend(bar);
    bar.querySelectorAll("[data-height]").forEach(b => {
      b.addEventListener("click", (e) => {
        e.preventDefault(); e.stopPropagation();
        setHeight(card, b.dataset.height);
      });
    });
  };

  const enableDrag = (card) => {
    if (card.dataset.layoutDragReady) return;
    card.dataset.layoutDragReady = "true";
    card.addEventListener("dragstart", (e) => {
      if (!editMode) { e.preventDefault(); return; }
      dragged = card;
      card.classList.add("is-dragging");
      e.dataTransfer.effectAllowed = "move";
    });
    card.addEventListener("dragend", () => {
      card.classList.remove("is-dragging");
      cards().forEach(c => c.classList.remove("drag-over"));
      dragged = null;
    });
    card.addEventListener("dragover", (e) => {
      if (!editMode || !dragged || dragged === card) return;
      e.preventDefault();
      card.classList.add("drag-over");
    });
    card.addEventListener("dragleave", () => card.classList.remove("drag-over"));
    card.addEventListener("drop", (e) => {
      if (!editMode || !dragged || dragged === card) return;
      e.preventDefault();
      const box = card.getBoundingClientRect();
      container.insertBefore(dragged, e.clientY > box.top + box.height / 2 ? card.nextSibling : card);
      card.classList.remove("drag-over");
    });
  };

  const toggleMode = (on) => {
    editMode = on;
    container.classList.toggle("layout-edit-mode", on);
    cards().forEach(card => {
      addToolbar(card);
      enableDrag(card);
      card.draggable = on;
      if (!on) card.classList.remove("is-dragging", "drag-over");
    });
    editBtn.hidden = on;
    saveBtn.hidden = !on;
    resetBtn.hidden = !on;
  };

  editBtn.addEventListener("click", () => toggleMode(true));
  saveBtn.addEventListener("click", () => {
    const data = cards().map(c => ({
      id: c.dataset.layoutId,
      height: ["compact", "normal", "tall"].find(h => c.classList.contains(`layout-height-${h}`)) || "normal"
    }));
    localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(data));
    toggleMode(false);
  });
  resetBtn.addEventListener("click", () => {
    localStorage.removeItem(LAYOUT_STORAGE_KEY);
    window.location.reload();
  });

  try {
    const saved = JSON.parse(localStorage.getItem(LAYOUT_STORAGE_KEY) || "[]");
    if (Array.isArray(saved) && saved.length) {
      saved.forEach(item => {
        const card = container.querySelector(`:scope > .layout-editable[data-layout-id="${item.id}"]`);
        if (card) {
          container.appendChild(card);
          setHeight(card, item.height || "normal");
        }
      });
    }
  } catch (e) {}
}

// ==========================================================================
// 13. PREFERENCES & SETTINGS DRAWER (THEMES, ACCENTS, SIZES)
// ==========================================================================
function setupPreferences() {
  const drawer = getEl("settingsDrawer");
  const menuBtn = getEl("settingsMenuButton");
  const closeBtn = getEl("settingsCloseButton");
  const nameInput = getEl("userNameInput");
  const saveNameBtn = getEl("saveUserNameBtn");
  const resetBtn = getEl("resetSettingsBtn");

  const themeBtns = document.querySelectorAll("[data-theme-choice]");
  const accentBtns = document.querySelectorAll("[data-accent-choice]");
  const sizeBtns = document.querySelectorAll("[data-text-size-choice]");

  const apply = (p) => {
    document.body.dataset.theme = p.theme || "dark";
    document.body.dataset.accent = p.accent || "blue";
    document.body.dataset.textSize = p.textSize || "normal";
    if (nameInput && p.name) nameInput.value = p.name;

    themeBtns.forEach(b => b.classList.toggle("active", b.dataset.themeChoice === p.theme));
    accentBtns.forEach(b => b.classList.toggle("active", b.dataset.accentChoice === p.accent));
    sizeBtns.forEach(b => b.classList.toggle("active", b.dataset.textSizeChoice === p.textSize));
  };

  const getSaved = () => {
    try { return JSON.parse(localStorage.getItem(DASHBOARD_PREFS_KEY) || "{}"); } catch (e) { return {}; }
  };
  const save = (p) => {
    try { localStorage.setItem(DASHBOARD_PREFS_KEY, JSON.stringify(p)); } catch (e) {}
  };

  let current = getSaved();
  apply(current);

  menuBtn?.addEventListener("click", () => drawer?.classList.add("open"));
  closeBtn?.addEventListener("click", () => drawer?.classList.remove("open"));

  themeBtns.forEach(b => b.addEventListener("click", () => {
    current.theme = b.dataset.themeChoice; apply(current); save(current);
  }));
  accentBtns.forEach(b => b.addEventListener("click", () => {
    current.accent = b.dataset.accentChoice; apply(current); save(current);
  }));
  sizeBtns.forEach(b => b.addEventListener("click", () => {
    current.textSize = b.dataset.textSizeChoice; apply(current); save(current);
  }));

  saveNameBtn?.addEventListener("click", () => {
    current.name = nameInput?.value.trim() || ""; apply(current); save(current);
  });
  resetBtn?.addEventListener("click", () => {
    localStorage.removeItem(DASHBOARD_PREFS_KEY);
    current = { theme: "dark", accent: "blue", textSize: "normal", name: "" };
    apply(current);
  });
}

// ==========================================================================
// 14. INITIALIZATION & EVENT LISTENERS
// ==========================================================================
document.addEventListener("DOMContentLoaded", () => {
  // Navigation Tabs with Safe Canvas Resize
  document.querySelectorAll(".app-tab").forEach(tab => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".app-tab").forEach(t => t.classList.remove("active"));
      tab.classList.add("active");
      const target = tab.dataset.tab;
      document.querySelectorAll(".tab-panel").forEach(p => {
        p.classList.toggle("active", p.dataset.panel === target);
      });
      if (target === "live-chart") {
        setTimeout(() => {
          initLiveCandlestickChart();
          if (liveCandleChart) {
            const containerWidth = getEl("liveCandlestickChart")?.clientWidth || 800;
            liveCandleChart.applyOptions({ width: containerWidth });
            liveCandleChart.timeScale().fitContent();
          }
        }, 120);
      }
    });
  });

  // Action Buttons
  getEl("refreshBtn")?.addEventListener("click", () => {
    refreshLivePrice();
    refreshTechnicalAnalysis();
  });
  getEl("geminiAiBtn")?.addEventListener("click", runGeminiAnalysis);
  getEl("groqLiveBtn")?.addEventListener("click", runGroqLiveAnalysis);
  getEl("groqNewsBtn")?.addEventListener("click", runGroqNews);

  // Live Chart Timeframes
  document.querySelectorAll(".live-chart-timeframe-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".live-chart-timeframe-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      liveChartTimeframe = btn.dataset.liveTimeframe;
      loadLiveCandles();
    });
  });

  getEl("liveChartRefreshBtn")?.addEventListener("click", loadLiveCandles);
  getEl("liveChartResetBtn")?.addEventListener("click", () => liveCandleChart?.timeScale().fitContent());

  // Historical Chart Timeframes
  document.querySelectorAll(".timeframe-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".timeframe-btn").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      activeHistoryTimeframe = btn.dataset.timeframe;
      loadHistoricalBtcChart();
    });
  });

  // Historical Chart Zoom buttons
  getEl("zoomInBtn")?.addEventListener("click", () => btcHistoryChart?.zoom({ x: 1.35 }));
  getEl("zoomOutBtn")?.addEventListener("click", () => btcHistoryChart?.zoom({ x: 0.74 }));
  getEl("resetZoomBtn")?.addEventListener("click", () => btcHistoryChart?.resetZoom());

  // RRG Timeframes & Reset
  getEl("rrg1hBtn")?.addEventListener("click", () => {
    getEl("rrg1hBtn")?.classList.add("active");
    getEl("rrg1dBtn")?.classList.remove("active");
    activeRrgTimeframe = "1h"; loadRrg();
  });
  getEl("rrg1dBtn")?.addEventListener("click", () => {
    getEl("rrg1dBtn")?.classList.add("active");
    getEl("rrg1hBtn")?.classList.remove("active");
    activeRrgTimeframe = "1d"; loadRrg();
  });
  getEl("rrgResetBtn")?.addEventListener("click", () => rrgChartInstance?.resetZoom());

  // Paper Trading Actions
  getEl("paperBuyBtn")?.addEventListener("click", () => executePaperTrade(true));
  getEl("paperSellBtn")?.addEventListener("click", () => executePaperTrade(false));
  getEl("resetPaperBtn")?.addEventListener("click", () => {
    savePaperPortfolio({ cashInr: DEFAULT_PAPER_CASH, btcHolding: 0, totalCostInr: 0, shortBtcHolding: 0, shortProceedsInr: 0, history: [] });
    renderPaperTrading();
  });

  // Browser Alerts
  getEl("enableNotificationsBtn")?.addEventListener("click", () => {
    if ("Notification" in window) Notification.requestPermission();
  });
  getEl("testNotificationBtn")?.addEventListener("click", () => {
    sendBrowserAlert("Test Notification", "Browser alerts are working properly!");
  });

  // Sub-systems setup
  setupPreferences();
  setupLayoutEditor();
  setupChartAnalyser();

  // Initial Data Loads
  refreshLivePrice();
  refreshTechnicalAnalysis();
  loadLiveCandles();
  loadHistoricalBtcChart();
  loadRrg();

  // Auto-Refresh Intervals
  setInterval(refreshLivePrice, 15000);
  setInterval(refreshTechnicalAnalysis, 60000);
});
