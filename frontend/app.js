let btcChart;
let rrgChart;
let activeTimeframe = "1D";
let activeRrgTimeframe = "1d";
let currentBtcPriceUsd = null;
let currentBtcPriceInr = null;
let aiRefreshInProgress = false;
let technicalRefreshInProgress = false;

let latestAiPlan = null;
let latestTechnicalMarket = null;
let latestTechnicalResponse = null;
let aiPlanTimer = null;

const USD_INR_RATE = 83;
const PAPER_STORAGE_KEY = "btcAiSignalPaperPortfolioV2";
const DEFAULT_PAPER_CASH = 100000;
const PAPER_MIN_TRADE_INR = 100;
const PAPER_EPSILON = 0.00000001;
const AI_PLAN_STORAGE_KEY = "btcAiSignalLatestPlanV1";
const LAST_AI_SIGNAL_STORAGE_KEY = "btcAiSignalLastSignalV1";
const AI_PLAN_VALIDITY_MS = 5 * 60 * 1000;
const LAYOUT_STORAGE_KEY = "btcAiSignalCustomLayoutV1";
const TECHNICAL_TIMEOUT_MS = 20000;

const timeframeSettings = {
  "1W": { days: 90, interval: "1w", label: "Weekly", dateOptions: { month: "short", year: "numeric" }, maxPoints: 20 },
  "1D": { days: 30, interval: "1d", label: "Daily", dateOptions: { month: "short", day: "numeric" }, maxPoints: 31 },
  "1H": { days: 7, interval: "1h", label: "Hourly", dateOptions: { month: "short", day: "numeric", hour: "2-digit" }, maxPoints: 120 },
  "15M": { days: 1, interval: "15m", label: "15 Min", dateOptions: { hour: "2-digit", minute: "2-digit" }, maxPoints: 120 }
};

const rrgColors = {
  BTCUSDT: { border: "#facc15", background: "rgba(250, 204, 21, 0.18)" },
  ETHUSDT: { border: "#60a5fa", background: "rgba(96, 165, 250, 0.18)" },
  SOLUSDT: { border: "#a78bfa", background: "rgba(167, 139, 250, 0.18)" }
};

function getElement(id) {
  return document.getElementById(id);
}

function setText(id, value) {
  const element = getElement(id);
  if (element) element.textContent = value ?? "--";
}

function formatDateForSignal() {
  return new Date().toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric"
  });
}

