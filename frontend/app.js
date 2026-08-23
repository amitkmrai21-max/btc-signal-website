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
const AI_NEWS_STORAGE_KEY = "btcAiSignalLatestNewsV1";
const NEWS_TRANSLATION_STORAGE_KEY = "btcAiSignalNewsTranslationsV1";
const ALERT_SETTINGS_STORAGE_KEY = "btcAiSignalAlertSettingsV1";
const ALERT_RUNTIME_STORAGE_KEY = "btcAiSignalAlertRuntimeV1";
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

function getElement(id) { return document.getElementById(id); }
function setText(id, value) { const element = getElement(id); if (element) element.textContent = value ?? "--"; }
function formatDateForSignal() { return new Date().toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" }); }
function formatUpdatedAt(timestamp) { return timestamp ? new Date(timestamp * 1000).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "Update time unavailable"; }
function formatUsd(value) { const number = Number(value); return Number.isFinite(number) ? `$${number.toLocaleString("en-US", { maximumFractionDigits: 2 })}` : "--"; }
function formatInr(value) { const number = Number(value); return Number.isFinite(number) ? `₹${number.toLocaleString("en-IN", { maximumFractionDigits: 2 })}` : "₹--"; }
function formatBtc(value) { const number = Number(value); return Number.isFinite(number) ? `${number.toFixed(6)} BTC` : "0.000000 BTC"; }
function formatPercent(value, suffix = "%") { const number = Number(value); return Number.isFinite(number) ? `${number.toFixed(2)}${suffix}` : "--"; }
function formatSignedScore(value) { const number = Number(value); return Number.isFinite(number) ? `${number > 0 ? "+" : ""}${number.toFixed(2)}` : "--"; }
function toNumber(value) { const number = Number(value); return Number.isFinite(number) ? number : null; }

function getSignalColor(signal) {
  if (["STRONG BUY", "BUY", "BUY WATCH"].includes(signal)) return "#22c55e";
  if (["STRONG SELL", "SELL", "SELL WATCH"].includes(signal)) return "#ef4444";
  return "#facc15";
}

function normaliseMainSignal(signal) {
  const allowed = ["STRONG BUY", "BUY WATCH", "NO TRADE", "SELL WATCH", "STRONG SELL", "BUY", "SELL", "HOLD"];
  return allowed.includes(signal) ? signal : "NO TRADE";
}

function setSignal(signal, reason) {
  const normalized = normaliseMainSignal(signal);
  const color = getSignalColor(normalized);
  const signalBox = getElement("signalBox");
  const signalAction = getElement("signal-action");
  if (signalBox) { signalBox.textContent = normalized; signalBox.style.color = color; }
  if (signalAction) { signalAction.textContent = normalized; signalAction.style.color = color; }
  setText("aiSignalText", reason);
}

function setMiniSignal(id, signal) {
  const element = getElement(id);
  if (!element) return;
  const normalized = ["BUY", "SELL", "HOLD"].includes(signal) ? signal : "HOLD";
  const color = getSignalColor(normalized);
  element.textContent = normalized;
  element.style.color = color;
  element.style.borderColor = color;
}

function setRiskBadge(risk) {
  const badge = getElement("riskBadge");
  if (!badge) return;
  const normalized = ["LOW", "MEDIUM", "HIGH"].includes(risk) ? risk : "HIGH";
  badge.textContent = `Risk: ${normalized}`;
  badge.className = `risk-badge risk-${normalized.toLowerCase()}`;
}

function setSignalSource(message, mode = "ai") {
  const element = getElement("signalSource");
  if (!element) return;
  element.textContent = `Signal source: ${message}`;
  element.dataset.mode = mode;
  element.style.color = mode === "ai" ? "#67e8f9" : mode === "technical" ? "#facc15" : "#cbd5e1";
}

function saveLastAiSignal(aiData) {
  const snapshot = { signal: aiData?.signal || "NO TRADE", confidence: aiData?.confidence ?? "--", reason: aiData?.reason || "No AI explanation available.", updatedAt: aiData?.updated_at ? Number(aiData.updated_at) * 1000 : Date.now() };
  try { localStorage.setItem(LAST_AI_SIGNAL_STORAGE_KEY, JSON.stringify(snapshot)); } catch (error) { console.error(error); }
}
function getLastAiSignal() { try { const saved = localStorage.getItem(LAST_AI_SIGNAL_STORAGE_KEY); return saved ? JSON.parse(saved) : null; } catch (error) { console.error(error); return null; } }
function isBuyLike(signal = "") { return String(signal).toUpperCase().includes("BUY"); }
function isSellLike(signal = "") { return String(signal).toUpperCase().includes("SELL"); }
function formatStoredSignalTime(timestamp) { const date = new Date(Number(timestamp)); return timestamp && !Number.isNaN(date.getTime()) ? date.toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "--"; }

function updateSignalConfirmation(technicalData) {
  const lastAi = getLastAiSignal();
  const technicalSignal = technicalData?.signal || "NO TRADE";
  setText("liveTechnicalSignal", technicalSignal);
  setText("liveTechnicalReason", technicalData?.reason || "--");
  setText("liveTechnicalUpdated", `Updated: ${formatUpdatedAt(technicalData?.updated_at)}`);
  if (!lastAi) {
    setText("lastAiSignal", "No previous AI analysis"); setText("lastAiConfidence", "Confidence: --"); setText("lastAiUpdated", "Updated: --");
    setText("combinedDecision", technicalSignal); setText("combinedDecisionReason", "Gemini AI is unavailable. Showing live technical fallback only.");
    return;
  }
  setText("lastAiSignal", lastAi.signal); setText("lastAiConfidence", `Confidence: ${lastAi.confidence}`); setText("lastAiUpdated", `Updated: ${formatStoredSignalTime(lastAi.updatedAt)}`);
  const aiBuy = isBuyLike(lastAi.signal), aiSell = isSellLike(lastAi.signal), technicalBuy = isBuyLike(technicalSignal), technicalSell = isSellLike(technicalSignal);
  let decision = "WAIT FOR CONFIRMATION";
  let reason = "The last AI view and live technical conditions are not fully aligned. Do not force an entry.";
  if ((aiBuy && technicalBuy) || (aiSell && technicalSell)) { decision = aiBuy ? "BUY SETUP CONFIRMED" : "SELL SETUP CONFIRMED"; reason = "The last successful Gemini AI view and current live technical signal are aligned."; }
  else if ((aiBuy && technicalSell) || (aiSell && technicalBuy)) { decision = "AI SIGNAL INVALIDATED — NO ENTRY"; reason = "Current live technical conditions oppose the last Gemini AI signal."; }
  else if (String(technicalSignal).toUpperCase().includes("NO TRADE")) { reason = "The previous AI idea is not currently confirmed by live technical data."; }
  setText("combinedDecision", decision); setText("combinedDecisionReason", reason);
}

function saveAiPlan(aiData) { latestAiPlan = { data: aiData, savedAt: Date.now() }; try { localStorage.setItem(AI_PLAN_STORAGE_KEY, JSON.stringify(latestAiPlan)); } catch (error) { console.error(error); } scheduleAiPlanExpiry(); }
function loadSavedAiPlan() { try { const saved = localStorage.getItem(AI_PLAN_STORAGE_KEY); if (!saved) return null; const plan = JSON.parse(saved); if (!plan?.data || !Number.isFinite(Number(plan.savedAt))) return null; latestAiPlan = plan; return plan; } catch (error) { console.error(error); return null; } }
function getAiPlanAgeMs() { return latestAiPlan?.savedAt ? Date.now() - Number(latestAiPlan.savedAt) : Infinity; }
function isAiPlanActive() { return getAiPlanAgeMs() < AI_PLAN_VALIDITY_MS; }
function getAiPlanRemainingLabel() { const seconds = Math.ceil(Math.max(0, AI_PLAN_VALIDITY_MS - getAiPlanAgeMs()) / 1000); return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`; }

function calculateTechnicalSignal(market15m = {}, market1h = {}) {
  const trend15m = String(market15m.trend || "").toUpperCase(), trend1h = String(market1h.trend || "").toUpperCase();
  const macd15m = String(market15m?.macd?.state || "").toUpperCase(), macd1h = String(market1h?.macd?.state || "").toUpperCase();
  const breakout = String(market15m.breakout_status || "").toUpperCase();
  const rsi15m = toNumber(market15m.rsi_14), rsi1h = toNumber(market1h.rsi_14), momentum15m = toNumber(market15m.momentum_percent), volumeRatio = toNumber(market15m?.volume?.volume_ratio);
  const bullishTrend = trend15m.includes("BULL") || trend1h.includes("BULL"), bearishTrend = trend15m.includes("BEAR") || trend1h.includes("BEAR");
  const bullishMacd = macd15m.includes("BULL") || macd1h.includes("BULL"), bearishMacd = macd15m.includes("BEAR") || macd1h.includes("BEAR");
  const bullishBreakout = breakout.includes("BREAKOUT") && !breakout.includes("BEAR"), bearishBreakdown = breakout.includes("BREAKDOWN") || breakout.includes("BEAR");
  const bullishMomentum = (rsi15m !== null && rsi15m >= 52 && rsi15m <= 72) || (rsi1h !== null && rsi1h >= 50 && rsi1h <= 72) || (momentum15m !== null && momentum15m > 0);
  const bearishMomentum = (rsi15m !== null && rsi15m <= 48 && rsi15m >= 28) || (rsi1h !== null && rsi1h <= 50 && rsi1h >= 28) || (momentum15m !== null && momentum15m < 0);
  const volumeConfirmed = volumeRatio !== null && volumeRatio >= 1;
  let buyScore = 0, sellScore = 0;
  if (bullishTrend) buyScore += 2; if (bullishMacd) buyScore += 2; if (bullishMomentum) buyScore += 1; if (bullishBreakout) buyScore += 2; if (volumeConfirmed) buyScore += 1;
  if (bearishTrend) sellScore += 2; if (bearishMacd) sellScore += 2; if (bearishMomentum) sellScore += 1; if (bearishBreakdown) sellScore += 2; if (volumeConfirmed) sellScore += 1;
  if (buyScore >= 5 && buyScore > sellScore + 1) return { signal: "BUY WATCH", reason: "Technical confirmation is bullish: trend, momentum and/or breakout conditions are aligned.", score: buyScore };
  if (sellScore >= 5 && sellScore > buyScore + 1) return { signal: "SELL WATCH", reason: "Technical confirmation is bearish: trend, momentum and/or breakdown conditions are aligned.", score: sellScore };
  return { signal: "NO TRADE", reason: "Technical conditions are mixed or lack enough confirmation. Wait for trend, momentum and volume alignment.", score: Math.max(buyScore, sellScore) };
}
function getTechnicalConfidence(technical) { const score = Number(technical?.score || 0); return ["BUY WATCH", "SELL WATCH"].includes(technical?.signal) ? Math.min(85, 50 + score * 7) : Math.min(55, 25 + score * 6); }

async function fetchWithTimeout(url, options = {}, timeoutMs = TECHNICAL_TIMEOUT_MS) {
  const controller = new AbortController(); const timeoutId = window.setTimeout(() => controller.abort(), timeoutMs);
  try { return await fetch(url, { ...options, signal: controller.signal }); }
  catch (error) { if (error?.name === "AbortError") throw new Error(`Technical request timed out after ${Math.round(timeoutMs / 1000)} seconds.`); throw error; }
  finally { window.clearTimeout(timeoutId); }
}

function setTechnicalRefreshState(state = "idle", message = "") {
  const retry = getElement("retryTechnicalBtn"), refresh = getElement("refreshBtn");
  if (retry) { retry.hidden = state !== "error"; retry.disabled = state === "loading"; }
  if (refresh) { refresh.disabled = state === "loading"; refresh.textContent = state === "loading" ? "Refreshing..." : "Refresh Technical"; }
  if (message) setText("technicalRefreshStatus", message);
}
function setDataHealthBadge(health = {}) {
  const badge = getElement("technicalDataHealth"); if (!badge) return;
  const status = ["LIVE", "CACHED", "DELAYED", "ERROR"].includes(health.status) ? health.status : "ERROR";
  const age = Number(health.cache_age_seconds); const ageText = Number.isFinite(age) ? ` • ${age.toFixed(1)}s old` : "";
  badge.textContent = `Data: ${status}${status === "LIVE" ? "" : ageText}`; badge.className = `data-health-badge health-${status.toLowerCase()}`;
}

function getDynamicGeminiAlignment(technicalData) {
  const lastAi = getLastAiSignal();
  const technicalSignal = String(
    technicalData?.signal || "NO TRADE"
  ).toUpperCase();

  if (!lastAi?.signal) {
    return {
      state: "WAIT",
      reason: "No recent Gemini AI plan is available. Run Gemini AI Analysis for a fresh comparison.",
      riskFlag: null
    };
  }

  const aiSignal = String(lastAi.signal || "NO TRADE").toUpperCase();
  const aiBuy = isBuyLike(aiSignal);
  const aiSell = isSellLike(aiSignal);
  const technicalBuy = isBuyLike(technicalSignal);
  const technicalSell = isSellLike(technicalSignal);
  const aiNoTrade = aiSignal.includes("NO TRADE") || aiSignal.includes("HOLD");
  const technicalNoTrade =
    technicalSignal.includes("NO TRADE") || technicalSignal.includes("HOLD");

  if ((aiBuy && technicalBuy) || (aiSell && technicalSell)) {
    return {
      state: "PASS",
      reason: `Gemini ${aiSignal} and live technical ${technicalSignal} are aligned.`,
      riskFlag: null
    };
  }

  if ((aiBuy && technicalSell) || (aiSell && technicalBuy)) {
    return {
      state: "FAIL",
      reason: `Gemini ${aiSignal} conflicts with live technical ${technicalSignal}. Do not force an entry.`,
      riskFlag: "Gemini AI conflicts with live technical direction"
    };
  }

  if (aiNoTrade && technicalNoTrade) {
    return {
      state: "PASS",
      reason: "Gemini AI and live technical analysis both indicate caution / no trade.",
      riskFlag: null
    };
  }

  if (technicalNoTrade) {
    return {
      state: "WAIT",
      reason: `Gemini ${aiSignal} is not confirmed because live technical status is ${technicalSignal}.`,
      riskFlag: null
    };
  }

  if (aiNoTrade) {
    return {
      state: "WAIT",
      reason: `Live technical shows ${technicalSignal}, but Gemini AI remains cautious (${aiSignal}).`,
      riskFlag: null
    };
  }

  return {
    state: "WAIT",
    reason: `Gemini ${aiSignal} and live technical ${technicalSignal} need further confirmation.`,
    riskFlag: null
  };
}

function calculateDynamicSetupDecision(setup, items, flags) {
  const passed = items.filter((item) => item.state === "PASS").length;
  const waiting = items.filter((item) => item.state === "WAIT").length;
  const failed = items.filter((item) => item.state === "FAIL").length;

  const direction = String(setup?.direction || "NEUTRAL").toUpperCase();

  const hasGeminiConflict = flags.includes(
    "Gemini AI conflicts with live technical direction"
  );

  let grade = "C";
  let executionState = "WAIT FOR CONFIRMATION";
  let decisionReason =
    "The setup is mixed. Wait for stronger trend, momentum and volume confirmation.";

  if (hasGeminiConflict || failed >= 4) {
    grade = "D";
    executionState = "AVOID";

    decisionReason = hasGeminiConflict
      ? "Gemini AI and live technical direction conflict. Avoid forcing a practice entry."
      : "Too many checklist conditions are failing. Avoid forcing a practice entry.";
  } else if (passed >= 7 && failed === 0) {
    grade = "A";
    executionState = "READY";

    decisionReason =
      "Most technical conditions and Gemini alignment are supportive. Wait for the stated trigger and define invalidation.";
  } else if (passed >= 5 && failed <= 1) {
    grade = "B";
    executionState = "WAIT FOR TRIGGER";

    decisionReason =
      "The setup is developing well, but a price trigger or one more confirmation is still needed.";
  } else if (passed >= 3 && failed <= 2) {
    grade = "C";
    executionState = "WAIT FOR CONFIRMATION";

    decisionReason =
      "Some conditions are supportive, but the setup is not sufficiently aligned yet.";
  } else if (direction === "NEUTRAL" && failed >= 3) {
    grade = "D";
    executionState = "AVOID";

    decisionReason =
      "The market is mixed and several checklist conditions are failing. Wait for clearer alignment.";
  }

  return {
    passed,
    waiting,
    failed,
    total: items.length,
    grade,
    executionState,
    decisionReason
  };
}

function renderSetupQuality(data) {
  const setup = data?.setup_quality || {};
  const originalItems = Array.isArray(setup.items) ? setup.items : [];
  const items = originalItems.map((item) => ({ ...item }));
  const flags = Array.isArray(setup.risk_flags) ? [...setup.risk_flags] : [];

  const alignment = getDynamicGeminiAlignment(data);

  const alignmentItem = {
    key: "ai_alignment",
    label: "Gemini AI vs live technical alignment",
    state: alignment.state,
    reason: alignment.reason
  };

  const alignmentIndex = items.findIndex(
    (item) => item?.key === "ai_alignment"
  );

  if (alignmentIndex >= 0) {
    items[alignmentIndex] = alignmentItem;
  } else {
    items.push(alignmentItem);
  }

  if (alignment.riskFlag && !flags.includes(alignment.riskFlag)) {
    flags.push(alignment.riskFlag);
  }

  const dynamic = calculateDynamicSetupDecision(setup, items, flags);

  setText("setupGrade", dynamic.grade);
  setText(
    "setupScore",
    `${dynamic.passed} / ${dynamic.total} checks passed • ${dynamic.waiting} wait • ${dynamic.failed} fail`
  );
  setText("setupDirection", setup.direction || "--");
  setText("setupDecisionReason", dynamic.decisionReason);

  setText(
    "setupRiskFlagCount",
    flags.length
      ? `${flags.length} flag${flags.length === 1 ? "" : "s"}`
      : "No major flags"
  );

  setText(
    "setupRiskFlags",
    flags.length
      ? flags.join(" • ")
      : "No major technical risk flags detected by the current checklist."
  );

  const badge = getElement("setupExecutionState");

  if (badge) {
    badge.textContent = dynamic.executionState;
    badge.className = `setup-execution-badge setup-state-${dynamic.executionState
      .toLowerCase()
      .replace(/[^a-z]+/g, "-")}`;
  }

  const checklist = getElement("setupChecklist");

  if (!checklist) return;

  checklist.innerHTML = "";

  if (!items.length) {
    const empty = document.createElement("p");
    empty.className = "setup-checklist-loading";
    empty.textContent = "Setup checklist data is not available yet.";
    checklist.appendChild(empty);
    return;
  }

  items.forEach((item) => {
    const itemState = ["PASS", "WAIT", "FAIL"].includes(
      String(item?.state || "").toUpperCase()
    )
      ? String(item.state).toUpperCase()
      : "WAIT";

    const row = document.createElement("article");
    row.className = `setup-check-item setup-check-${itemState.toLowerCase()}`;

    const top = document.createElement("div");
    top.className = "setup-check-top";

    const label = document.createElement("h3");
    label.textContent = item?.label || "Checklist item";

    const stateBadge = document.createElement("span");
    stateBadge.className = "setup-check-state";
    stateBadge.textContent = itemState;

    const reason = document.createElement("p");
    reason.textContent = item?.reason || "No detail available.";

    top.append(label, stateBadge);
    row.append(top, reason);
    checklist.appendChild(row);
  });
}

function renderTechnicalIntelligence(data) {
  const health = data?.data_health || {}, score = data?.score_breakdown || {}, regime = data?.market_regime || {}, agreement = data?.timeframe_agreement || {}, levels = data?.key_level_distance || {};
  setDataHealthBadge(health); setText("technicalHealthMessage", health.message || "Technical data status unavailable."); setText("technicalRefreshStatus", `Updated: ${formatUpdatedAt(data?.updated_at)}${data?.cached ? " • cached response" : ""}`);
  setText("marketRegime", regime.label || "--"); setText("marketRegimeDetail", regime.detail || "--"); setText("regimeStats", `ADX ${formatPercent(regime.average_adx, "")} • ATR ${formatPercent(regime.average_atr_percent)} • BB Width ${formatPercent(regime.average_bollinger_width_percent)}`);
  const percent = Number(agreement.percent); setText("timeframeAgreement", Number.isFinite(percent) ? `${percent.toFixed(0)}%` : "--"); setText("timeframeAgreementDetail", agreement.direction || "--"); setText("timeframeVotes", `Bullish ${agreement.bullish_votes ?? 0} • Bearish ${agreement.bearish_votes ?? 0} • Hold ${agreement.hold_votes ?? 0}`);
  const bar = getElement("timeframeAgreementBar"); if (bar) bar.style.width = `${Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : 0}%`;
  setText("scoreTrend", formatSignedScore(score?.trend?.score)); setText("scoreMacd", formatSignedScore(score?.macd?.score)); setText("scoreMomentum", formatSignedScore(score?.momentum?.score)); setText("scoreBreakout", formatSignedScore(score?.breakout?.score)); setText("scoreVolume", formatSignedScore(score?.volume?.score));
  const totalScore = Number(score.total_score), alignment = Number(score.technical_alignment_percent); setText("technicalScoreTotal", Number.isFinite(totalScore) ? `${formatSignedScore(totalScore)} / 9` : "--"); setText("technicalAlignment", Number.isFinite(alignment) ? `${alignment.toFixed(0)}% alignment` : "--"); setText("technicalScoreBias", score.bias || "--");
  ["15m", "1h", "4h"].forEach((timeframe) => { const level = levels?.[timeframe] || {}; const id = timeframe === "15m" ? "15m" : timeframe; setText(`level${id}Price`, formatUsd(level.price)); setText(`level${id}Support`, formatUsd(level.support)); setText(`level${id}Resistance`, formatUsd(level.resistance)); const supportDistance = Number(level.support_distance_percent), resistanceDistance = Number(level.resistance_distance_percent); setText(`level${id}SupportDistance`, Number.isFinite(supportDistance) ? `${supportDistance.toFixed(2)}% below` : "--"); setText(`level${id}ResistanceDistance`, Number.isFinite(resistanceDistance) ? `${resistanceDistance.toFixed(2)}% above` : "--"); });
}

function updateIndicators(m15, m1h) {
  setText("trend15m", m15.trend); setText("rsi15m", m15.rsi_14); setText("macd15m", m15?.macd?.state); setText("adx15m", `${m15?.adx?.adx_14 ?? "--"} (${m15?.adx?.trend_strength ?? "--"})`); setText("momentum15m", `${m15?.momentum_percent ?? "--"}%`);
  setText("trend1h", m1h.trend); setText("rsi1h", m1h.rsi_14); setText("macd1h", m1h?.macd?.state); setText("adx1h", `${m1h?.adx?.adx_14 ?? "--"} (${m1h?.adx?.trend_strength ?? "--"})`); setText("momentum1h", `${m1h?.momentum_percent ?? "--"}%`);
  setText("volume15m", `x${m15?.volume?.volume_ratio ?? "--"}`); setText("volume1h", `x${m1h?.volume?.volume_ratio ?? "--"}`); setText("pattern15m", m15.candle_pattern); setText("pattern1h", m1h.candle_pattern); setText("breakout15m", m15.breakout_status); setText("support15m", formatUsd(m15?.support_resistance?.support_20)); setText("resistance15m", formatUsd(m15?.support_resistance?.resistance_20)); setText("support1h", formatUsd(m1h?.support_resistance?.support_20)); setText("resistance1h", formatUsd(m1h?.support_resistance?.resistance_20)); setText("structure1h", m1h.market_structure);
}

async function loadTechnicalFallback(prefix = "Live technical analysis refreshed.", forceRefresh = false) {
  if (technicalRefreshInProgress) return latestTechnicalResponse;
  technicalRefreshInProgress = true; setTechnicalRefreshState("loading", "Refreshing technical data…");
  try {
    const response = await fetchWithTimeout(forceRefresh ? "/api/technical-signal?force_refresh=true" : "/api/technical-signal", { cache: "no-store" }); const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.detail || "Technical signal API could not be loaded.");
    latestTechnicalResponse = data; latestTechnicalMarket = data?.market_data?.timeframes || {};
    updateIndicators(latestTechnicalMarket["15m"] || {}, latestTechnicalMarket["1h"] || {});
    ["15m", "1h", "4h"].forEach((frame) => { const item = data?.timeframes?.[frame] || {}; const key = frame === "15m" ? "15m" : frame; setMiniSignal(`signal${key}`, item.signal); setText(`summary${key}`, item.summary); setText(`keyLevel${key}`, item.key_level); });
    setText("marketBias", data.market_bias); setText("setupStatus", data.setup_status); setText("confirmationNeeded", data.confirmation_needed); setText("target1", data.target_1); setText("target2", data.target_2);
    setSignal(data.signal, `${prefix} ${data.reason}`); const technical = calculateTechnicalSignal(latestTechnicalMarket["15m"] || {}, latestTechnicalMarket["1h"] || {}); setText("aiConfidence", `Technical confidence: ${getTechnicalConfidence(technical)}%`); setText("entryIdea", data.entry_idea); setText("stopLossIdea", data.stop_loss_idea); setRiskBadge(data.risk); updateSignalConfirmation(data); setSignalSource("Live technical fallback — AI unavailable or expired", "technical"); setText("analysisUpdatedAt", "Gemini AI unavailable; live Binance technical analysis is active.");
    renderTechnicalIntelligence(data); renderSetupQuality(data); setTechnicalRefreshState("idle", `Technical data updated: ${formatUpdatedAt(data.updated_at)}.`); return data;
  } catch (error) {
    console.error(error); renderTechnicalFallback(prefix); setDataHealthBadge({ status: "ERROR" }); setText("technicalHealthMessage", error.message || "Technical data could not be refreshed."); renderSetupQuality(null); setTechnicalRefreshState("error", `Technical refresh failed: ${error.message || "Please retry."}`); return null;
  } finally { technicalRefreshInProgress = false; const refresh = getElement("refreshBtn"); if (refresh) { refresh.disabled = false; refresh.textContent = "Refresh Technical"; } }
}

function renderTechnicalFallback(prefix = "Gemini AI is temporarily unavailable.") { const m15 = latestTechnicalMarket?.["15m"] || {}, m1h = latestTechnicalMarket?.["1h"] || {}, technical = calculateTechnicalSignal(m15, m1h); setSignal(technical.signal, `${prefix} ${technical.reason}`); setRiskBadge(technical.signal === "NO TRADE" ? "HIGH" : "MEDIUM"); setSignalSource("Live technical fallback — AI unavailable or expired", "technical"); setText("analysisUpdatedAt", `Live technical fallback active • updated ${new Date().toLocaleTimeString("en-IN")}`); updateSignalConfirmation(technical); setText("aiConfidence", `Technical confidence: ${getTechnicalConfidence(technical)}%`); }
function scheduleAiPlanExpiry() { if (aiPlanTimer) clearTimeout(aiPlanTimer); const remaining = AI_PLAN_VALIDITY_MS - getAiPlanAgeMs(); if (remaining <= 0) { loadTechnicalFallback("AI plan expired."); return; } aiPlanTimer = setTimeout(() => loadTechnicalFallback("AI plan expired."), remaining + 100); }
function renderSavedAiPlanIfActive() { const plan = latestAiPlan || loadSavedAiPlan(); if (plan && isAiPlanActive()) { updateAiAnalysis(plan.data, true); return true; } return false; }

function getDefaultPaperPortfolio() { return { cashInr: DEFAULT_PAPER_CASH, btcHolding: 0, totalCostInr: 0, shortBtcHolding: 0, shortProceedsInr: 0, history: [] }; }
function normalisePaperPortfolio(p) { return { cashInr: Math.max(0, Number(p.cashInr) || 0), btcHolding: Math.max(0, Number(p.btcHolding) || 0), totalCostInr: Math.max(0, Number(p.totalCostInr) || 0), shortBtcHolding: Math.max(0, Number(p.shortBtcHolding) || 0), shortProceedsInr: Math.max(0, Number(p.shortProceedsInr) || 0), history: Array.isArray(p.history) ? p.history.slice(0, 50) : [] }; }
function loadPaperPortfolio() { try { const saved = localStorage.getItem(PAPER_STORAGE_KEY); if (saved) return normalisePaperPortfolio(JSON.parse(saved)); const legacy = localStorage.getItem("btcAiSignalPaperPortfolioV1"); if (!legacy) return getDefaultPaperPortfolio(); const p = JSON.parse(legacy); return normalisePaperPortfolio({ ...p, shortBtcHolding: 0, shortProceedsInr: 0 }); } catch { return getDefaultPaperPortfolio(); } }
function savePaperPortfolio(p) { localStorage.setItem(PAPER_STORAGE_KEY, JSON.stringify(normalisePaperPortfolio(p))); }
function addPaperTrade(p, type, amountInr, btcAmount) { p.history.unshift({ type, amountInr, btcAmount, priceInr: currentBtcPriceInr, timestamp: Date.now() }); p.history = p.history.slice(0, 50); }
function renderPaperHistory(history) { const box = getElement("paperTradeHistory"); if (!box) return; if (!history.length) { box.textContent = "No virtual trades yet."; return; } box.innerHTML = ""; history.forEach((trade) => { const item = document.createElement("div"); const date = new Date(trade.timestamp).toLocaleString("en-IN", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }); item.className = `history-item ${trade.type.includes("SELL") || trade.type.includes("SHORT") ? "history-sell" : "history-buy"}`; item.textContent = `${trade.type} • ${formatInr(trade.amountInr)} • ${formatBtc(trade.btcAmount)} • ${date}`; box.appendChild(item); }); }
function renderPaperTrading() { const p = loadPaperPortfolio(), mark = Number(currentBtcPriceInr) || 0, value = p.cashInr + p.btcHolding * mark - p.shortBtcHolding * mark, pnl = value - DEFAULT_PAPER_CASH, pct = (pnl / DEFAULT_PAPER_CASH) * 100; const longAvg = p.btcHolding > PAPER_EPSILON ? p.totalCostInr / p.btcHolding : 0, shortAvg = p.shortBtcHolding > PAPER_EPSILON ? p.shortProceedsInr / p.shortBtcHolding : 0; const position = p.btcHolding > PAPER_EPSILON ? "LONG BTC" : p.shortBtcHolding > PAPER_EPSILON ? "SHORT BTC" : "No open position"; setText("paperCash", formatInr(p.cashInr)); setText("paperBtcHolding", formatBtc(p.btcHolding)); setText("paperShortBtcHolding", formatBtc(p.shortBtcHolding)); setText("paperPositionType", position); setText("paperAvgPrice", p.btcHolding > PAPER_EPSILON ? formatInr(longAvg) : "No long position"); setText("paperShortAvgPrice", p.shortBtcHolding > PAPER_EPSILON ? formatInr(shortAvg) : "No short position"); setText("paperPortfolioValue", formatInr(value)); const pos = getElement("paperPositionType"), pnlElement = getElement("paperPnl"); if (pos) pos.style.color = position === "LONG BTC" ? "#22c55e" : position === "SHORT BTC" ? "#ef4444" : "#cbd5e1"; if (pnlElement) { const prefix = pnl >= 0 ? "+" : ""; pnlElement.textContent = `${prefix}${formatInr(pnl)} (${prefix}${pct.toFixed(2)}%)`; pnlElement.style.color = pnl >= 0 ? "#22c55e" : "#ef4444"; } renderPaperHistory(p.history); }

function getDefaultAlertSettings() {
  return {
    priceAbove: null,
    priceBelow: null,
    signalChangeEnabled: true,
    riskChangeEnabled: true,
    setupGradeChangeEnabled: true
  };
}

function getAlertSettings() {
  try {
    const raw = localStorage.getItem(ALERT_SETTINGS_STORAGE_KEY);
    const saved = raw ? JSON.parse(raw) : {};
    const defaults = getDefaultAlertSettings();

    return {
      ...defaults,
      ...saved,
      priceAbove:
        Number(saved?.priceAbove) > 0 ? Number(saved.priceAbove) : null,
      priceBelow:
        Number(saved?.priceBelow) > 0 ? Number(saved.priceBelow) : null,
      signalChangeEnabled: saved?.signalChangeEnabled !== false,
      riskChangeEnabled: saved?.riskChangeEnabled !== false,
      setupGradeChangeEnabled: saved?.setupGradeChangeEnabled !== false
    };
  } catch (error) {
    console.error(error);
    return getDefaultAlertSettings();
  }
}

function saveAlertSettings(settings) {
  try {
    localStorage.setItem(
      ALERT_SETTINGS_STORAGE_KEY,
      JSON.stringify(settings)
    );
  } catch (error) {
    console.error(error);
  }
}

function getDefaultAlertRuntime() {
  return {
    lastPrice: null,
    aboveTriggeredFor: null,
    belowTriggeredFor: null,
    previousTechnicalSignal: null,
    previousRisk: null,
    previousSetupGrade: null,
    lastAlertMessage: "",
    lastAlertAt: null
  };
}

function getAlertRuntime() {
  try {
    const raw = localStorage.getItem(ALERT_RUNTIME_STORAGE_KEY);
    const saved = raw ? JSON.parse(raw) : {};
    return { ...getDefaultAlertRuntime(), ...saved };
  } catch (error) {
    console.error(error);
    return getDefaultAlertRuntime();
  }
}

function saveAlertRuntime(runtime) {
  try {
    localStorage.setItem(
      ALERT_RUNTIME_STORAGE_KEY,
      JSON.stringify(runtime)
    );
  } catch (error) {
    console.error(error);
  }
}

function getNotificationPermission() {
  if (!("Notification" in window)) return "unsupported";
  return Notification.permission;
}

function updateNotificationUi(message = "") {
  const badge = getElement("notificationPermissionBadge");
  const status = getElement("notificationStatus");
  const enableButton = getElement("enableNotificationsBtn");
  const testButton = getElement("testNotificationBtn");
  const permission = getNotificationPermission();

  const labels = {
    granted: "Notifications: Enabled",
    denied: "Notifications: Blocked",
    default: "Notifications: Permission needed",
    unsupported: "Notifications: Unsupported"
  };

  if (badge) {
    badge.textContent = labels[permission] || labels.default;
    badge.className = `notification-permission-badge notification-${permission}`;
  }

  if (enableButton) {
    enableButton.hidden = permission === "granted" || permission === "unsupported";
    enableButton.disabled = permission === "denied";
  }

  if (testButton) {
    testButton.disabled = permission !== "granted";
  }

  if (status) {
    if (message) {
      status.textContent = message;
    } else if (permission === "granted") {
      status.textContent =
        "Browser alerts are enabled for this dashboard while it remains open.";
    } else if (permission === "denied") {
      status.textContent =
        "Notifications are blocked in browser settings. Allow notifications for this site, then reload.";
    } else if (permission === "unsupported") {
      status.textContent =
        "This browser does not support desktop/browser notifications.";
    } else {
      status.textContent =
        "Enable browser alerts to receive price and technical-change notifications.";
    }
  }
}

function sendBrowserAlert(title, body, options = {}) {
  const runtime = getAlertRuntime();
  const message = `${title}: ${body}`;

  runtime.lastAlertMessage = message;
  runtime.lastAlertAt = Date.now();
  saveAlertRuntime(runtime);

  setText(
    "lastAlertStatus",
    `${message} • ${new Date(runtime.lastAlertAt).toLocaleString("en-IN", {
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit"
    })}`
  );

  if (getNotificationPermission() !== "granted") {
    updateNotificationUi(
      "Alert condition detected, but browser notifications are not enabled."
    );
    return false;
  }

  try {
    const notification = new Notification(title, {
      body,
      icon: "/frontend/image-1.png",
      tag: options.tag || "btc-ai-signal-alert",
      renotify: true
    });

    notification.onclick = () => {
      window.focus();
      notification.close();
    };

    return true;
  } catch (error) {
    console.error(error);
    updateNotificationUi("Browser could not display the notification.");
    return false;
  }
}

async function requestBrowserNotifications() {
  if (!("Notification" in window)) {
    updateNotificationUi(
      "This browser does not support desktop/browser notifications."
    );
    return;
  }

  if (Notification.permission === "denied") {
    updateNotificationUi(
      "Notifications are blocked. Open browser site settings, allow notifications, then reload."
    );
    return;
  }

  try {
    const permission = await Notification.requestPermission();

    updateNotificationUi(
      permission === "granted"
        ? "Browser alerts enabled. Use Test Alert to verify."
        : "Permission was not granted. Alerts will remain on-screen only."
    );
  } catch (error) {
    console.error(error);
    updateNotificationUi("Could not request notification permission.");
  }
}

function formatAlertTarget(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? formatUsd(number) : "Not set";
}

function renderAlertSettings() {
  const settings = getAlertSettings();
  const runtime = getAlertRuntime();

  const aboveInput = getElement("priceAboveInput");
  const belowInput = getElement("priceBelowInput");
  const signalToggle = getElement("signalChangeAlertToggle");
  const riskToggle = getElement("riskChangeAlertToggle");
  const setupToggle = getElement("setupGradeAlertToggle");

  if (aboveInput) aboveInput.value = settings.priceAbove || "";
  if (belowInput) belowInput.value = settings.priceBelow || "";
  if (signalToggle) signalToggle.checked = settings.signalChangeEnabled;
  if (riskToggle) riskToggle.checked = settings.riskChangeEnabled;
  if (setupToggle) setupToggle.checked = settings.setupGradeChangeEnabled;

  setText(
    "priceAboveStatus",
    settings.priceAbove
      ? `Active: alert at or above ${formatAlertTarget(settings.priceAbove)}.`
      : "No above-price alert is active."
  );

  setText(
    "priceBelowStatus",
    settings.priceBelow
      ? `Active: alert at or below ${formatAlertTarget(settings.priceBelow)}.`
      : "No below-price alert is active."
  );

  setText(
    "lastAlertStatus",
    runtime.lastAlertMessage
      ? `${runtime.lastAlertMessage} • ${new Date(
          runtime.lastAlertAt
        ).toLocaleString("en-IN", {
          day: "2-digit",
          month: "short",
          hour: "2-digit",
          minute: "2-digit"
        })}`
      : "No alert triggered yet"
  );

  updateNotificationUi();
}

function savePriceAlert(type) {
  const inputId = type === "above" ? "priceAboveInput" : "priceBelowInput";
  const input = getElement(inputId);
  const value = Number(input?.value);
  const settings = getAlertSettings();
  const runtime = getAlertRuntime();

  if (!Number.isFinite(value) || value <= 0) {
    settings[type === "above" ? "priceAbove" : "priceBelow"] = null;

    if (type === "above") runtime.aboveTriggeredFor = null;
    else runtime.belowTriggeredFor = null;

    saveAlertSettings(settings);
    saveAlertRuntime(runtime);
    renderAlertSettings();

    setText(
      type === "above" ? "priceAboveStatus" : "priceBelowStatus",
      `Alert cleared. Enter a valid target to save a new ${
        type === "above" ? "above-price" : "below-price"
      } alert.`
    );
    return;
  }

  const key = type === "above" ? "priceAbove" : "priceBelow";
  settings[key] = value;

  if (type === "above") runtime.aboveTriggeredFor = null;
  else runtime.belowTriggeredFor = null;

  saveAlertSettings(settings);
  saveAlertRuntime(runtime);
  renderAlertSettings();

  setText(
    type === "above" ? "priceAboveStatus" : "priceBelowStatus",
    `Saved: alert at or ${type === "above" ? "above" : "below"} ${formatUsd(
      value
    )}.`
  );
}

function updateAlertToggle(settingKey, checked) {
  const settings = getAlertSettings();
  settings[settingKey] = Boolean(checked);
  saveAlertSettings(settings);
  renderAlertSettings();
}

function checkPriceAlerts(price) {
  const currentPrice = Number(price);

  if (!Number.isFinite(currentPrice) || currentPrice <= 0) return;

  const settings = getAlertSettings();
  const runtime = getAlertRuntime();
  const previousPrice = Number(runtime.lastPrice);

  setText("alertCurrentBtcPrice", formatUsd(currentPrice));

  if (
    settings.priceAbove &&
    currentPrice >= settings.priceAbove &&
    runtime.aboveTriggeredFor !== settings.priceAbove &&
    (!Number.isFinite(previousPrice) || previousPrice < settings.priceAbove)
  ) {
    runtime.aboveTriggeredFor = settings.priceAbove;
    runtime.lastPrice = currentPrice;
    saveAlertRuntime(runtime);

    sendBrowserAlert(
      "BTC Price Alert",
      `BTC reached ${formatUsd(currentPrice)}, at or above your target of ${formatUsd(
        settings.priceAbove
      )}.`,
      { tag: `btc-above-${settings.priceAbove}` }
    );
  }

  if (
    settings.priceBelow &&
    currentPrice <= settings.priceBelow &&
    runtime.belowTriggeredFor !== settings.priceBelow &&
    (!Number.isFinite(previousPrice) || previousPrice > settings.priceBelow)
  ) {
    runtime.belowTriggeredFor = settings.priceBelow;
    runtime.lastPrice = currentPrice;
    saveAlertRuntime(runtime);

    sendBrowserAlert(
      "BTC Price Alert",
      `BTC reached ${formatUsd(currentPrice)}, at or below your target of ${formatUsd(
        settings.priceBelow
      )}.`,
      { tag: `btc-below-${settings.priceBelow}` }
    );
  }

  if (
    settings.priceAbove &&
    currentPrice < settings.priceAbove &&
    runtime.aboveTriggeredFor === settings.priceAbove
  ) {
    runtime.aboveTriggeredFor = null;
  }

  if (
    settings.priceBelow &&
    currentPrice > settings.priceBelow &&
    runtime.belowTriggeredFor === settings.priceBelow
  ) {
    runtime.belowTriggeredFor = null;
  }

  runtime.lastPrice = currentPrice;
  saveAlertRuntime(runtime);
}

function getSetupGradeForAlerts() {
  const grade = String(
    getElement("setupGrade")?.textContent || ""
  ).toUpperCase();

  return ["A", "B", "C", "D"].includes(grade) ? grade : null;
}

function checkTechnicalAlerts(data) {
  if (!data) return;

  const settings = getAlertSettings();
  const runtime = getAlertRuntime();
  const signal = String(data?.signal || "").toUpperCase() || null;
  const risk = String(data?.risk || "").toUpperCase() || null;
  const grade = getSetupGradeForAlerts();

  setText(
    "alertTechnicalWatchStatus",
    `${signal || "Unknown"} • Risk ${risk || "--"} • Grade ${grade || "--"}`
  );

  if (
    settings.signalChangeEnabled &&
    runtime.previousTechnicalSignal &&
    signal &&
    runtime.previousTechnicalSignal !== signal
  ) {
    sendBrowserAlert(
      "BTC Technical Signal Changed",
      `${runtime.previousTechnicalSignal} changed to ${signal}. Review live technical conditions before taking any action.`,
      { tag: "btc-signal-change" }
    );
  }

  if (
    settings.riskChangeEnabled &&
    runtime.previousRisk &&
    risk &&
    runtime.previousRisk !== risk
  ) {
    sendBrowserAlert(
      "BTC Risk Level Changed",
      `Risk changed from ${runtime.previousRisk} to ${risk}.`,
      { tag: "btc-risk-change" }
    );
  }

  if (
    settings.setupGradeChangeEnabled &&
    runtime.previousSetupGrade &&
    grade &&
    runtime.previousSetupGrade !== grade
  ) {
    sendBrowserAlert(
      "BTC Setup Grade Changed",
      `Setup grade changed from ${runtime.previousSetupGrade} to ${grade}.`,
      { tag: "btc-grade-change" }
    );
  }

  runtime.previousTechnicalSignal = signal;
  runtime.previousRisk = risk;
  runtime.previousSetupGrade = grade;
  saveAlertRuntime(runtime);
}

function setupAlerts() {
  const enableButton = getElement("enableNotificationsBtn");
  const testButton = getElement("testNotificationBtn");
  const saveAboveButton = getElement("savePriceAboveBtn");
  const saveBelowButton = getElement("savePriceBelowBtn");
  const signalToggle = getElement("signalChangeAlertToggle");
  const riskToggle = getElement("riskChangeAlertToggle");
  const setupToggle = getElement("setupGradeAlertToggle");

  if (enableButton) {
    enableButton.addEventListener("click", requestBrowserNotifications);
  }

  if (testButton) {
    testButton.addEventListener("click", () => {
      sendBrowserAlert(
        "BTC AI Signal Test Alert",
        "Browser alerts are working. This is a test notification.",
        { tag: "btc-ai-signal-test" }
      );
    });
  }

  if (saveAboveButton) {
    saveAboveButton.addEventListener("click", () => savePriceAlert("above"));
  }

  if (saveBelowButton) {
    saveBelowButton.addEventListener("click", () => savePriceAlert("below"));
  }

  if (signalToggle) {
    signalToggle.addEventListener("change", () =>
      updateAlertToggle("signalChangeEnabled", signalToggle.checked)
    );
  }

  if (riskToggle) {
    riskToggle.addEventListener("change", () =>
      updateAlertToggle("riskChangeEnabled", riskToggle.checked)
    );
  }

  if (setupToggle) {
    setupToggle.addEventListener("change", () =>
      updateAlertToggle("setupGradeChangeEnabled", setupToggle.checked)
    );
  }

  renderAlertSettings();
}
function updatePrice(data) { const btc = data?.bitcoin, price = Number(btc?.usd), change = Number(btc?.usd_24h_change || 0); if (!Number.isFinite(price)) throw new Error("Live BTC price was not received."); currentBtcPriceUsd = price; currentBtcPriceInr = price * USD_INR_RATE; setText("btcPrice", formatUsd(price)); const changeBox = getElement("btcChange"); if (changeBox) { changeBox.textContent = `${change >= 0 ? "+" : ""}${change.toFixed(2)}%`; changeBox.style.color = change >= 0 ? "#22c55e" : "#ef4444"; } setText("marketUpdatedAt", `Live price updated: ${formatUpdatedAt(data.updated_at)}${data.cached ? " (cached)" : ""}`);  renderPaperTrading(); checkPriceAlerts(price); }
  

function getNewsImpactClass(impact) {
  const normalized = String(impact || "NEUTRAL").toUpperCase();

  if (normalized === "BULLISH") return "news-impact-bullish";
  if (normalized === "BEARISH") return "news-impact-bearish";

  return "news-impact-neutral";
}

function saveAiNews(aiData) {
  const snapshot = {
    news: Array.isArray(aiData?.news) ? aiData.news : [],
    overview: aiData?.news_overview || "",
    marketBias: aiData?.news_market_bias || "NEUTRAL",
    updatedAt: aiData?.news_updated_at
      ? Number(aiData.news_updated_at) * 1000
      : Date.now()
  };

  try {
    localStorage.setItem(AI_NEWS_STORAGE_KEY, JSON.stringify(snapshot));
  } catch (error) {
    console.error(error);
  }
}

function getSavedAiNews() {
  try {
    const raw = localStorage.getItem(AI_NEWS_STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (error) {
    console.error(error);
    return null;
  }
}

function getNewsTranslationCache() {
  try {
    const raw = localStorage.getItem(NEWS_TRANSLATION_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (error) {
    console.error(error);
    return {};
  }
}

function saveNewsTranslationCache(cache) {
  try {
    localStorage.setItem(
      NEWS_TRANSLATION_STORAGE_KEY,
      JSON.stringify(cache)
    );
  } catch (error) {
    console.error(error);
  }
}

function getNewsTranslationKey(item = {}) {
  return [
    String(item?.source || ""),
    String(item?.url || ""),
    String(item?.headline || "")
  ].join("|");
}

function getCachedNewsTranslation(item) {
  const key = getNewsTranslationKey(item);
  return getNewsTranslationCache()[key] || null;
}

function saveCachedNewsTranslation(item, translation) {
  const key = getNewsTranslationKey(item);
  const cache = getNewsTranslationCache();

  cache[key] = {
    headline_hi: String(translation?.headline_hi || "").trim(),
    summary_hi: String(translation?.summary_hi || "").trim(),
    savedAt: Date.now()
  };

  const entries = Object.entries(cache)
    .sort(([, a], [, b]) => Number(b?.savedAt || 0) - Number(a?.savedAt || 0))
    .slice(0, 100);

  saveNewsTranslationCache(Object.fromEntries(entries));
}

function renderGeminiNews(aiData = null) {
  const newsData = aiData
    ? {
        news: Array.isArray(aiData.news) ? aiData.news : [],
        overview: aiData.news_overview || "",
        marketBias: aiData.news_market_bias || "NEUTRAL",
        updatedAt: aiData.news_updated_at
          ? Number(aiData.news_updated_at) * 1000
          : Date.now()
      }
    : getSavedAiNews();

  const container = getElement("geminiNewsList");
  const overview = getElement("geminiNewsOverview");
  const bias = getElement("geminiNewsBias");
  const updated = getElement("geminiNewsUpdated");

  if (!container || !overview || !bias || !updated) return;

  const items = Array.isArray(newsData?.news) ? newsData.news : [];
  const marketBias = String(newsData?.marketBias || "NEUTRAL").toUpperCase();
  const updatedAt = Number(newsData?.updatedAt);

  overview.textContent =
    newsData?.overview ||
    "News will update only when you run Gemini AI Analysis.";

  bias.textContent = `News bias: ${marketBias}`;
  bias.className = `news-bias-badge ${getNewsImpactClass(marketBias)}`;

  updated.textContent = Number.isFinite(updatedAt)
    ? `Last news update: ${new Date(updatedAt).toLocaleString("en-IN", {
        day: "2-digit",
        month: "short",
        hour: "2-digit",
        minute: "2-digit"
      })} • Updated only with manual Gemini analysis`
    : "News updates only when you run Gemini AI Analysis.";

  container.innerHTML = "";

  if (!items.length) {
    const empty = document.createElement("p");
    empty.className = "gemini-news-empty";
    empty.textContent =
      "No saved Gemini news context yet. Run Gemini AI Analysis to fetch current BTC/crypto news.";
    container.appendChild(empty);
    return;
  }

  items.forEach((item) => {
    const card = document.createElement("article");
    card.className = "gemini-news-item";

    const top = document.createElement("div");
    top.className = "gemini-news-item-top";

    const source = document.createElement("span");
    source.className = "gemini-news-source";
    source.textContent = item?.source || "Source unavailable";

    const impact = document.createElement("span");
    const impactValue = String(item?.market_impact || "NEUTRAL").toUpperCase();
    impact.className = `news-impact-badge ${getNewsImpactClass(impactValue)}`;
    impact.textContent = impactValue;

    top.append(source, impact);

    const headline = document.createElement("h3");
    headline.textContent = item?.headline || "Crypto market update";

    const meta = document.createElement("p");
    meta.className = "gemini-news-meta";
    meta.textContent = item?.published_time || "Time unavailable";

    const summary = document.createElement("p");
    summary.className = "gemini-news-summary";
    summary.textContent = item?.summary || "No summary available.";

    const relevance = document.createElement("p");
    relevance.className = "gemini-news-relevance";
    relevance.textContent = `Market context: ${
      item?.market_relevance || "Interpretation unavailable."
    }`;

    const translationBox = document.createElement("div");
    translationBox.className = "gemini-news-translation";
    translationBox.hidden = true;

    const translationTitle = document.createElement("h4");
    translationTitle.textContent = "हिंदी अनुवाद";

    const translationHeadline = document.createElement("p");
    translationHeadline.className = "gemini-news-hi-headline";

    const translationSummary = document.createElement("p");
    translationSummary.className = "gemini-news-hi-summary";

    translationBox.append(
      translationTitle,
      translationHeadline,
      translationSummary
    );

    const actions = document.createElement("div");
    actions.className = "gemini-news-actions";

    const translateButton = document.createElement("button");
    translateButton.type = "button";
    translateButton.className = "translate-news-btn";
    translateButton.textContent = "हिंदी में पढ़ें";

    const translationStatus = document.createElement("span");
    translationStatus.className = "translation-status";
    translationStatus.setAttribute("aria-live", "polite");

    const cachedTranslation = getCachedNewsTranslation(item);

    function showTranslation(translation) {
      translationHeadline.textContent =
        translation?.headline_hi || item?.headline || "";
      translationSummary.textContent =
        translation?.summary_hi || item?.summary || "";
      translationBox.hidden = false;
      translateButton.textContent = "हिंदी अनुवाद छुपाएं";
      translationStatus.textContent = "अनुवाद तैयार है";
    }

    function hideTranslation() {
      translationBox.hidden = true;
      translateButton.textContent = "हिंदी में पढ़ें";
      translationStatus.textContent = "";
    }

    if (cachedTranslation?.headline_hi || cachedTranslation?.summary_hi) {
      showTranslation(cachedTranslation);
    }

    translateButton.addEventListener("click", async () => {
      if (!translationBox.hidden) {
        hideTranslation();
        return;
      }

      const alreadyCached = getCachedNewsTranslation(item);

      if (alreadyCached?.headline_hi || alreadyCached?.summary_hi) {
        showTranslation(alreadyCached);
        return;
      }

      translateButton.disabled = true;
      translateButton.textContent = "अनुवाद हो रहा है...";
      translationStatus.textContent = "Gemini translation चल रहा है...";

      try {
        const response = await fetch("/api/news/translate", {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            headline: item?.headline || "",
            summary: item?.summary || "",
            source: item?.source || ""
          })
        });

        const data = await response.json().catch(() => ({}));

        if (!response.ok) {
          throw new Error(
            data.detail || "Hindi translation could not be completed."
          );
        }

        saveCachedNewsTranslation(item, data);
        showTranslation(data);
      } catch (error) {
        console.error(error);
        translationStatus.textContent =
          error.message ||
          "Translation unavailable. Please try again later.";
        translateButton.textContent = "हिंदी में पढ़ें";
      } finally {
        translateButton.disabled = false;
      }
    });

    actions.append(translateButton, translationStatus);

    card.append(
      top,
      headline,
      meta,
      summary,
      relevance,
      translationBox,
      actions
    );

    const url = String(item?.url || "").trim();

    if (/^https?:\/\//i.test(url)) {
      const link = document.createElement("a");
      link.className = "gemini-news-link";
      link.href = url;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.textContent = "Read original article ↗";
      card.appendChild(link);
    }

    container.appendChild(card);
  });
}

function updateAiAnalysis(data, fromSavedPlan = false) { const m15 = data?.market_data?.timeframes?.["15m"] || {}, m1h = data?.market_data?.timeframes?.["1h"] || {}; latestTechnicalMarket = { "15m": m15, "1h": m1h }; setSignal(data.signal, data.reason); setText("aiConfidence", `${Number(data.confidence || 0)}%`); setText("entryIdea", data.entry_idea); setText("stopLossIdea", data.stop_loss_idea); setText("disclaimerText", data.disclaimer); setRiskBadge(data.risk); ["15m", "1h", "4h"].forEach((frame) => { const item = data?.timeframes?.[frame] || {}, key = frame === "15m" ? "15m" : frame; setMiniSignal(`signal${key}`, item.signal); setText(`summary${key}`, item.summary); setText(`keyLevel${key}`, item.key_level); }); setText("marketBias", data.market_bias); setText("setupStatus", data.setup_status); setText("confirmationNeeded", data.confirmation_needed); setText("target1", data.target_1); setText("target2", data.target_2); updateIndicators(m15, m1h); setSignalSource(fromSavedPlan ? `AI plan active • expires in ${getAiPlanRemainingLabel()}` : `Fresh Gemini AI plan • expires in ${getAiPlanRemainingLabel()}`, "ai"); setText("analysisUpdatedAt", `Last AI analysis: ${formatUpdatedAt(data.updated_at)}${data.cached ? " (API cached)" : ""} • plan valid ${getAiPlanRemainingLabel()}`); if (latestTechnicalResponse) renderSetupQuality(latestTechnicalResponse); }

async function loadPrice(force = false) { const response = await fetch(force ? "/api/btc/price?force_refresh=true" : "/api/btc/price", { cache: "no-store" }); if (!response.ok) throw new Error("Price API could not be loaded."); updatePrice(await response.json()); }
async function loadChart() { const selected = timeframeSettings[activeTimeframe], response = await fetch(`/api/btc/chart?days=${selected.days}&interval=${selected.interval}`, { cache: "no-store" }); if (!response.ok) throw new Error("Chart API could not be loaded."); const chart = await response.json(), prices = Array.isArray(chart.prices) ? chart.prices : []; if (!prices.length) throw new Error("No chart data was received."); const step = Math.max(1, Math.ceil(prices.length / selected.maxPoints)), points = prices.filter((_, index) => index % step === 0 || index === prices.length - 1); renderChart(points.map((p) => new Date(p[0]).toLocaleString("en-IN", selected.dateOptions)), points.map((p) => p[1]), selected.label); }
async function loadAiAnalysis() {
  if (aiRefreshInProgress) return;

  aiRefreshInProgress = true;
  setText(
    "analysisUpdatedAt",
    "Running Gemini AI analysis and checking fresh news..."
  );

  try {
    const response = await fetch("/api/ai-signal/run", {
      method: "POST",
      cache: "no-store"
    });

    const data = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(
        data.detail ||
          data.message ||
          `AI signal request failed (${response.status}).`
      );
    }

    saveLastAiSignal(data);
    saveAiPlan(data);
    saveAiNews(data);

    updateAiAnalysis(data);
    renderGeminiNews(data);
  } catch (error) {
    console.error(error);

    const savedNews = getSavedAiNews();

    if (renderSavedAiPlanIfActive()) {
      renderGeminiNews(savedNews ? null : null);
      setSignalSource(
        `Gemini refresh failed — last AI plan active for ${getAiPlanRemainingLabel()}`,
        "ai"
      );
      setText(
        "analysisUpdatedAt",
        "Gemini refresh failed; using last successful AI plan and saved news."
      );
      return;
    }

    renderGeminiNews(savedNews ? null : null);
    loadTechnicalFallback("Gemini AI is temporarily unavailable.");
  } finally {
    aiRefreshInProgress = false;
  }
}
async function refreshFastData() { try { await Promise.all([loadPrice(true), loadChart()]); } catch (error) { console.error(error); setText("marketUpdatedAt", "Live price/chart could not be updated. Please try again."); } }
async function refreshTechnicalAnalysis(prefix = "Live technical analysis refreshed.") { return loadTechnicalFallback(prefix, true); }
async function refreshAllData() { if (technicalRefreshInProgress) return; try { await Promise.all([refreshFastData(), refreshTechnicalAnalysis("Live technical analysis refreshed.")]); } catch (error) { console.error("Technical refresh error:", error); } loadRrg().catch((error) => console.error("RRG refresh error:", error)); }

function renderChart(labels, data, label) { const canvas = getElement("btcChart"); if (!canvas) return; if (btcChart) btcChart.destroy(); btcChart = new Chart(canvas.getContext("2d"), { type: "line", data: { labels, datasets: [{ label: `BTC/USD • ${label}`, data, borderColor: "#22c55e", backgroundColor: "rgba(34, 197, 94, 0.15)", borderWidth: 2, fill: true, tension: 0.28, pointRadius: 0, pointHoverRadius: 4 }] }, options: { responsive: true, maintainAspectRatio: true, interaction: { intersect: false, mode: "index" }, plugins: { legend: { labels: { color: "#ffffff" } }, tooltip: { callbacks: { label(context) { return `BTC: ${formatUsd(context.raw)}`; } } }, zoom: { limits: { x: { min: "original", max: "original", minRange: 2 } }, pan: { enabled: true, mode: "x", threshold: 2 }, zoom: { wheel: { enabled: true, speed: 0.25 }, pinch: { enabled: true }, drag: { enabled: true, threshold: 2, backgroundColor: "rgba(59, 130, 246, 0.18)", borderColor: "#60a5fa", borderWidth: 1 }, mode: "x" } } }, scales: { x: { ticks: { color: "#cbd5e1", maxTicksLimit: 7 }, grid: { color: "#1e293b" } }, y: { ticks: { color: "#cbd5e1", callback(value) { return formatUsd(value); } }, grid: { color: "#1e293b" } } } } }); }
function getRrgQuadrant(x, y) { return x >= 100 && y >= 100 ? "Leading" : x >= 100 ? "Weakening" : y < 100 ? "Lagging" : "Improving"; }
function createRrgQuadrantsPlugin() { return { id: "rrgQuadrants", beforeDatasetsDraw(chart) { const { ctx, chartArea, scales } = chart; if (!chartArea || !scales.x || !scales.y) return; const { left, right, top, bottom } = chartArea, cx = scales.x.getPixelForValue(100), cy = scales.y.getPixelForValue(100); if (!Number.isFinite(cx) || !Number.isFinite(cy)) return; ctx.save(); [["rgba(59, 130, 246, 0.13)", left, top, cx-left, cy-top], ["rgba(34, 197, 94, 0.13)", cx, top, right-cx, cy-top], ["rgba(239, 68, 68, 0.13)", left, cy, cx-left, bottom-cy], ["rgba(250, 204, 21, 0.13)", cx, cy, right-cx, bottom-cy]].forEach(([c,x,y,w,h]) => { ctx.fillStyle=c; ctx.fillRect(x,y,w,h); }); ctx.strokeStyle="rgba(255,255,255,.96)"; ctx.lineWidth=2.5; ctx.beginPath(); ctx.moveTo(cx,top); ctx.lineTo(cx,bottom); ctx.stroke(); ctx.beginPath(); ctx.moveTo(left,cy); ctx.lineTo(right,cy); ctx.stroke(); ctx.font="700 13px Arial"; ctx.fillStyle="#fff"; ctx.textBaseline="top"; ctx.textAlign="left"; ctx.fillText("IMPROVING",left+14,top+14); ctx.textAlign="right"; ctx.fillText("LEADING",right-14,top+14); ctx.textBaseline="bottom"; ctx.textAlign="left"; ctx.fillText("LAGGING",left+14,bottom-14); ctx.textAlign="right"; ctx.fillText("WEAKENING",right-14,bottom-14); ctx.restore(); } }; }
function createRrgDirectionArrowsPlugin() { return { id: "rrgDirectionArrows", afterDatasetsDraw(chart) { const { ctx } = chart; chart.data.datasets.forEach((dataset, index) => { const meta = chart.getDatasetMeta(index), element = meta?.data?.[meta.data.length - 1], raw = dataset.data[dataset.data.length - 1]; if (!element || !raw) return; const map = { "North-East": "↗", "South-East": "↘", "North-West": "↖", "South-West": "↙", Flat: "→" }; ctx.save(); ctx.fillStyle = dataset.borderColor || "#fff"; ctx.font = "bold 20px Arial"; ctx.textAlign = "left"; ctx.textBaseline = "middle"; ctx.fillText(map[raw.direction || "Flat"] || "→", element.x + 9, element.y); ctx.restore(); }); } }; }
async function loadRrg() { const status = getElement("rrgStatus"); if (status) status.textContent = `Loading ${activeRrgTimeframe} RRG-style data...`; try { const response = await fetch(`/api/rrg?interval=${activeRrgTimeframe}`, { cache: "no-store" }); if (!response.ok) throw new Error("RRG API could not be loaded."); const data = await response.json(); renderRrg(data); if (status) status.textContent = `${activeRrgTimeframe.toUpperCase()} RRG updated: ${formatUpdatedAt(data.updated_at)}${data.cached ? " (cached)" : ""}`; } catch (error) { console.error(error); if (status) status.textContent = "RRG-style chart could not be loaded. Please refresh again."; } }
function renderRrg(data) { const canvas = getElement("rrgChart"); if (!canvas || !Array.isArray(data?.trails)) return; if (rrgChart) rrgChart.destroy(); const all = data.trails.flatMap((t) => Array.isArray(t.points) ? t.points : []), xs = all.map((p) => Number(p.x)).filter(Number.isFinite), ys = all.map((p) => Number(p.y)).filter(Number.isFinite), xmin = Math.min(100,...xs), xmax = Math.max(100,...xs), ymin = Math.min(100,...ys), ymax = Math.max(100,...ys), xp = Math.max(.8,(xmax-xmin)*.22), yp = Math.max(.8,(ymax-ymin)*.22); const datasets = data.trails.map((t) => { const color = rrgColors[t.symbol] || {border:"#fff",background:"rgba(255,255,255,.15)"}, points = Array.isArray(t.points)?t.points:[], last=points.length-1; return { label:t.symbol.replace("USDT",""), data:points.map((p,i)=>({x:Number(p.x),y:Number(p.y),timestamp:p.timestamp,isLatest:i===last,direction:t.direction||"Flat"})), borderColor:color.border, backgroundColor:color.background,borderWidth:2,pointBorderColor:color.border,pointBackgroundColor(c){return c.raw?.isLatest?color.border:"rgba(15,23,42,.95)";},pointRadius(c){return c.raw?.isLatest?5:2;},pointHoverRadius:7,showLine:true,tension:0}; }); rrgChart = new Chart(canvas.getContext("2d"), { type:"scatter",data:{datasets},plugins:[createRrgQuadrantsPlugin(),createRrgDirectionArrowsPlugin()],options:{responsive:true,maintainAspectRatio:true,aspectRatio:1.15,interaction:{intersect:false,mode:"nearest"},plugins:{legend:{labels:{color:"#fff",usePointStyle:true,pointStyle:"circle"}},tooltip:{callbacks:{title(c){const raw=c[0]?.raw;return raw?.timestamp?new Date(raw.timestamp).toLocaleString("en-IN",{day:"2-digit",month:"short",hour:"2-digit",minute:"2-digit"}):"RRG-style point";},label(c){const x=Number(c.raw?.x||0),y=Number(c.raw?.y||0),d=c.raw?.direction||"Flat";return [`${c.dataset.label}: ${getRrgQuadrant(x,y)}`,`Direction: ${d}`,`RS Ratio: ${x.toFixed(2)}`,`RS Momentum: ${y.toFixed(2)}`];}}},zoom:{limits:{x:{min:"original",max:"original",minRange:.5},y:{min:"original",max:"original",minRange:.5}},pan:{enabled:true,mode:"xy",threshold:2},zoom:{wheel:{enabled:true,speed:.18},pinch:{enabled:true},drag:{enabled:true,threshold:2,backgroundColor:"rgba(59,130,246,.16)",borderColor:"#60a5fa",borderWidth:1},mode:"xy"}}},scales:{x:{type:"linear",min:xmin-xp,max:xmax+xp,title:{display:true,text:"Relative Strength Ratio",color:"#cbd5e1"},ticks:{color:"#cbd5e1",maxTicksLimit:7},grid:{color:"#334155"}},y:{type:"linear",min:ymin-yp,max:ymax+yp,title:{display:true,text:"Relative Strength Momentum",color:"#cbd5e1"},ticks:{color:"#cbd5e1",maxTicksLimit:7},grid:{color:"#334155"}}}} }); }

function getPaperTradeAmount() { const input=getElement("paperAmountInput"), amountInr=Number(input?.value); if (!currentBtcPriceInr) { setText("paperTradeStatus","Waiting for live BTC price. Please wait a few seconds."); return null; } if (!Number.isFinite(amountInr)||amountInr<PAPER_MIN_TRADE_INR) { setText("paperTradeStatus","Please enter a valid virtual amount of at least ₹100."); return null; } return {input,amountInr}; }
function executePaperBuy() { const trade=getPaperTradeAmount(); if(!trade)return; const {input,amountInr}=trade,p=loadPaperPortfolio(),btc=amountInr/currentBtcPriceInr; if(p.shortBtcHolding>PAPER_EPSILON){const value=p.shortBtcHolding*currentBtcPriceInr;if(amountInr>value+.01){setText("paperTradeStatus","Cover amount is larger than the current open short position.");return;}if(amountInr>p.cashInr+.01){setText("paperTradeStatus","Not enough virtual cash to cover this short position.");return;}const cover=Math.min(btc,p.shortBtcHolding),cost=cover*currentBtcPriceInr,avg=p.shortProceedsInr/p.shortBtcHolding;p.cashInr-=cost;p.shortBtcHolding-=cover;p.shortProceedsInr-=cover*avg;if(p.shortBtcHolding<PAPER_EPSILON){p.shortBtcHolding=0;p.shortProceedsInr=0;}addPaperTrade(p,"BUY TO COVER",cost,cover);savePaperPortfolio(p);if(input)input.value="";setText("paperTradeStatus",`Virtual BUY TO COVER complete: ${formatBtc(cover)} at ${formatInr(currentBtcPriceInr)} per BTC.`);renderPaperTrading();return;}if(amountInr>p.cashInr+.01){setText("paperTradeStatus","Not enough virtual cash for this long trade.");return;}p.cashInr-=amountInr;p.btcHolding+=btc;p.totalCostInr+=amountInr;addPaperTrade(p,"BUY LONG",amountInr,btc);savePaperPortfolio(p);if(input)input.value="";setText("paperTradeStatus",`Virtual BUY LONG complete: ${formatBtc(btc)} at ${formatInr(currentBtcPriceInr)} per BTC.`);renderPaperTrading(); }
function executePaperSell() { const trade=getPaperTradeAmount(); if(!trade)return; const {input,amountInr}=trade,p=loadPaperPortfolio(),btc=amountInr/currentBtcPriceInr; if(p.btcHolding>PAPER_EPSILON){const value=p.btcHolding*currentBtcPriceInr;if(amountInr>value+.01){setText("paperTradeStatus","Sell amount is larger than the current BTC long holding.");return;}const sold=Math.min(btc,p.btcHolding),sale=sold*currentBtcPriceInr,avg=p.totalCostInr/p.btcHolding;p.cashInr+=sale;p.btcHolding-=sold;p.totalCostInr-=sold*avg;if(p.btcHolding<PAPER_EPSILON){p.btcHolding=0;p.totalCostInr=0;}addPaperTrade(p,"SELL LONG",sale,sold);savePaperPortfolio(p);if(input)input.value="";setText("paperTradeStatus",`Virtual SELL LONG complete: ${formatBtc(sold)} at ${formatInr(currentBtcPriceInr)} per BTC.`);renderPaperTrading();return;}if(amountInr>p.cashInr+.01){setText("paperTradeStatus","Not enough virtual cash/margin to open this 1x short trade.");return;}p.cashInr+=amountInr;p.shortBtcHolding+=btc;p.shortProceedsInr+=amountInr;addPaperTrade(p,"SELL SHORT",amountInr,btc);savePaperPortfolio(p);if(input)input.value="";setText("paperTradeStatus",`Virtual SELL SHORT complete: ${formatBtc(btc)} at ${formatInr(currentBtcPriceInr)} per BTC. Use Buy / Cover Short to close it.`);renderPaperTrading(); }
function resetPaperTrading(){if(!window.confirm("Reset virtual paper portfolio to ₹100,000 and remove all virtual trades?"))return;savePaperPortfolio(getDefaultPaperPortfolio());setText("paperTradeStatus","Virtual portfolio reset to ₹100,000.");renderPaperTrading();}

function setupPaperTrading(){const buy=getElement("paperBuyBtn"),sell=getElement("paperSellBtn"),reset=getElement("resetPaperBtn");if(buy)buy.addEventListener("click",executePaperBuy);if(sell)sell.addEventListener("click",executePaperSell);if(reset)reset.addEventListener("click",resetPaperTrading);renderPaperTrading();}
function setupTimeframeButtons(){document.querySelectorAll(".timeframe-btn").forEach((button)=>button.addEventListener("click",async()=>{const frame=button.dataset.timeframe;if(!timeframeSettings[frame])return;activeTimeframe=frame;document.querySelectorAll(".timeframe-btn").forEach((item)=>item.classList.remove("active"));button.classList.add("active");try{await loadChart();}catch(error){console.error(error);setText("marketUpdatedAt","Selected chart timeframe could not be loaded.");}}));}
function setupZoomButtons(){const zin=getElement("zoomInBtn"),zout=getElement("zoomOutBtn"),reset=getElement("resetZoomBtn");if(zin)zin.addEventListener("click",()=>btcChart?.zoom({x:1.35}));if(zout)zout.addEventListener("click",()=>btcChart?.zoom({x:.74}));if(reset)reset.addEventListener("click",()=>btcChart?.resetZoom());}
function setupRrgButtons(){const reset=getElement("rrgResetBtn");document.querySelectorAll(".rrg-timeframe-btn").forEach((button)=>button.addEventListener("click",async()=>{const frame=button.dataset.rrgTimeframe;if(!["1h","1d"].includes(frame))return;activeRrgTimeframe=frame;document.querySelectorAll(".rrg-timeframe-btn").forEach((item)=>item.classList.remove("active"));button.classList.add("active");await loadRrg();}));if(reset)reset.addEventListener("click",()=>rrgChart?.resetZoom());}
function setUploadedChartText(id,value){const element=getElement(id);if(element)element.textContent=value||"--";}
function setupChartAnalyser(){const input=getElement("chartImageInput"),preview=getElement("chartImagePreview"),button=getElement("analyseChartBtn"),status=getElement("chartAnalyseStatus"),box=getElement("chartAnalysisResult");if(!input||!preview||!button||!status||!box)return;input.addEventListener("change",()=>{const file=input.files[0];box.hidden=true;if(!file){preview.hidden=true;preview.removeAttribute("src");status.textContent="Upload PNG, JPG, or WEBP chart image. Maximum 8 MB.";return;}if(!["image/png","image/jpeg","image/webp"].includes(file.type)||file.size>8*1024*1024){input.value="";preview.hidden=true;preview.removeAttribute("src");status.textContent="Select PNG, JPG, or WEBP only; maximum size is 8 MB.";return;}preview.src=URL.createObjectURL(file);preview.hidden=false;status.textContent=`Selected: ${file.name}. Click Analyse with Gemini AI.`;});button.addEventListener("click",async()=>{const file=input.files[0];if(!file){status.textContent="Please upload a chart image first.";return;}const form=new FormData();form.append("file",file);button.disabled=true;button.textContent="Analysing Chart...";status.textContent="Gemini is reading the uploaded chart screenshot...";box.hidden=true;try{const response=await fetch("/api/chart-analyser",{method:"POST",body:form}),data=await response.json();if(!response.ok)throw new Error(data.detail||"Chart analysis failed.");const signal=["BUY","SELL","HOLD"].includes(data.signal)?data.signal:"HOLD",element=getElement("uploadedChartSignal"),color=getSignalColor(signal);if(element){element.textContent=signal;element.style.color=color;element.style.borderColor=color;}setUploadedChartText("uploadedChartConfidence",`Confidence: ${Number(data.confidence||0)}%`);setUploadedChartText("uploadedChartRisk",data.risk);setUploadedChartText("uploadedChartTrend",data.trend);setUploadedChartText("uploadedChartPattern",data.pattern);setUploadedChartText("uploadedChartSupport",data.support);setUploadedChartText("uploadedChartResistance",data.resistance);setUploadedChartText("uploadedChartReason",data.reason);setUploadedChartText("uploadedChartEntry",data.entry_idea);setUploadedChartText("uploadedChartInvalidation",data.invalidation_idea);setUploadedChartText("uploadedChartWarning",data.warning);box.hidden=false;status.textContent="Chart analysis complete. Educational use only.";}catch(error){console.error(error);status.textContent=`Chart analysis error: ${error.message}`;}finally{button.disabled=false;button.textContent="Analyse with Gemini AI";}});}
function setupGeminiAiButton(){const button=getElement("geminiAiBtn");if(!button)return;button.addEventListener("click",async()=>{if(aiRefreshInProgress)return;button.disabled=true;button.textContent="Running Gemini AI...";try{await loadAiAnalysis();}finally{button.disabled=false;button.textContent="Run Gemini AI Analysis";}});}
function setupTechnicalRetryButton(){const button=getElement("retryTechnicalBtn");if(button)button.addEventListener("click",async()=>{button.disabled=true;await refreshTechnicalAnalysis("Retrying live technical analysis.");button.disabled=false;});}

function setupLayoutEditor(){const container=getElement("customizableSections"),edit=getElement("editLayoutBtn"),save=getElement("saveLayoutBtn"),reset=getElement("resetLayoutBtn");if(!container||!edit||!save||!reset)return;let editMode=false,dragged=null;const cards=()=>[...container.querySelectorAll(":scope > .layout-editable")];const height=(card,h)=>{card.classList.remove("layout-height-compact","layout-height-normal","layout-height-tall");card.classList.add(`layout-height-${h}`);};const toolbar=(card)=>{if(card.querySelector(".layout-editor-toolbar"))return;const bar=document.createElement("div");bar.className="layout-editor-toolbar";bar.innerHTML='<button class="layout-editor-btn layout-drag-handle" type="button">Move</button><button class="layout-editor-btn" type="button" data-height="compact">Compact</button><button class="layout-editor-btn" type="button" data-height="normal">Normal</button><button class="layout-editor-btn" type="button" data-height="tall">Tall</button>';card.prepend(bar);bar.querySelectorAll("[data-height]").forEach((b)=>b.addEventListener("click",(e)=>{e.preventDefault();e.stopPropagation();height(card,b.dataset.height);}));};const drag=(card)=>{if(card.dataset.layoutDragReady)return;card.dataset.layoutDragReady="true";card.addEventListener("dragstart",(e)=>{if(!editMode){e.preventDefault();return;}dragged=card;card.classList.add("is-dragging");e.dataTransfer.effectAllowed="move";});card.addEventListener("dragend",()=>{card.classList.remove("is-dragging");cards().forEach((c)=>c.classList.remove("drag-over"));dragged=null;});card.addEventListener("dragover",(e)=>{if(!editMode||!dragged||dragged===card)return;e.preventDefault();card.classList.add("drag-over");});card.addEventListener("dragleave",()=>card.classList.remove("drag-over"));card.addEventListener("drop",(e)=>{if(!editMode||!dragged||dragged===card)return;e.preventDefault();const box=card.getBoundingClientRect();container.insertBefore(dragged,e.clientY>box.top+box.height/2?card.nextSibling:card);card.classList.remove("drag-over");});};const mode=(on)=>{editMode=on;container.classList.toggle("layout-edit-mode",on);cards().forEach((card)=>{toolbar(card);drag(card);card.draggable=on;if(!on)card.classList.remove("is-dragging","drag-over");});edit.hidden=on;save.hidden=!on;reset.hidden=!on;};const restore=()=>{try{const stored=JSON.parse(localStorage.getItem(LAYOUT_STORAGE_KEY)||"[]");if(!Array.isArray(stored))return;stored.forEach((item)=>{const card=container.querySelector(`:scope > .layout-editable[data-layout-id="${item.id}"]`);if(card){container.appendChild(card);height(card,["compact","normal","tall"].includes(item.height)?item.height:"normal");}});}catch(error){console.warn("Saved dashboard layout could not be restored.",error);}};edit.addEventListener("click",()=>mode(true));save.addEventListener("click",()=>{localStorage.setItem(LAYOUT_STORAGE_KEY,JSON.stringify(cards().map((card)=>({id:card.dataset.layoutId,height:["compact","normal","tall"].find((h)=>card.classList.contains(`layout-height-${h}`))||"normal"}))));mode(false);});reset.addEventListener("click",()=>{localStorage.removeItem(LAYOUT_STORAGE_KEY);window.location.reload();});restore();}

renderGeminiNews();
const refreshButton=getElement("refreshBtn");if(refreshButton)refreshButton.addEventListener("click",refreshAllData);setupGeminiAiButton();setupTechnicalRetryButton();setupAlerts();setText("signal-date",formatDateForSignal());setupPaperTrading();setupTimeframeButtons();setupZoomButtons();setupRrgButtons();setupChartAnalyser();setupLayoutEditor();if(!renderSavedAiPlanIfActive()){setSignalSource("Gemini AI ready — run manual analysis when needed","neutral");setSignal("NO TRADE","Live technical data is updating. Run Gemini AI Analysis only when you want an AI plan.");}refreshAllData();setInterval(loadPrice,30000);setInterval(loadChart,60000);setInterval(()=>{if(isAiPlanActive()){setText("technicalRefreshStatus",`Auto technical refresh paused — Gemini AI plan active (${getAiPlanRemainingLabel()} remaining).`);return;}refreshTechnicalAnalysis("Automatic technical refresh.");},60000);setInterval(loadRrg,300000);setInterval(()=>{if(isAiPlanActive())setSignalSource(`AI plan active • expires in ${getAiPlanRemainingLabel()}`,"ai");},1000);

/* ===== Dashboard tabs and settings ===== */
(() => {
  const STORAGE_KEY = "btcAiSignalDashboardPreferences";

  function initDashboard() {
    const tabs = [...document.querySelectorAll(".app-tab[data-tab]")];
    const panels = [...document.querySelectorAll(".tab-panel[data-panel]")];

    const menuButton = document.querySelector("#settingsMenuButton");
    const drawer = document.querySelector("#settingsDrawer");
    const closeButton = document.querySelector("#settingsCloseButton");

    const nameInput = document.querySelector("#userNameInput");
    const saveNameButton = document.querySelector("#saveUserNameBtn");
    const resetSettingsButton = document.querySelector("#resetSettingsBtn");

    const themeButtons = [...document.querySelectorAll("[data-theme-choice]")];
    const accentButtons = [...document.querySelectorAll("[data-accent-choice]")];
    const textSizeButtons = [...document.querySelectorAll("[data-text-size-choice]")];

    let settings = {};

    try {
      settings = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}") || {};
    } catch (error) {
      settings = {};
    }

    function getCurrentSettings() {
      return {
        name: nameInput?.value.trim() || "",
        theme: document.body.dataset.theme || "dark",
        accent: document.body.dataset.accent || "blue",
        textSize: document.body.dataset.textSize || "normal",
        activeTab: document.querySelector(".app-tab.active")?.dataset.tab || "dashboard"
      };
    }

    function saveSettings() {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(getCurrentSettings()));
      } catch (error) {
        // Browser storage unavailable: current session will still work.
      }
    }

    function updateChoiceState(buttons, selectedValue, dataKey) {
      buttons.forEach((button) => {
        const active = button.dataset[dataKey] === selectedValue;
        button.classList.toggle("active", active);
        button.setAttribute("aria-pressed", String(active));
      });
    }

    function applySettings(nextSettings = {}) {
      const theme = nextSettings.theme || "dark";
      const accent = nextSettings.accent || "blue";
      const textSize = nextSettings.textSize || "normal";
      const name = nextSettings.name || "";

      document.body.dataset.theme = theme;
      document.body.dataset.accent = accent;
      document.body.dataset.textSize = textSize;

      if (nameInput) {
        nameInput.value = name;
      }

      updateChoiceState(themeButtons, theme, "themeChoice");
      updateChoiceState(accentButtons, accent, "accentChoice");
      updateChoiceState(textSizeButtons, textSize, "textSizeChoice");
    }

    function showTab(tabName, shouldSave = true) {
      const validTab = panels.some((panel) => panel.dataset.panel === tabName);
      const targetTab = validTab ? tabName : "dashboard";

      tabs.forEach((tab) => {
        const active = tab.dataset.tab === targetTab;
        tab.classList.toggle("active", active);
        tab.setAttribute("aria-selected", String(active));
      });

      panels.forEach((panel) => {
        const active = panel.dataset.panel === targetTab;
        panel.classList.toggle("active", active);
        panel.hidden = !active;
      });

      if (shouldSave) {
        saveSettings();
      }
    }

    function openSettings() {
      drawer?.classList.add("open");
      menuButton?.setAttribute("aria-expanded", "true");
    }

    function closeSettings() {
      drawer?.classList.remove("open");
      menuButton?.setAttribute("aria-expanded", "false");
    }

    applySettings(settings);
    showTab(settings.activeTab || "dashboard", false);

    tabs.forEach((tab) => {
      tab.addEventListener("click", () => {
        showTab(tab.dataset.tab);
      });
    });

    menuButton?.addEventListener("click", openSettings);
    closeButton?.addEventListener("click", closeSettings);

    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        closeSettings();
      }
    });

    saveNameButton?.addEventListener("click", () => {
      applySettings({
        ...getCurrentSettings(),
        name: nameInput?.value.trim() || ""
      });
      saveSettings();
    });

    nameInput?.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        saveNameButton?.click();
      }
    });

    themeButtons.forEach((button) => {
      button.addEventListener("click", () => {
        applySettings({
          ...getCurrentSettings(),
          theme: button.dataset.themeChoice || "dark"
        });
        saveSettings();
      });
    });

    accentButtons.forEach((button) => {
      button.addEventListener("click", () => {
        applySettings({
          ...getCurrentSettings(),
          accent: button.dataset.accentChoice || "blue"
        });
        saveSettings();
      });
    });

    textSizeButtons.forEach((button) => {
      button.addEventListener("click", () => {
        applySettings({
          ...getCurrentSettings(),
          textSize: button.dataset.textSizeChoice || "normal"
        });
        saveSettings();
      });
    });

    resetSettingsButton?.addEventListener("click", () => {
      try {
        localStorage.removeItem(STORAGE_KEY);
      } catch (error) {
        // Continue resetting in the active browser session.
      }

      applySettings({
        name: "",
        theme: "dark",
        accent: "blue",
        textSize: "normal"
      });

      showTab("dashboard", false);
      closeSettings();
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initDashboard);
  } else {
    initDashboard();
  }
})();