function formatUpdatedAt(timestamp) {
  if (!timestamp) return "Update time unavailable";
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
  if (!Number.isFinite(number)) return "--";
  return `$${number.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
}

function formatInr(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "₹--";
  return `₹${number.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
}

function formatBtc(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "0.000000 BTC";
  return `${number.toFixed(6)} BTC`;
}

function formatPercent(value, suffix = "%") {
  const number = Number(value);
  if (!Number.isFinite(number)) return "--";
  return `${number.toFixed(2)}${suffix}`;
}

function formatSignedScore(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "--";
  return `${number > 0 ? "+" : ""}${number.toFixed(2)}`;
}

function getSignalColor(signal) {
  if (signal === "STRONG BUY" || signal === "BUY" || signal === "BUY WATCH") return "#22c55e";
  if (signal === "STRONG SELL" || signal === "SELL" || signal === "SELL WATCH") return "#ef4444";
  return "#facc15";
}

function normaliseMainSignal(signal) {
  const allowedSignals = [
    "STRONG BUY",
    "BUY WATCH",
    "NO TRADE",
    "SELL WATCH",
    "STRONG SELL",
    "BUY",
    "SELL",
    "HOLD"
  ];
  return allowedSignals.includes(signal) ? signal : "NO TRADE";
}

function setSignal(signal, reason) {
  const normalizedSignal = normaliseMainSignal(signal);
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
  if (!element) return;

  const normalizedSignal = ["BUY", "SELL", "HOLD"].includes(signal) ? signal : "HOLD";
  const color = getSignalColor(normalizedSignal);

  element.textContent = normalizedSignal;
  element.style.color = color;
  element.style.borderColor = color;
}

function setRiskBadge(risk) {
  const badge = getElement("riskBadge");
  if (!badge) return;

  const normalizedRisk = ["LOW", "MEDIUM", "HIGH"].includes(risk) ? risk : "HIGH";
  badge.textContent = `Risk: ${normalizedRisk}`;
  badge.className = `risk-badge risk-${normalizedRisk.toLowerCase()}`;
}

function setSignalSource(message, mode = "ai") {
  const element = getElement("signalSource");
  if (!element) return;

  element.textContent = `Signal source: ${message}`;
  element.dataset.mode = mode;
  element.style.color = mode === "ai" ? "#67e8f9" : mode === "technical" ? "#facc15" : "#cbd5e1";
}

function saveLastAiSignal(aiData) {
  const snapshot = {
    signal: aiData?.signal || "NO TRADE",
    confidence: aiData?.confidence ?? "--",
    reason: aiData?.reason || "No AI explanation available.",
    updatedAt: aiData?.updated_at ? Number(aiData.updated_at) * 1000 : Date.now()
  };

  try {
    localStorage.setItem(LAST_AI_SIGNAL_STORAGE_KEY, JSON.stringify(snapshot));
  } catch (error) {
    console.error(error);
  }
}

function getLastAiSignal() {
  try {
    const saved = localStorage.getItem(LAST_AI_SIGNAL_STORAGE_KEY);
    return saved ? JSON.parse(saved) : null;
  } catch (error) {
    console.error(error);
    return null;
  }
}

function isBuyLike(signal = "") {
  return String(signal).toUpperCase().includes("BUY");
}

function isSellLike(signal = "") {
  return String(signal).toUpperCase().includes("SELL");
}

function formatStoredSignalTime(timestamp) {
  if (!timestamp) return "--";

  const date = new Date(Number(timestamp));
  if (Number.isNaN(date.getTime())) return "--";

  return date.toLocaleString("en-IN", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
}

function updateSignalConfirmation(technicalData) {
  const lastAi = getLastAiSignal();
  const technicalSignal = technicalData?.signal || "NO TRADE";
  const technicalReason = technicalData?.reason || "--";

  setText("liveTechnicalSignal", technicalSignal);
  setText("liveTechnicalReason", technicalReason);
  setText("liveTechnicalUpdated", `Updated: ${formatUpdatedAt(technicalData?.updated_at)}`);

  if (!lastAi) {
    setText("lastAiSignal", "No previous AI analysis");
    setText("lastAiConfidence", "Confidence: --");
    setText("lastAiUpdated", "Updated: --");
    setText("combinedDecision", technicalSignal);
    setText("combinedDecisionReason", "Gemini AI is unavailable. Showing live technical fallback only.");
    return;
  }

  setText("lastAiSignal", lastAi.signal);
  setText("lastAiConfidence", `Confidence: ${lastAi.confidence}`);
  setText("lastAiUpdated", `Updated: ${formatStoredSignalTime(lastAi.updatedAt)}`);

  const aiBuy = isBuyLike(lastAi.signal);
  const aiSell = isSellLike(lastAi.signal);
  const technicalBuy = isBuyLike(technicalSignal);
  const technicalSell = isSellLike(technicalSignal);

  let decision = "WAIT FOR CONFIRMATION";
  let decisionReason = "The last AI view and live technical conditions are not fully aligned. Do not force an entry.";

  if ((aiBuy && technicalBuy) || (aiSell && technicalSell)) {
    decision = aiBuy ? "BUY SETUP CONFIRMED" : "SELL SETUP CONFIRMED";
    decisionReason = "The last successful Gemini AI view and the current live technical signal are aligned.";
  } else if ((aiBuy && technicalSell) || (aiSell && technicalBuy)) {
    decision = "AI SIGNAL INVALIDATED — NO ENTRY";
    decisionReason = "Current live technical conditions oppose the last Gemini AI signal.";
  } else if (String(technicalSignal).toUpperCase().includes("NO TRADE")) {
    decision = "WAIT FOR CONFIRMATION";
    decisionReason = "The previous AI idea is not currently confirmed by live technical data.";
  }

  setText("combinedDecision", decision);
  setText("combinedDecisionReason", decisionReason);
}

function saveAiPlan(aiData) {
  const plan = { data: aiData, savedAt: Date.now() };
  latestAiPlan = plan;

  try {
    localStorage.setItem(AI_PLAN_STORAGE_KEY, JSON.stringify(plan));
  } catch (error) {
    console.error(error);
  }

  scheduleAiPlanExpiry();
}

function loadSavedAiPlan() {
  try {
    const saved = localStorage.getItem(AI_PLAN_STORAGE_KEY);
    if (!saved) return null;

    const plan = JSON.parse(saved);
    if (!plan?.data || !Number.isFinite(Number(plan.savedAt))) return null;

    latestAiPlan = plan;
    return plan;
  } catch (error) {
    console.error(error);
    return null;
  }
}

function getAiPlanAgeMs() {
  if (!latestAiPlan?.savedAt) return Infinity;
  return Date.now() - Number(latestAiPlan.savedAt);
}

function isAiPlanActive() {
  return getAiPlanAgeMs() < AI_PLAN_VALIDITY_MS;
}

function getAiPlanRemainingLabel() {
  const remainingMs = Math.max(0, AI_PLAN_VALIDITY_MS - getAiPlanAgeMs());
  const remainingSeconds = Math.ceil(remainingMs / 1000);
  const minutes = Math.floor(remainingSeconds / 60);
  const seconds = remainingSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function toNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function getTechnicalConfidence(technical) {
  const score = Number(technical?.score || 0);
  const signal = technical?.signal || "NO TRADE";

  if (signal === "BUY WATCH" || signal === "SELL WATCH") {
    return Math.min(85, 50 + score * 7);
  }

  return Math.min(55, 25 + score * 6);
}

function calculateTechnicalSignal(market15m = {}, market1h = {}) {
  const trend15m = String(market15m.trend || "").toUpperCase();
  const trend1h = String(market1h.trend || "").toUpperCase();
  const macd15m = String(market15m?.macd?.state || "").toUpperCase();
  const macd1h = String(market1h?.macd?.state || "").toUpperCase();
  const breakout = String(market15m.breakout_status || "").toUpperCase();
  const rsi15m = toNumber(market15m.rsi_14);
  const rsi1h = toNumber(market1h.rsi_14);
  const momentum15m = toNumber(market15m.momentum_percent);
  const volumeRatio = toNumber(market15m?.volume?.volume_ratio);

  const bullishTrend = trend15m.includes("BULL") || trend1h.includes("BULL");
  const bearishTrend = trend15m.includes("BEAR") || trend1h.includes("BEAR");
  const bullishMacd = macd15m.includes("BULL") || macd1h.includes("BULL");
  const bearishMacd = macd15m.includes("BEAR") || macd1h.includes("BEAR");
  const bullishBreakout = breakout.includes("BREAKOUT") && !breakout.includes("BEAR");
  const bearishBreakdown = breakout.includes("BREAKDOWN") || breakout.includes("BEAR");
  const bullishMomentum = (rsi15m !== null && rsi15m >= 52 && rsi15m <= 72)
    || (rsi1h !== null && rsi1h >= 50 && rsi1h <= 72)
    || (momentum15m !== null && momentum15m > 0);
  const bearishMomentum = (rsi15m !== null && rsi15m <= 48 && rsi15m >= 28)
    || (rsi1h !== null && rsi1h <= 50 && rsi1h >= 28)
    || (momentum15m !== null && momentum15m < 0);
  const volumeConfirmed = volumeRatio !== null && volumeRatio >= 1;

  let buyScore = 0;
  let sellScore = 0;

  if (bullishTrend) buyScore += 2;
  if (bullishMacd) buyScore += 2;
  if (bullishMomentum) buyScore += 1;
  if (bullishBreakout) buyScore += 2;
  if (volumeConfirmed) buyScore += 1;

  if (bearishTrend) sellScore += 2;
  if (bearishMacd) sellScore += 2;
  if (bearishMomentum) sellScore += 1;
  if (bearishBreakdown) sellScore += 2;
  if (volumeConfirmed) sellScore += 1;

  if (buyScore >= 5 && buyScore > sellScore + 1) {
    return {
      signal: "BUY WATCH",
      reason: "Technical confirmation is bullish: trend, momentum and/or breakout conditions are aligned.",
      score: buyScore
    };
  }

  if (sellScore >= 5 && sellScore > buyScore + 1) {
    return {
      signal: "SELL WATCH",
      reason: "Technical confirmation is bearish: trend, momentum and/or breakdown conditions are aligned.",
      score: sellScore
    };
  }

  return {
    signal: "NO TRADE",
    reason: "Technical conditions are mixed or lack enough confirmation. Wait for trend, momentum and volume alignment.",
    score: Math.max(buyScore, sellScore)
  };
}

async function fetchWithTimeout(url, options = {}, timeoutMs = TECHNICAL_TIMEOUT_MS) {
  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`Technical request timed out after ${Math.round(timeoutMs / 1000)} seconds.`);
    }
    throw error;
  } finally {
    window.clearTimeout(timeoutId);
  }
}

function setTechnicalRefreshState(state = "idle", message = "") {
  const retryButton = getElement("retryTechnicalBtn");
  const refreshButton = getElement("refreshBtn");

  if (retryButton) {
    retryButton.hidden = state !== "error";
    retryButton.disabled = state === "loading";
  }

  if (refreshButton) {
    refreshButton.disabled = state === "loading";
    refreshButton.textContent = state === "loading" ? "Refreshing..." : "Refresh Technical";
  }

  if (message) setText("technicalRefreshStatus", message);
}

function setDataHealthBadge(health = {}) {
  const badge = getElement("technicalDataHealth");
  if (!badge) return;

  const allowedStatuses = ["LIVE", "CACHED", "DELAYED", "ERROR"];
  const status = allowedStatuses.includes(health.status) ? health.status : "ERROR";
  const age = Number(health.cache_age_seconds);
  const ageText = Number.isFinite(age) ? ` • ${age.toFixed(1)}s old` : "";

  badge.textContent = `Data: ${status}${status === "LIVE" ? "" : ageText}`;
  badge.className = `data-health-badge health-${status.toLowerCase()}`;
}

function renderTechnicalIntelligence(data) {
  const health = data?.data_health || {};
  const score = data?.score_breakdown || {};
  const regime = data?.market_regime || {};
  const agreement = data?.timeframe_agreement || {};
  const levels = data?.key_level_distance || {};

  setDataHealthBadge(health);
  setText("technicalHealthMessage", health.message || "Technical data status unavailable.");
  setText("technicalRefreshStatus", `Updated: ${formatUpdatedAt(data?.updated_at)}${data?.cached ? " • cached response" : ""}`);

  setText("marketRegime", regime.label || "--");
  setText("marketRegimeDetail", regime.detail || "--");
  setText(
    "regimeStats",
    `ADX ${formatPercent(regime.average_adx, "")} • ATR ${formatPercent(regime.average_atr_percent)} • BB Width ${formatPercent(regime.average_bollinger_width_percent)}`
  );

  const agreementPercent = Number(agreement.percent);
  setText("timeframeAgreement", Number.isFinite(agreementPercent) ? `${agreementPercent.toFixed(0)}%` : "--");
  setText("timeframeAgreementDetail", agreement.direction || "--");
  setText(
    "timeframeVotes",
    `Bullish ${agreement.bullish_votes ?? 0} • Bearish ${agreement.bearish_votes ?? 0} • Hold ${agreement.hold_votes ?? 0}`
  );

  const agreementBar = getElement("timeframeAgreementBar");
  if (agreementBar) {
    const safeWidth = Number.isFinite(agreementPercent) ? Math.max(0, Math.min(100, agreementPercent)) : 0;
    agreementBar.style.width = `${safeWidth}%`;
  }

  setText("scoreTrend", formatSignedScore(score?.trend?.score));
  setText("scoreMacd", formatSignedScore(score?.macd?.score));
  setText("scoreMomentum", formatSignedScore(score?.momentum?.score));
  setText("scoreBreakout", formatSignedScore(score?.breakout?.score));
  setText("scoreVolume", formatSignedScore(score?.volume?.score));

  const totalScore = Number(score.total_score);
  const alignment = Number(score.technical_alignment_percent);
  setText(
    "technicalScoreTotal",
    Number.isFinite(totalScore) ? `${formatSignedScore(totalScore)} / 9` : "--"
  );
  setText(
    "technicalAlignment",
    Number.isFinite(alignment) ? `${alignment.toFixed(0)}% alignment` : "--"
  );
  setText("technicalScoreBias", score.bias || "--");

  ["15m", "1h", "4h"].forEach((timeframe) => {
    const level = levels?.[timeframe] || {};
    const timeframeId = timeframe === "15m" ? "15m" : timeframe;

    setText(`level${timeframeId}Price`, formatUsd(level.price));
    setText(`level${timeframeId}Support`, formatUsd(level.support));
    setText(`level${timeframeId}Resistance`, formatUsd(level.resistance));

    const supportDistance = Number(level.support_distance_percent);
    const resistanceDistance = Number(level.resistance_distance_percent);

    setText(
      `level${timeframeId}SupportDistance`,
      Number.isFinite(supportDistance) ? `${supportDistance.toFixed(2)}% below` : "--"
    );
    setText(
      `level${timeframeId}ResistanceDistance`,
      Number.isFinite(resistanceDistance) ? `${resistanceDistance.toFixed(2)}% above` : "--"
    );
  });
}

async function loadTechnicalFallback(reasonPrefix = "Live technical analysis refreshed.", forceRefresh = false) {
  if (technicalRefreshInProgress) return latestTechnicalResponse;

  technicalRefreshInProgress = true;
  setTechnicalRefreshState("loading", "Refreshing technical data…");

  try {
    const url = forceRefresh ? "/api/technical-signal?force_refresh=true" : "/api/technical-signal";
    const response = await fetchWithTimeout(url, { cache: "no-store" });
    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(data.detail || "Technical signal API could not be loaded.");
    }

    latestTechnicalResponse = data;
    latestTechnicalMarket = data?.market_data?.timeframes || {};

    updateIndicators(
      latestTechnicalMarket["15m"] || {},
      latestTechnicalMarket["1h"] || {}
    );

    const analysis15m = data?.timeframes?.["15m"] || {};
    const analysis1h = data?.timeframes?.["1h"] || {};
    const analysis4h = data?.timeframes?.["4h"] || {};

    setMiniSignal("signal15m", analysis15m.signal);
    setMiniSignal("signal1h", analysis1h.signal);
    setMiniSignal("signal4h", analysis4h.signal);
    setText("summary15m", analysis15m.summary);
    setText("summary1h", analysis1h.summary);
    setText("summary4h", analysis4h.summary);
    setText("keyLevel15m", analysis15m.key_level);
    setText("keyLevel1h", analysis1h.key_level);
    setText("keyLevel4h", analysis4h.key_level);

    setText("marketBias", data.market_bias);
    setText("setupStatus", data.setup_status);
    setText("confirmationNeeded", data.confirmation_needed);
    setText("target1", data.target_1);
    setText("target2", data.target_2);

    setSignal(data.signal, `${reasonPrefix} ${data.reason}`);
    const technical = calculateTechnicalSignal(
      latestTechnicalMarket["15m"] || {},
      latestTechnicalMarket["1h"] || {}
    );
    setText("aiConfidence", `Technical confidence: ${getTechnicalConfidence(technical)}%`);
    setText("entryIdea", data.entry_idea);
    setText("stopLossIdea", data.stop_loss_idea);
    setRiskBadge(data.risk);
    updateSignalConfirmation(data);
    setSignalSource("Live technical fallback — AI unavailable or expired", "technical");
    setText("analysisUpdatedAt", "Gemini AI unavailable; live Binance technical analysis is active.");

    renderTechnicalIntelligence(data);
    setTechnicalRefreshState("idle", `Technical data updated: ${formatUpdatedAt(data.updated_at)}.`);
    return data;
  } catch (error) {
    console.error(error);
    renderTechnicalFallback(reasonPrefix);
    setDataHealthBadge({ status: "ERROR" });
    setText("technicalHealthMessage", error.message || "Technical data could not be refreshed.");
    setTechnicalRefreshState("error", `Technical refresh failed: ${error.message || "Please retry."}`);
    return null;
  } finally {
    technicalRefreshInProgress = false;
    const refreshButton = getElement("refreshBtn");
    if (refreshButton) {
      refreshButton.disabled = false;
      refreshButton.textContent = "Refresh Technical";
    }
  }
}

function renderTechnicalFallback(reasonPrefix = "Gemini AI is temporarily unavailable.") {
  const market15m = latestTechnicalMarket?.["15m"] || {};
  const market1h = latestTechnicalMarket?.["1h"] || {};
  const technical = calculateTechnicalSignal(market15m, market1h);

  setSignal(technical.signal, `${reasonPrefix} ${technical.reason}`);
  setRiskBadge(technical.signal === "NO TRADE" ? "HIGH" : "MEDIUM");
  setSignalSource("Live technical fallback — AI unavailable or expired", "technical");
  setText("analysisUpdatedAt", `Live technical fallback active • updated ${new Date().toLocaleTimeString("en-IN")}`);
  updateSignalConfirmation(technical);
  setText("aiConfidence", `Technical confidence: ${getTechnicalConfidence(technical)}%`);
}

function scheduleAiPlanExpiry() {
  if (aiPlanTimer) clearTimeout(aiPlanTimer);

  const remainingMs = AI_PLAN_VALIDITY_MS - getAiPlanAgeMs();
  if (remainingMs <= 0) {
    loadTechnicalFallback("AI plan expired.");
    return;
  }

  aiPlanTimer = setTimeout(() => {
    loadTechnicalFallback("AI plan expired.");
  }, remainingMs + 100);
}

function renderSavedAiPlanIfActive() {
  const plan = latestAiPlan || loadSavedAiPlan();
  if (plan && isAiPlanActive()) {
    updateAiAnalysis(plan.data, true);
    return true;
  }
  return false;
}

function getDefaultPaperPortfolio() {
  return {
    cashInr: DEFAULT_PAPER_CASH,
    btcHolding: 0,
    totalCostInr: 0,
    shortBtcHolding: 0,
    shortProceedsInr: 0,
    history: []
  };
}

function normalisePaperPortfolio(portfolio) {
  return {
    cashInr: Math.max(0, Number(portfolio.cashInr) || 0),
    btcHolding: Math.max(0, Number(portfolio.btcHolding) || 0),
    totalCostInr: Math.max(0, Number(portfolio.totalCostInr) || 0),
    shortBtcHolding: Math.max(0, Number(portfolio.shortBtcHolding) || 0),
    shortProceedsInr: Math.max(0, Number(portfolio.shortProceedsInr) || 0),
    history: Array.isArray(portfolio.history) ? portfolio.history.slice(0, 50) : []
  };
}

function loadPaperPortfolio() {
  try {
    const saved = localStorage.getItem(PAPER_STORAGE_KEY);
    if (saved) return normalisePaperPortfolio(JSON.parse(saved));

    const legacySaved = localStorage.getItem("btcAiSignalPaperPortfolioV1");
    if (!legacySaved) return getDefaultPaperPortfolio();

    const legacy = JSON.parse(legacySaved);
    return normalisePaperPortfolio({
      cashInr: legacy.cashInr,
      btcHolding: legacy.btcHolding,
      totalCostInr: legacy.totalCostInr,
      shortBtcHolding: 0,
      shortProceedsInr: 0,
      history: legacy.history
    });
  } catch (error) {
    return getDefaultPaperPortfolio();
  }
}

function savePaperPortfolio(portfolio) {
  localStorage.setItem(PAPER_STORAGE_KEY, JSON.stringify(normalisePaperPortfolio(portfolio)));
}

function getPaperPortfolio() {
  return loadPaperPortfolio();
}

function addPaperTrade(portfolio, type, amountInr, btcAmount) {
  portfolio.history.unshift({
    type,
    amountInr,
    btcAmount,
    priceInr: currentBtcPriceInr,
    timestamp: Date.now()
  });
  portfolio.history = portfolio.history.slice(0, 50);
}

function renderPaperHistory(history) {
  const container = getElement("paperTradeHistory");
  if (!container) return;

  if (!history.length) {
    container.textContent = "No virtual trades yet.";
    return;
  }

  container.innerHTML = "";
  history.forEach((trade) => {
    const item = document.createElement("div");
    const typeClass = trade.type.includes("SELL") || trade.type.includes("SHORT") ? "history-sell" : "history-buy";
    const date = new Date(trade.timestamp).toLocaleString("en-IN", {
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit"
    });

    item.className = `history-item ${typeClass}`;
    item.textContent = `${trade.type} • ${formatInr(trade.amountInr)} • ${formatBtc(trade.btcAmount)} • ${date}`;
    container.appendChild(item);
  });
}

function renderPaperTrading() {
  const portfolio = getPaperPortfolio();
  const markPrice = Number(currentBtcPriceInr) || 0;
  const longMarketValue = portfolio.btcHolding * markPrice;
  const shortCoverCost = portfolio.shortBtcHolding * markPrice;
  const portfolioValueInr = portfolio.cashInr + longMarketValue - shortCoverCost;
  const pnlInr = portfolioValueInr - DEFAULT_PAPER_CASH;
  const pnlPercent = (pnlInr / DEFAULT_PAPER_CASH) * 100;
  const averageLongPrice = portfolio.btcHolding > PAPER_EPSILON ? portfolio.totalCostInr / portfolio.btcHolding : 0;
  const averageShortPrice = portfolio.shortBtcHolding > PAPER_EPSILON ? portfolio.shortProceedsInr / portfolio.shortBtcHolding : 0;

  let positionType = "No open position";
  if (portfolio.btcHolding > PAPER_EPSILON) positionType = "LONG BTC";
  if (portfolio.shortBtcHolding > PAPER_EPSILON) positionType = "SHORT BTC";

  setText("paperCash", formatInr(portfolio.cashInr));
  setText("paperBtcHolding", formatBtc(portfolio.btcHolding));
  setText("paperShortBtcHolding", formatBtc(portfolio.shortBtcHolding));
  setText("paperPositionType", positionType);
  setText("paperAvgPrice", portfolio.btcHolding > PAPER_EPSILON ? formatInr(averageLongPrice) : "No long position");
  setText("paperShortAvgPrice", portfolio.shortBtcHolding > PAPER_EPSILON ? formatInr(averageShortPrice) : "No short position");
  setText("paperPortfolioValue", formatInr(portfolioValueInr));

  const positionElement = getElement("paperPositionType");
  if (positionElement) {
    positionElement.style.color = positionType === "LONG BTC" ? "#22c55e" : positionType === "SHORT BTC" ? "#ef4444" : "#cbd5e1";
  }

  const pnlElement = getElement("paperPnl");
  if (pnlElement) {
    const prefix = pnlInr >= 0 ? "+" : "";
    pnlElement.textContent = `${prefix}${formatInr(pnlInr)} (${prefix}${pnlPercent.toFixed(2)}%)`;
    pnlElement.style.color = pnlInr >= 0 ? "#22c55e" : "#ef4444";
  }

  renderPaperHistory(portfolio.history);
}

function updatePrice(priceData) {
  const btc = priceData?.bitcoin;
  const priceUsd = Number(btc?.usd);
  const change = Number(btc?.usd_24h_change || 0);

  if (!Number.isFinite(priceUsd)) throw new Error("Live BTC price was not received.");

  currentBtcPriceUsd = priceUsd;
  currentBtcPriceInr = priceUsd * USD_INR_RATE;
  setText("btcPrice", formatUsd(priceUsd));

  const btcChange = getElement("btcChange");
  if (btcChange) {
    btcChange.textContent = `${change >= 0 ? "+" : ""}${change.toFixed(2)}%`;
    btcChange.style.color = change >= 0 ? "#22c55e" : "#ef4444";
  }

  setText("marketUpdatedAt", `Live price updated: ${formatUpdatedAt(priceData.updated_at)}${priceData.cached ? " (cached)" : ""}`);
  renderPaperTrading();
}

function updateIndicators(market15m, market1h) {
  setText("trend15m", market15m.trend);
  setText("rsi15m", market15m.rsi_14);
  setText("macd15m", market15m?.macd?.state);
  setText("adx15m", `${market15m?.adx?.adx_14 ?? "--"} (${market15m?.adx?.trend_strength ?? "--"})`);
  setText("momentum15m", `${market15m?.momentum_percent ?? "--"}%`);
  setText("trend1h", market1h.trend);
  setText("rsi1h", market1h.rsi_14);
  setText("macd1h", market1h?.macd?.state);
  setText("adx1h", `${market1h?.adx?.adx_14 ?? "--"} (${market1h?.adx?.trend_strength ?? "--"})`);
  setText("momentum1h", `${market1h?.momentum_percent ?? "--"}%`);
  setText("volume15m", `x${market15m?.volume?.volume_ratio ?? "--"}`);
  setText("volume1h", `x${market1h?.volume?.volume_ratio ?? "--"}`);
  setText("pattern15m", market15m.candle_pattern);
  setText("pattern1h", market1h.candle_pattern);
  setText("breakout15m", market15m.breakout_status);
  setText("support15m", formatUsd(market15m?.support_resistance?.support_20));
  setText("resistance15m", formatUsd(market15m?.support_resistance?.resistance_20));
  setText("support1h", formatUsd(market1h?.support_resistance?.support_20));
  setText("resistance1h", formatUsd(market1h?.support_resistance?.resistance_20));
  setText("structure1h", market1h.market_structure);
}

function updateAiAnalysis(aiData, fromSavedPlan = false) {
  const market15m = aiData?.market_data?.timeframes?.["15m"] || {};
  const market1h = aiData?.market_data?.timeframes?.["1h"] || {};
  latestTechnicalMarket = { "15m": market15m, "1h": market1h };

  setSignal(aiData.signal, aiData.reason);
  setText("aiConfidence", `${Number(aiData.confidence || 0)}%`);
  setText("entryIdea", aiData.entry_idea);
  setText("stopLossIdea", aiData.stop_loss_idea);
  setText("disclaimerText", aiData.disclaimer);
  setRiskBadge(aiData.risk);

  const analysis15m = aiData?.timeframes?.["15m"] || {};
  const analysis1h = aiData?.timeframes?.["1h"] || {};
  const analysis4h = aiData?.timeframes?.["4h"] || {};

  setMiniSignal("signal15m", analysis15m.signal);
  setMiniSignal("signal1h", analysis1h.signal);
  setMiniSignal("signal4h", analysis4h.signal);
  setText("summary15m", analysis15m.summary);
  setText("summary1h", analysis1h.summary);
  setText("summary4h", analysis4h.summary);
  setText("keyLevel15m", analysis15m.key_level);
  setText("keyLevel1h", analysis1h.key_level);
  setText("keyLevel4h", analysis4h.key_level);

  setText("marketBias", aiData.market_bias);
  setText("setupStatus", aiData.setup_status);
  setText("confirmationNeeded", aiData.confirmation_needed);
  setText("target1", aiData.target_1);
  setText("target2", aiData.target_2);

  updateIndicators(market15m, market1h);

  const planText = fromSavedPlan ? `AI plan active • expires in ${getAiPlanRemainingLabel()}` : `Fresh Gemini AI plan • expires in ${getAiPlanRemainingLabel()}`;
  setSignalSource(planText, "ai");
  setText("analysisUpdatedAt", `Last AI analysis: ${formatUpdatedAt(aiData.updated_at)}${aiData.cached ? " (API cached)" : ""} • plan valid ${getAiPlanRemainingLabel()}`);
}

async function loadPrice(forceRefresh = false) {
  const url = forceRefresh ? "/api/btc/price?force_refresh=true" : "/api/btc/price";
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) throw new Error("Price API could not be loaded.");
  updatePrice(await response.json());
}

async function loadChart() {
  const selected = timeframeSettings[activeTimeframe];
  const response = await fetch(`/api/btc/chart?days=${selected.days}&interval=${selected.interval}`, { cache: "no-store" });
  if (!response.ok) throw new Error("Chart API could not be loaded.");

  const chartData = await response.json();
  const rawPrices = Array.isArray(chartData.prices) ? chartData.prices : [];
  if (!rawPrices.length) throw new Error("No chart data was received.");

  const step = Math.max(1, Math.ceil(rawPrices.length / selected.maxPoints));
  const chartPoints = rawPrices.filter((_, index) => index % step === 0 || index === rawPrices.length - 1);
  const labels = chartPoints.map((item) => new Date(item[0]).toLocaleString("en-IN", selected.dateOptions));
  renderChart(labels, chartPoints.map((item) => item[1]), selected.label);
}

async function loadAiAnalysis() {
  if (aiRefreshInProgress) return;

  aiRefreshInProgress = true;
  setText("analysisUpdatedAt", "Updating Gemini AI analysis...");

  try {
    const response = await fetch("/api/ai-signal", { cache: "no-store" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.detail || data.message || `AI signal request failed (${response.status}).`);

    saveLastAiSignal(data);
    saveAiPlan(data);
    updateAiAnalysis(data);
  } catch (error) {
    console.error(error);
    const existingPlanIsActive = renderSavedAiPlanIfActive();
    if (existingPlanIsActive) {
      setSignalSource(`Gemini refresh failed — last AI plan active for ${getAiPlanRemainingLabel()}`, "ai");
      setText("analysisUpdatedAt", "Gemini refresh failed; using last successful AI plan.");
      return;
    }
    loadTechnicalFallback("Gemini AI is temporarily unavailable.");
  } finally {
    aiRefreshInProgress = false;
  }
}

async function refreshFastData() {
  try {
    await Promise.all([loadPrice(true), loadChart()]);
  } catch (error) {
    console.error(error);
    setText("marketUpdatedAt", "Live price/chart could not be updated. Please try again.");
  }
}

async function refreshTechnicalAnalysis(reasonPrefix = "Live technical analysis refreshed.") {
  return loadTechnicalFallback(reasonPrefix, true);
}

async function refreshAllData() {
  if (technicalRefreshInProgress) return;

  try {
    await Promise.all([
      refreshFastData(),
      refreshTechnicalAnalysis("Live technical analysis refreshed.")
    ]);
  } catch (error) {
    console.error("Technical refresh error:", error);
  }

  loadRrg().catch((error) => console.error("RRG refresh error:", error));
}

function renderChart(labels, data, timeframeLabel) {
  const canvas = getElement("btcChart");
  if (!canvas) return;
  const ctx = canvas.getContext("2d");
  if (btcChart) btcChart.destroy();

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
      interaction: { intersect: false, mode: "index" },
      plugins: {
        legend: { labels: { color: "#ffffff" } },
        tooltip: { callbacks: { label(context) { return `BTC: ${formatUsd(context.raw)}`; } } },
        zoom: {
          limits: { x: { min: "original", max: "original", minRange: 2 } },
          pan: { enabled: true, mode: "x", threshold: 2 },
          zoom: {
            wheel: { enabled: true, speed: 0.25 },
            pinch: { enabled: true },
            drag: { enabled: true, threshold: 2, backgroundColor: "rgba(59, 130, 246, 0.18)", borderColor: "#60a5fa", borderWidth: 1 },
            mode: "x"
          }
        }
      },
      scales: {
        x: { ticks: { color: "#cbd5e1", maxTicksLimit: 7 }, grid: { color: "#1e293b" } },
        y: { ticks: { color: "#cbd5e1", callback(value) { return formatUsd(value); } }, grid: { color: "#1e293b" } }
      }
    }
  });
}

function getRrgQuadrant(x, y) {
  if (x >= 100 && y >= 100) return "Leading";
  if (x >= 100 && y < 100) return "Weakening";
  if (x < 100 && y < 100) return "Lagging";
  return "Improving";
}

function createRrgQuadrantsPlugin() {
  return {
    id: "rrgQuadrants",
    beforeDatasetsDraw(chart) {
      const { ctx, chartArea, scales } = chart;
      if (!chartArea || !scales.x || !scales.y) return;
      const { left, right, top, bottom } = chartArea;
      const centerX = scales.x.getPixelForValue(100);
      const centerY = scales.y.getPixelForValue(100);
      if (!Number.isFinite(centerX) || !Number.isFinite(centerY)) return;

      ctx.save();
      ctx.fillStyle = "rgba(59, 130, 246, 0.13)";
      ctx.fillRect(left, top, centerX - left, centerY - top);
      ctx.fillStyle = "rgba(34, 197, 94, 0.13)";
      ctx.fillRect(centerX, top, right - centerX, centerY - top);
      ctx.fillStyle = "rgba(239, 68, 68, 0.13)";
      ctx.fillRect(left, centerY, centerX - left, bottom - centerY);
      ctx.fillStyle = "rgba(250, 204, 21, 0.13)";
      ctx.fillRect(centerX, centerY, right - centerX, bottom - centerY);
      ctx.strokeStyle = "rgba(255, 255, 255, 0.96)";
      ctx.lineWidth = 2.5;
      ctx.setLineDash([]);
      ctx.beginPath();
      ctx.moveTo(centerX, top);
      ctx.lineTo(centerX, bottom);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(left, centerY);
      ctx.lineTo(right, centerY);
      ctx.stroke();
      ctx.fillStyle = "#ffffff";
      ctx.beginPath();
      ctx.arc(centerX, centerY, 3.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.font = "700 13px Arial";
      ctx.fillStyle = "rgba(255, 255, 255, 0.96)";
      ctx.textBaseline = "top";
      ctx.textAlign = "left";
      ctx.fillText("IMPROVING", left + 14, top + 14);
      ctx.textAlign = "right";
      ctx.fillText("LEADING", right - 14, top + 14);
      ctx.textBaseline = "bottom";
      ctx.textAlign = "left";
      ctx.fillText("LAGGING", left + 14, bottom - 14);
      ctx.textAlign = "right";
      ctx.fillText("WEAKENING", right - 14, bottom - 14);
      ctx.restore();
    }
  };
}

function createRrgDirectionArrowsPlugin() {
  return {
    id: "rrgDirectionArrows",
    afterDatasetsDraw(chart) {
      const { ctx } = chart;
      chart.data.datasets.forEach((dataset, datasetIndex) => {
        const meta = chart.getDatasetMeta(datasetIndex);
        if (!meta?.data?.length) return;
        const latestElement = meta.data[meta.data.length - 1];
        const raw = dataset.data[dataset.data.length - 1];
        if (!latestElement || !raw) return;
        const arrowMap = { "North-East": "↗", "South-East": "↘", "North-West": "↖", "South-West": "↙", Flat: "→" };
        ctx.save();
        ctx.fillStyle = dataset.borderColor || "#ffffff";
        ctx.font = "bold 20px Arial";
        ctx.textAlign = "left";
        ctx.textBaseline = "middle";
        ctx.fillText(arrowMap[raw.direction || "Flat"] || "→", latestElement.x + 9, latestElement.y);
        ctx.restore();
      });
    }
  };
}

async function loadRrg() {
  const status = getElement("rrgStatus");
  if (status) status.textContent = `Loading ${activeRrgTimeframe} RRG-style data...`;
  try {
    const response = await fetch(`/api/rrg?interval=${activeRrgTimeframe}`, { cache: "no-store" });
    if (!response.ok) throw new Error("RRG API could not be loaded.");
    const data = await response.json();
    renderRrg(data);
    if (status) status.textContent = `${activeRrgTimeframe.toUpperCase()} RRG updated: ${formatUpdatedAt(data.updated_at)}${data.cached ? " (cached)" : ""}`;
  } catch (error) {
    console.error(error);
    if (status) status.textContent = "RRG-style chart could not be loaded. Please refresh again.";
  }
}

function renderRrg(rrgData) {
  const canvas = getElement("rrgChart");
  if (!canvas || !Array.isArray(rrgData?.trails)) return;
  const ctx = canvas.getContext("2d");
  if (rrgChart) rrgChart.destroy();

  const allPoints = rrgData.trails.flatMap((trail) => Array.isArray(trail.points) ? trail.points : []);
  const xValues = allPoints.map((point) => Number(point.x)).filter(Number.isFinite);
  const yValues = allPoints.map((point) => Number(point.y)).filter(Number.isFinite);
  const xMin = Math.min(100, ...xValues);
  const xMax = Math.max(100, ...xValues);
  const yMin = Math.min(100, ...yValues);
  const yMax = Math.max(100, ...yValues);
  const xPadding = Math.max(0.8, (xMax - xMin) * 0.22);
  const yPadding = Math.max(0.8, (yMax - yMin) * 0.22);

  const datasets = rrgData.trails.map((trail) => {
    const color = rrgColors[trail.symbol] || { border: "#ffffff", background: "rgba(255, 255, 255, 0.15)" };
    const points = Array.isArray(trail.points) ? trail.points : [];
    const lastIndex = points.length - 1;
    return {
      label: trail.symbol.replace("USDT", ""),
      data: points.map((point, index) => ({ x: Number(point.x), y: Number(point.y), timestamp: point.timestamp, isLatest: index === lastIndex, direction: trail.direction || "Flat" })),
      borderColor: color.border,
      backgroundColor: color.background,
      borderWidth: 2,
      pointBorderColor: color.border,
      pointBackgroundColor(context) { return context.raw?.isLatest ? color.border : "rgba(15, 23, 42, 0.95)"; },
      pointRadius(context) { return context.raw?.isLatest ? 5 : 2; },
      pointHoverRadius: 7,
      showLine: true,
      tension: 0
    };
  });

  rrgChart = new Chart(ctx, {
    type: "scatter",
    data: { datasets },
    plugins: [createRrgQuadrantsPlugin(), createRrgDirectionArrowsPlugin()],
    options: {
      responsive: true,
      maintainAspectRatio: true,
      aspectRatio: 1.15,
      interaction: { intersect: false, mode: "nearest" },
      plugins: {
        legend: { labels: { color: "#ffffff", usePointStyle: true, pointStyle: "circle" } },
        tooltip: {
          callbacks: {
            title(context) {
              const raw = context[0]?.raw;
              if (!raw?.timestamp) return "RRG-style point";
              return new Date(raw.timestamp).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
            },
            label(context) {
              const x = Number(context.raw?.x || 0);
              const y = Number(context.raw?.y || 0);
              const direction = context.raw?.direction || "Flat";
              return [`${context.dataset.label}: ${getRrgQuadrant(x, y)}`, `Direction: ${direction}`, `RS Ratio: ${x.toFixed(2)}`, `RS Momentum: ${y.toFixed(2)}`];
            }
          }
        },
        zoom: {
          limits: { x: { min: "original", max: "original", minRange: 0.5 }, y: { min: "original", max: "original", minRange: 0.5 } },
          pan: { enabled: true, mode: "xy", threshold: 2 },
          zoom: {
            wheel: { enabled: true, speed: 0.18 },
            pinch: { enabled: true },
            drag: { enabled: true, threshold: 2, backgroundColor: "rgba(59, 130, 246, 0.16)", borderColor: "#60a5fa", borderWidth: 1 },
            mode: "xy"
          }
        }
      },
      scales: {
        x: { type: "linear", min: xMin - xPadding, max: xMax + xPadding, title: { display: true, text: "Relative Strength Ratio", color: "#cbd5e1" }, ticks: { color: "#cbd5e1", maxTicksLimit: 7 }, grid: { color: "#334155" } },
        y: { type: "linear", min: yMin - yPadding, max: yMax + yPadding, title: { display: true, text: "Relative Strength Momentum", color: "#cbd5e1" }, ticks: { color: "#cbd5e1", maxTicksLimit: 7 }, grid: { color: "#334155" } }
      }
    }
  });
}

function getPaperTradeAmount() {
  const input = getElement("paperAmountInput");
  const amountInr = Number(input?.value);
  if (!currentBtcPriceInr) {
    setText("paperTradeStatus", "Waiting for live BTC price. Please wait a few seconds.");
    return null;
  }
  if (!Number.isFinite(amountInr) || amountInr < PAPER_MIN_TRADE_INR) {
    setText("paperTradeStatus", "Please enter a valid virtual amount of at least ₹100.");
    return null;
  }
  return { input, amountInr };
}

function executePaperBuy() {
  const trade = getPaperTradeAmount();
  if (!trade) return;
  const { input, amountInr } = trade;
  const portfolio = getPaperPortfolio();
  const btcAmount = amountInr / currentBtcPriceInr;

  if (portfolio.shortBtcHolding > PAPER_EPSILON) {
    const shortMarketValue = portfolio.shortBtcHolding * currentBtcPriceInr;
    if (amountInr > shortMarketValue + 0.01) {
      setText("paperTradeStatus", "Cover amount is larger than the current open short position.");
      return;
    }
    if (amountInr > portfolio.cashInr + 0.01) {
      setText("paperTradeStatus", "Not enough virtual cash to cover this short position.");
      return;
    }
    const coverBtc = Math.min(btcAmount, portfolio.shortBtcHolding);
    const costToCover = coverBtc * currentBtcPriceInr;
    const averageShortPrice = portfolio.shortProceedsInr / portfolio.shortBtcHolding;
    portfolio.cashInr -= costToCover;
    portfolio.shortBtcHolding -= coverBtc;
    portfolio.shortProceedsInr -= coverBtc * averageShortPrice;
    if (portfolio.shortBtcHolding < PAPER_EPSILON) {
      portfolio.shortBtcHolding = 0;
      portfolio.shortProceedsInr = 0;
    }
    addPaperTrade(portfolio, "BUY TO COVER", costToCover, coverBtc);
    savePaperPortfolio(portfolio);
    if (input) input.value = "";
    setText("paperTradeStatus", `Virtual BUY TO COVER complete: ${formatBtc(coverBtc)} at ${formatInr(currentBtcPriceInr)} per BTC.`);
    renderPaperTrading();
    return;
  }

  if (amountInr > portfolio.cashInr + 0.01) {
    setText("paperTradeStatus", "Not enough virtual cash for this long trade.");
    return;
  }
  portfolio.cashInr -= amountInr;
  portfolio.btcHolding += btcAmount;
  portfolio.totalCostInr += amountInr;
  addPaperTrade(portfolio, "BUY LONG", amountInr, btcAmount);
  savePaperPortfolio(portfolio);
  if (input) input.value = "";
  setText("paperTradeStatus", `Virtual BUY LONG complete: ${formatBtc(btcAmount)} at ${formatInr(currentBtcPriceInr)} per BTC.`);
  renderPaperTrading();
}

function executePaperSell() {
  const trade = getPaperTradeAmount();
  if (!trade) return;
  const { input, amountInr } = trade;
  const portfolio = getPaperPortfolio();
  const btcAmount = amountInr / currentBtcPriceInr;

  if (portfolio.btcHolding > PAPER_EPSILON) {
    const longMarketValue = portfolio.btcHolding * currentBtcPriceInr;
    if (amountInr > longMarketValue + 0.01) {
      setText("paperTradeStatus", "Sell amount is larger than the current BTC long holding.");
      return;
    }
    const sellBtc = Math.min(btcAmount, portfolio.btcHolding);
    const saleValue = sellBtc * currentBtcPriceInr;
    const averageLongPrice = portfolio.totalCostInr / portfolio.btcHolding;
    portfolio.cashInr += saleValue;
    portfolio.btcHolding -= sellBtc;
    portfolio.totalCostInr -= sellBtc * averageLongPrice;
    if (portfolio.btcHolding < PAPER_EPSILON) {
      portfolio.btcHolding = 0;
      portfolio.totalCostInr = 0;
    }
    addPaperTrade(portfolio, "SELL LONG", saleValue, sellBtc);
    savePaperPortfolio(portfolio);
    if (input) input.value = "";
    setText("paperTradeStatus", `Virtual SELL LONG complete: ${formatBtc(sellBtc)} at ${formatInr(currentBtcPriceInr)} per BTC.`);
    renderPaperTrading();
    return;
  }

  if (amountInr > portfolio.cashInr + 0.01) {
    setText("paperTradeStatus", "Not enough virtual cash/margin to open this 1x short trade.");
    return;
  }
  portfolio.cashInr += amountInr;
  portfolio.shortBtcHolding += btcAmount;
  portfolio.shortProceedsInr += amountInr;
  addPaperTrade(portfolio, "SELL SHORT", amountInr, btcAmount);
  savePaperPortfolio(portfolio);
  if (input) input.value = "";
  setText("paperTradeStatus", `Virtual SELL SHORT complete: ${formatBtc(btcAmount)} at ${formatInr(currentBtcPriceInr)} per BTC. Use Buy / Cover Short to close it.`);
  renderPaperTrading();
}

function resetPaperTrading() {
  const shouldReset = window.confirm("Reset virtual paper portfolio to ₹100,000 and remove all virtual trades?");
  if (!shouldReset) return;
  savePaperPortfolio(getDefaultPaperPortfolio());
  setText("paperTradeStatus", "Virtual portfolio reset to ₹100,000.");
  renderPaperTrading();
}

function setupPaperTrading() {
  const buyButton = getElement("paperBuyBtn");
  const sellButton = getElement("paperSellBtn");
  const resetButton = getElement("resetPaperBtn");
  if (buyButton) buyButton.addEventListener("click", executePaperBuy);
  if (sellButton) sellButton.addEventListener("click", executePaperSell);
  if (resetButton) resetButton.addEventListener("click", resetPaperTrading);
  renderPaperTrading();
}

function setupTimeframeButtons() {
  const buttons = document.querySelectorAll(".timeframe-btn");
  buttons.forEach((button) => {
    button.addEventListener("click", async () => {
      const selectedTimeframe = button.dataset.timeframe;
      if (!timeframeSettings[selectedTimeframe]) return;
      activeTimeframe = selectedTimeframe;
      buttons.forEach((item) => item.classList.remove("active"));
      button.classList.add("active");
      try {
        await loadChart();
      } catch (error) {
        console.error(error);
        setText("marketUpdatedAt", "Selected chart timeframe could not be loaded.");
      }
    });
  });
}

function setupZoomButtons() {
  const zoomInButton = getElement("zoomInBtn");
  const zoomOutButton = getElement("zoomOutBtn");
  const resetZoomButton = getElement("resetZoomBtn");
  if (zoomInButton) zoomInButton.addEventListener("click", () => { if (btcChart) btcChart.zoom({ x: 1.35 }); });
  if (zoomOutButton) zoomOutButton.addEventListener("click", () => { if (btcChart) btcChart.zoom({ x: 0.74 }); });
  if (resetZoomButton) resetZoomButton.addEventListener("click", () => { if (btcChart) btcChart.resetZoom(); });
}

function setupRrgButtons() {
  const buttons = document.querySelectorAll(".rrg-timeframe-btn");
  const resetButton = getElement("rrgResetBtn");
  buttons.forEach((button) => {
    button.addEventListener("click", async () => {
      const selectedTimeframe = button.dataset.rrgTimeframe;
      if (!["1h", "1d"].includes(selectedTimeframe)) return;
      activeRrgTimeframe = selectedTimeframe;
      buttons.forEach((item) => item.classList.remove("active"));
      button.classList.add("active");
      await loadRrg();
    });
  });
  if (resetButton) resetButton.addEventListener("click", () => { if (rrgChart) rrgChart.resetZoom(); });
}

function setUploadedChartText(id, value) {
  const element = getElement(id);
  if (element) element.textContent = value || "--";
}

function setupChartAnalyser() {
  const imageInput = getElement("chartImageInput");
  const preview = getElement("chartImagePreview");
  const analyseButton = getElement("analyseChartBtn");
  const status = getElement("chartAnalyseStatus");
  const resultBox = getElement("chartAnalysisResult");
  if (!imageInput || !preview || !analyseButton || !status || !resultBox) return;

  imageInput.addEventListener("change", () => {
    const file = imageInput.files[0];
    resultBox.hidden = true;
    if (!file) {
      preview.hidden = true;
      preview.removeAttribute("src");
      status.textContent = "Upload PNG, JPG, or WEBP chart image. Maximum 8 MB.";
      return;
    }
    const allowedTypes = ["image/png", "image/jpeg", "image/webp"];
    if (!allowedTypes.includes(file.type)) {
      imageInput.value = "";
      preview.hidden = true;
      preview.removeAttribute("src");
      status.textContent = "Please select a PNG, JPG, or WEBP image only.";
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      imageInput.value = "";
      preview.hidden = true;
      preview.removeAttribute("src");
      status.textContent = "Image is too large. Maximum allowed size is 8 MB.";
      return;
    }
    preview.src = URL.createObjectURL(file);
    preview.hidden = false;
    status.textContent = `Selected: ${file.name}. Click Analyse with Gemini AI.`;
  });

  analyseButton.addEventListener("click", async () => {
    const file = imageInput.files[0];
    if (!file) {
      status.textContent = "Please upload a chart image first.";
      return;
    }
    const formData = new FormData();
    formData.append("file", file);
    analyseButton.disabled = true;
    analyseButton.textContent = "Analysing Chart...";
    status.textContent = "Gemini is reading the uploaded chart screenshot...";
    resultBox.hidden = true;
    try {
      const response = await fetch("/api/chart-analyser", { method: "POST", body: formData });
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail || "Chart analysis failed.");
      const signal = ["BUY", "SELL", "HOLD"].includes(data.signal) ? data.signal : "HOLD";
      const signalElement = getElement("uploadedChartSignal");
      const color = getSignalColor(signal);
      if (signalElement) {
        signalElement.textContent = signal;
        signalElement.style.color = color;
        signalElement.style.borderColor = color;
      }
      setUploadedChartText("uploadedChartConfidence", `Confidence: ${Number(data.confidence || 0)}%`);
      setUploadedChartText("uploadedChartRisk", data.risk);
      setUploadedChartText("uploadedChartTrend", data.trend);
      setUploadedChartText("uploadedChartPattern", data.pattern);
      setUploadedChartText("uploadedChartSupport", data.support);
      setUploadedChartText("uploadedChartResistance", data.resistance);
      setUploadedChartText("uploadedChartReason", data.reason);
      setUploadedChartText("uploadedChartEntry", data.entry_idea);
      setUploadedChartText("uploadedChartInvalidation", data.invalidation_idea);
      setUploadedChartText("uploadedChartWarning", data.warning);
      resultBox.hidden = false;
      status.textContent = "Chart analysis complete. Educational use only.";
    } catch (error) {
      console.error(error);
      status.textContent = `Chart analysis error: ${error.message}`;
    } finally {
      analyseButton.disabled = false;
      analyseButton.textContent = "Analyse with Gemini AI";
    }
  });
}

function setupGeminiAiButton() {
  const geminiButton = getElement("geminiAiBtn");
  if (!geminiButton) return;
  geminiButton.addEventListener("click", async () => {
    if (aiRefreshInProgress) return;
    geminiButton.disabled = true;
    geminiButton.textContent = "Running Gemini AI...";
    try {
      await loadAiAnalysis();
    } finally {
      geminiButton.disabled = false;
      geminiButton.textContent = "Run Gemini AI Analysis";
    }
  });
}

function setupTechnicalRetryButton() {
  const retryButton = getElement("retryTechnicalBtn");
  if (!retryButton) return;

  retryButton.addEventListener("click", async () => {
    retryButton.disabled = true;
    await refreshTechnicalAnalysis("Retrying live technical analysis.");
    retryButton.disabled = false;
  });
}

function setupLayoutEditor() {
  const container = getElement("customizableSections");
  const editButton = getElement("editLayoutBtn");
  const saveButton = getElement("saveLayoutBtn");
  const resetButton = getElement("resetLayoutBtn");
  if (!container || !editButton || !saveButton || !resetButton) return;

  let editMode = false;
  let draggedCard = null;
  const cards = () => [...container.querySelectorAll(":scope > .layout-editable")];

  const applyHeight = (card, height) => {
    card.classList.remove("layout-height-compact", "layout-height-normal", "layout-height-tall");
    card.classList.add(`layout-height-${height}`);
  };

  const addToolbar = (card) => {
    if (card.querySelector(".layout-editor-toolbar")) return;
    const toolbar = document.createElement("div");
    toolbar.className = "layout-editor-toolbar";
    toolbar.innerHTML = `
      <button class="layout-editor-btn layout-drag-handle" type="button" title="Drag this section">Move</button>
      <button class="layout-editor-btn" type="button" data-height="compact">Compact</button>
      <button class="layout-editor-btn" type="button" data-height="normal">Normal</button>
      <button class="layout-editor-btn" type="button" data-height="tall">Tall</button>
    `;
    card.prepend(toolbar);
    toolbar.querySelectorAll("[data-height]").forEach((button) => {
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        applyHeight(card, button.dataset.height);
      });
    });
  };

  const enableDrag = (card) => {
    if (card.dataset.layoutDragReady === "true") return;
    card.dataset.layoutDragReady = "true";

    card.addEventListener("dragstart", (event) => {
      if (!editMode) {
        event.preventDefault();
        return;
      }
      draggedCard = card;
      card.classList.add("is-dragging");
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", card.dataset.layoutId || "");
    });

    card.addEventListener("dragend", () => {
      card.classList.remove("is-dragging");
      cards().forEach((item) => item.classList.remove("drag-over"));
      draggedCard = null;
    });

    card.addEventListener("dragover", (event) => {
      if (!editMode || !draggedCard || draggedCard === card) return;
      event.preventDefault();
      card.classList.add("drag-over");
      event.dataTransfer.dropEffect = "move";
    });

    card.addEventListener("dragleave", () => {
      card.classList.remove("drag-over");
    });

    card.addEventListener("drop", (event) => {
      if (!editMode || !draggedCard || draggedCard === card) return;
      event.preventDefault();
      const box = card.getBoundingClientRect();
      const placeAfter = event.clientY > box.top + box.height / 2;
      container.insertBefore(draggedCard, placeAfter ? card.nextSibling : card);
      card.classList.remove("drag-over");
    });
  };

  const setEditMode = (enabled) => {
    editMode = enabled;
    container.classList.toggle("layout-edit-mode", enabled);
    cards().forEach((card) => {
      addToolbar(card);
      enableDrag(card);
      card.draggable = enabled;
      if (!enabled) card.classList.remove("is-dragging", "drag-over");
    });
    editButton.hidden = enabled;
    saveButton.hidden = !enabled;
    resetButton.hidden = !enabled;
  };

  const restoreLayout = () => {
    try {
      const stored = JSON.parse(localStorage.getItem(LAYOUT_STORAGE_KEY) || "[]");
      if (!Array.isArray(stored) || !stored.length) return;
      stored.forEach((item) => {
        const card = container.querySelector(`:scope > .layout-editable[data-layout-id="${item.id}"]`);
        if (!card) return;
        container.appendChild(card);
        applyHeight(card, ["compact", "normal", "tall"].includes(item.height) ? item.height : "normal");
      });
    } catch (error) {
      console.warn("Saved dashboard layout could not be restored.", error);
    }
  };

  editButton.addEventListener("click", () => setEditMode(true));
  saveButton.addEventListener("click", () => {
    const layout = cards().map((card) => {
      const height = ["compact", "normal", "tall"].find((name) => card.classList.contains(`layout-height-${name}`)) || "normal";
      return { id: card.dataset.layoutId, height };
    });
    localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(layout));
    setEditMode(false);
  });
  resetButton.addEventListener("click", () => {
    localStorage.removeItem(LAYOUT_STORAGE_KEY);
    window.location.reload();
  });

  restoreLayout();
}

const refreshButton = getElement("refreshBtn");
if (refreshButton) refreshButton.addEventListener("click", refreshAllData);

setupGeminiAiButton();
setupTechnicalRetryButton();
setText("signal-date", formatDateForSignal());
setupPaperTrading();
setupTimeframeButtons();
setupZoomButtons();
setupRrgButtons();
setupChartAnalyser();
setupLayoutEditor();

const savedPlanLoaded = renderSavedAiPlanIfActive();
if (!savedPlanLoaded) {
  setSignalSource("Gemini AI ready — run manual analysis when needed", "neutral");
  setSignal("NO TRADE", "Live technical data is updating. Run Gemini AI Analysis only when you want an AI plan.");
}

refreshAllData();
setInterval(loadPrice, 30000);
setInterval(loadChart, 60000);
setInterval(() => refreshTechnicalAnalysis("Automatic technical refresh."), 60000);
setInterval(loadRrg, 300000);
  if (isAiPlanActive()) {
    setSignalSource(`AI plan active • expires in ${getAiPlanRemainingLabel()}`, "ai");
  }
}, 1000);
