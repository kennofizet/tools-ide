const fs = require("fs");
const path = require("path");
const { createHash } = require("crypto");
const { chromium } = require("playwright");
const { VALID_COMMANDS, printHelp, parseArgs } = require("./lib/cli");
const {
  ensureDir,
  loadConfig,
  getNowTag,
  parseBoolean,
  writeTextFile,
  safeDeletePath,
  appendLog,
  setQuietMode,
  runtimeState
} = require("./lib/io");
const {
  sanitizeDomainForFile,
  getDomainFromAnyUrl,
  loadDomainCache,
  summarizeRecentDomainRuns,
  saveDomainCache,
  updateDomainPageSummary,
  summarizePageMemoryForUrl
} = require("./lib/domain-cache");
const { normalizeUrlInput, resolveRunOptions } = require("./lib/options");
const { ensureLatestPointers, isLikelyAuthRedirect, writeRunSummary } = require("./lib/reporting");
const { applyAction, captureDom } = require("./lib/actions");
const { setupAgentOverlay, setAgentOverlayLocked, removeAgentOverlay } = require("./lib/overlay");
const { forgetPageData } = require("./lib/security");
const { pickPageFromBrowser, ensureLiveCdpEndpoint } = require("./lib/cdp");
const { loadCaseFile } = require("./lib/case-file");
const { saveCaseNote } = require("./lib/case-notes");
const { handlePhoneReviewCommand, HANDS_FREE_COMMANDS } = require("./lib/phone-review");
const {
  ensureReviewMode,
  assertHoldPath,
  handleReviewModeCommand
} = require("./lib/review-mode");

const FLOW_DOMAIN_DIR = path.resolve(__dirname, "flow", "domain");
const MAX_FLOW_NOTE_PREVIEW_LINES = 12;

function getDomainFlowCandidates(domain) {
  if (!domain || domain === "unknown-domain") {
    return ["default.md"];
  }
  const normalized = String(domain).toLowerCase();
  const withoutWww = normalized.startsWith("www.") ? normalized.slice(4) : normalized;
  const sanitized = sanitizeDomainForFile(normalized);
  const sanitizedNoWww = sanitizeDomainForFile(withoutWww);
  const candidates = [
    `${normalized}.md`,
    `${withoutWww}.md`,
    `${sanitized}.md`,
    `${sanitizedNoWww}.md`,
    "default.md"
  ];
  return [...new Set(candidates)];
}

function readDomainFlowNote({ flowDomainDir, domain }) {
  const candidates = getDomainFlowCandidates(domain);
  for (const candidate of candidates) {
    const notePath = path.join(flowDomainDir, candidate);
    if (!fs.existsSync(notePath)) continue;
    const raw = fs.readFileSync(notePath, "utf8");
    const lines = raw
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean)
      .slice(0, MAX_FLOW_NOTE_PREVIEW_LINES);
    return {
      found: true,
      domain: domain || "unknown-domain",
      path: notePath,
      candidate,
      preview: lines
    };
  }
  return {
    found: false,
    domain: domain || "unknown-domain",
    path: "",
    candidate: "",
    preview: []
  };
}

function getActionPreview(action) {
  if (!action || !action.type) return "unknown-action";
  if (action.type === "holdForUserAnswer" || action.type === "hold") {
    const selector = action.selector || "";
    return `holdForUserAnswer:${selector || "(no-zone)"}`;
  }
  if (action.type === "click" || action.type === "fill" || action.type === "waitForSelector") {
    return `${action.type}:${action.selector || "(missing-selector)"}`;
  }
  if (action.type === "goto") return `goto:${action.url || "(missing-url)"}`;
  if (action.type === "evaluate") return "evaluate:page-script";
  if (action.type === "waitForTimeout") return `waitForTimeout:${Number(action.ms || 500)}ms`;
  if (action.type === "press") return `press:${action.key || "(missing-key)"}`;
  return action.type;
}

function emitLiveProgress(message) {
  console.log(message);
}

function getHostnameSafe(rawUrl) {
  try {
    return new URL(String(rawUrl || "")).hostname.toLowerCase();
  } catch {
    return "";
  }
}

async function gotoWithTimeoutRecovery({ page, targetUrl, timeoutMs, logPath, label }) {
  try {
    await page.goto(targetUrl, { timeout: timeoutMs, waitUntil: "domcontentloaded" });
  } catch (error) {
    const message = String((error && error.message) || error || "");
    const isTimeout = message.toLowerCase().includes("timeout");
    const currentUrl = page.url() || "";
    const currentHost = getHostnameSafe(currentUrl);
    const targetHost = getHostnameSafe(targetUrl);
    if (isTimeout && currentHost && targetHost && currentHost === targetHost) {
      appendLog(
        logPath,
        `Goto timeout recovered (${label || "nav"}): still on target host '${targetHost}' via '${currentUrl}'.`
      );
      return;
    }
    throw error;
  }
}

function buildNextSuggestions({ runStatus, runError, finalUrl, failedStep, stepTrace }) {
  const suggestions = [];
  if (runStatus === "success") {
    suggestions.push("Use this flow as a stable baseline for next runs.");
    suggestions.push("If needed, save scenario notes with --saveCaseNoteTo and --caseKey.");
    return suggestions;
  }
  if (runError) {
    suggestions.push("Read run-summary.json and case-trace.json to identify failed selector/action.");
  }
  if (failedStep && failedStep.action && failedStep.action.selector) {
    suggestions.push(`Re-check selector visibility: ${failedStep.action.selector}`);
    suggestions.push("Try a broader fallback selector, then update the scenario note.");
  }
  if (finalUrl && finalUrl.includes("/login")) {
    suggestions.push("Session may be unauthenticated. Re-run login steps and wait longer before next click.");
  }
  if (!stepTrace.length) {
    suggestions.push("Add an initial waitForSelector action and retry.");
  }
  return suggestions;
}

function createNetworkMonitor({ page, appendLogFn, logPath, options = {} }) {
  const enabled = Boolean(options.enabled);
  const onlyApi = Boolean(options.onlyApi);
  const includeBodies = Boolean(options.includeBodies);
  const maxEntries = Math.max(50, Number(options.maxEntries || 500));
  const bodyMaxChars = Math.max(200, Number(options.bodyMaxChars || 2000));
  const entries = [];
  const pending = new Set();
  const requestMap = new Map();
  let sequence = 0;

  const nowIso = () => new Date().toISOString();
  const normalizeBody = (value) => String(value || "").slice(0, bodyMaxChars);
  const isApiUrl = (url) => /\/api(\/|$|\?)/i.test(String(url || ""));
  const shouldTrack = (url, resourceType) => {
    const rt = String(resourceType || "");
    if (onlyApi) {
      return isApiUrl(url) || rt === "xhr" || rt === "fetch";
    }
    return isApiUrl(url) || ["xhr", "fetch", "document"].includes(rt);
  };
  const pushEntry = (entry) => {
    if (entries.length >= maxEntries) entries.shift();
    entries.push(entry);
  };

  if (!enabled) {
    return {
      flush: async () => {},
      getEntries: () => [],
      buildSummary: () => ({
        enabled: false,
        totalEntries: 0,
        requestCount: 0,
        responseCount: 0,
        requestFailedCount: 0,
        consoleErrorCount: 0,
        pageErrorCount: 0,
        apiErrorResponses: [],
      }),
    };
  }

  page.on("request", request => {
    const url = request.url();
    const resourceType = request.resourceType();
    if (!shouldTrack(url, resourceType)) return;
    const id = ++sequence;
    const method = request.method();
    const payload = includeBodies ? normalizeBody(request.postData()) : "";
    const entry = {
      id,
      time: nowIso(),
      type: "request",
      method,
      url,
      resourceType,
      payload,
    };
    requestMap.set(request, { id, method, url, resourceType });
    pushEntry(entry);
  });

  page.on("response", response => {
    const task = (async () => {
      const request = response.request();
      const metadata = requestMap.get(request);
      const url = response.url();
      const resourceType = request.resourceType();
      if (!metadata && !shouldTrack(url, resourceType)) return;

      const status = response.status();
      const method = request.method();
      const headers = response.headers();
      const contentType = headers["content-type"] || "";
      let payload = "";
      if (includeBodies && (status >= 400 || /json|text|javascript/i.test(contentType))) {
        try {
          payload = normalizeBody(await response.text());
        } catch {
          payload = "";
        }
      }
      const entry = {
        id: metadata?.id || ++sequence,
        time: nowIso(),
        type: "response",
        method,
        url,
        status,
        ok: response.ok(),
        resourceType,
        contentType,
        payload,
      };
      pushEntry(entry);

      if (status >= 400 && isApiUrl(url)) {
        const payloadPreview = payload
          ? ` | body=${payload.replace(/\s+/g, " ").slice(0, 260)}`
          : "";
        appendLogFn(logPath, `API ERROR ${method} ${status} ${url}${payloadPreview}`);
      }
    })();
    pending.add(task);
    task.finally(() => pending.delete(task));
  });

  page.on("requestfailed", request => {
    const metadata = requestMap.get(request);
    const url = request.url();
    const resourceType = request.resourceType();
    if (!metadata && !shouldTrack(url, resourceType)) return;
    const failureText = request.failure()?.errorText || "unknown";
    const entry = {
      id: metadata?.id || ++sequence,
      time: nowIso(),
      type: "requestfailed",
      method: request.method(),
      url,
      resourceType,
      error: failureText,
    };
    pushEntry(entry);
    if (isApiUrl(url)) {
      appendLogFn(logPath, `API REQUEST FAILED ${request.method()} ${url} | error=${failureText}`);
    }
  });

  page.on("console", message => {
    const level = String(message.type() || "log").toLowerCase();
    if (!["error", "warning"].includes(level)) return;
    const entry = {
      id: ++sequence,
      time: nowIso(),
      type: "console",
      level,
      text: normalizeBody(message.text()),
    };
    pushEntry(entry);
    if (level === "error") {
      appendLogFn(logPath, `PAGE CONSOLE ERROR: ${entry.text}`);
    }
  });

  page.on("pageerror", error => {
    const entry = {
      id: ++sequence,
      time: nowIso(),
      type: "pageerror",
      text: normalizeBody(error?.message || String(error || "")),
    };
    pushEntry(entry);
    appendLogFn(logPath, `PAGE ERROR: ${entry.text}`);
  });

  return {
    flush: async () => {
      if (!pending.size) return;
      await Promise.allSettled([...pending]);
    },
    getEntries: () => entries.slice(),
    buildSummary: () => {
      const requestCount = entries.filter(item => item.type === "request").length;
      const responseCount = entries.filter(item => item.type === "response").length;
      const requestFailedCount = entries.filter(item => item.type === "requestfailed").length;
      const consoleErrorCount = entries.filter(
        item => item.type === "console" && item.level === "error"
      ).length;
      const pageErrorCount = entries.filter(item => item.type === "pageerror").length;
      const apiErrorResponses = entries.filter(
        item => item.type === "response"
          && item.status >= 400
          && isApiUrl(item.url)
      );

      return {
        enabled: true,
        onlyApi,
        includeBodies,
        totalEntries: entries.length,
        requestCount,
        responseCount,
        requestFailedCount,
        consoleErrorCount,
        pageErrorCount,
        apiErrorResponses,
      };
    },
  };
}

function writeCaseDiagnostics({
  runDir,
  outputDir,
  runTag,
  caseFilePath,
  targetUrl,
  finalUrl,
  runStatus,
  runError,
  stepTrace,
  stepReviews,
  failedStep,
  logPath,
  domPath,
  screenshotPath,
  networkLogPath,
  networkSummaryPath,
  holdAnswerPath,
  holdAnnotationPath,
  holdCompositePath
}) {
  const trace = {
    runTag,
    caseFilePath: caseFilePath || null,
    targetUrl: targetUrl || null,
    finalUrl: finalUrl || null,
    status: runStatus,
    error: runError || null,
    failedStep: failedStep || null,
    steps: stepTrace,
    stepReviews: stepReviews || []
  };
  const agentState = {
    runTag,
    status: runStatus,
    currentError: runError || null,
    finalUrl: finalUrl || null,
    lastCompletedStep: stepTrace.length ? stepTrace[stepTrace.length - 1] : null,
    failedStep: failedStep || null,
    stepReviewCount: (stepReviews || []).length,
    latestStepReview: (stepReviews || []).length ? stepReviews[stepReviews.length - 1] : null,
    nextSuggestions: buildNextSuggestions({
      runStatus,
      runError,
      finalUrl,
      failedStep,
      stepTrace
    }),
    artifacts: {
      logPath: logPath || null,
      domPath: domPath || null,
      screenshotPath: screenshotPath || null,
      networkLogPath: networkLogPath || null,
      networkSummaryPath: networkSummaryPath || null,
      holdAnswerPath: holdAnswerPath || null,
      holdAnnotationPath: holdAnnotationPath || null,
      holdCompositePath: holdCompositePath || null
    }
  };
  const tracePath = path.join(runDir, "case-trace.json");
  const statePath = path.join(runDir, "agent-state.json");
  writeTextFile(tracePath, JSON.stringify(trace, null, 2));
  writeTextFile(statePath, JSON.stringify(agentState, null, 2));
  writeTextFile(path.join(outputDir, "last-agent-state.json"), JSON.stringify(agentState, null, 2));
}

function writeStepAgentState({
  runDir,
  outputDir,
  runTag,
  finalUrl,
  stepTrace,
  failedStep,
  stepReviews,
  runError,
  logPath
}) {
  const lastCompletedStep = stepTrace.length ? stepTrace[stepTrace.length - 1] : null;
  const inProgressState = {
    runTag,
    status: failedStep ? "failed-step" : "in-progress",
    currentError: runError || null,
    finalUrl: finalUrl || null,
    lastCompletedStep,
    failedStep: failedStep || null,
    nextSuggestions: failedStep
      ? ["Fix failed step selector/action, then continue from next action."]
      : ["Read latest step artifacts, then decide next step."],
    latestStepReview: stepReviews.length ? stepReviews[stepReviews.length - 1] : null,
    artifacts: {
      logPath: logPath || null
    }
  };
  writeTextFile(path.join(runDir, "agent-state.json"), JSON.stringify(inProgressState, null, 2));
  writeTextFile(path.join(outputDir, "last-agent-state.json"), JSON.stringify(inProgressState, null, 2));
}

function resolveBestFailureArtifactPath({ preferredPath, fallbackPath, existsSyncFn }) {
  if (preferredPath && existsSyncFn(preferredPath)) return preferredPath;
  if (fallbackPath && existsSyncFn(fallbackPath)) return fallbackPath;
  return null;
}

function buildStepReview({ stepRecord, previousStep }) {
  const actionType = stepRecord?.action?.type || "unknown";
  const urlBefore = stepRecord?.urlBefore || "";
  const urlAfter = stepRecord?.urlAfter || "";
  const changedUrl = Boolean(urlBefore && urlAfter && urlBefore !== urlAfter);
  const status = stepRecord?.status || "unknown";

  let observation = `Step ${stepRecord?.index || "?"} ${status}: ${stepRecord?.actionPreview || actionType}`;
  if (changedUrl) {
    observation += ` | URL changed to ${urlAfter}`;
  } else if (urlAfter) {
    observation += ` | URL unchanged (${urlAfter})`;
  }

  let nextSuggestion = "Review current step capture, then continue with next planned action.";
  if (status === "failed") {
    nextSuggestion = "Fix selector/action for this failed step, then retry same step.";
    nextSuggestion = "Step failed. Read current screenshot/DOM, decide the correct next action for the current page state, then run the next command manually.";
  } else if (actionType === "fill") {
    nextSuggestion = "Continue with submit/click action for this form.";
  } else if (actionType === "click" && changedUrl) {
    nextSuggestion = "Wait for target page content and validate expected elements.";
  } else if (actionType === "click") {
    nextSuggestion = "Confirm click effect in DOM/screenshot before continuing.";
  } else if (actionType === "waitForSelector") {
    nextSuggestion = "Page is ready; continue to the next interaction action.";
  }

  return {
    index: stepRecord?.index || null,
    status,
    actionType,
    actionPreview: stepRecord?.actionPreview || null,
    observation,
    nextSuggestion,
    comparedToPreviousStep: previousStep
      ? {
          previousIndex: previousStep.index || null,
          previousStatus: previousStep.status || null
        }
      : null
  };
}

function runStepReviewGate({
  review,
  stepRecord,
  forceStepCapture
}) {
  if (!review || !review.nextSuggestion || !review.observation) {
    throw new Error(`Step review gate failed at step ${stepRecord.index}: missing review fields.`);
  }
  if (forceStepCapture && (!stepRecord.domPath || !stepRecord.screenshotPath)) {
    throw new Error(`Step review gate failed at step ${stepRecord.index}: missing step capture artifacts.`);
  }
}

async function captureStepArtifacts({
  page,
  stepCaptureDir,
  stepIndex,
  phase,
  timeoutMs
}) {
  ensureDir(stepCaptureDir);
  const waitMs = Math.min(Math.max(Number(timeoutMs) || 3000, 1000), 8000);
  try {
    await page.waitForLoadState("domcontentloaded", { timeout: waitMs });
  } catch {
    // already idle, or SPA hydration still in progress
  }

  const captureOnce = async () => {
    const domPath = path.join(stepCaptureDir, `step-${stepIndex}-${phase}-dom.html`);
    const screenshotPath = path.join(stepCaptureDir, `step-${stepIndex}-${phase}-screen.png`);
    await captureDom(page, domPath, writeTextFile);
    await page.screenshot({ path: screenshotPath, fullPage: true, timeout: waitMs });
    return { domPath, screenshotPath };
  };

  try {
    return await captureOnce();
  } catch {
    try {
      await page.waitForLoadState("load", { timeout: waitMs });
    } catch {
      // retry capture even if load wait expires
    }
    return await captureOnce();
  }
}

function makeReviewToken(stepIndex) {
  const rand = Math.random().toString(36).slice(2, 8);
  return `step-${stepIndex}-ok-${rand}`;
}

function getCaseProgressPath(outputDir, caseFilePath) {
  const digest = createHash("sha1")
    .update(path.resolve(caseFilePath))
    .digest("hex")
    .slice(0, 16);
  return path.join(outputDir, "case-progress", `${digest}.json`);
}

function loadCaseProgress(progressPath) {
  try {
    if (!fs.existsSync(progressPath)) return { nextIndex: 0 };
    return JSON.parse(fs.readFileSync(progressPath, "utf8"));
  } catch {
    return { nextIndex: 0 };
  }
}

function saveCaseProgress(progressPath, payload) {
  writeTextFile(progressPath, JSON.stringify(payload, null, 2));
}

async function main() {
  const command = process.argv[2] || "run";
  const args = parseArgs(process.argv.slice(3));
  if (command === "help" || args.help || args.h) {
    printHelp();
    return;
  }
  if (!VALID_COMMANDS.has(command)) {
    throw new Error(`Invalid command '${command}'. Run 'node emulator.js help' for usage.`);
  }

  const configPath = path.resolve(args.config || "config.json");
  const config = loadConfig(configPath);
  setQuietMode(parseBoolean(args.quiet, parseBoolean(config.quiet, false)));

  const timeoutMs = Number(args.timeout || config.timeoutMs || 30000);
  const outputDir = path.resolve(config.outputDir || "./output");
  const runTag = args.runTag || config.runTag || `${command}-${getNowTag()}`;
  const runDir = path.join(outputDir, "runs", runTag);
  const logPath = path.join(runDir, "emulator.log");
  const domPath = path.resolve(config.captureDomPath || path.join(runDir, "dom.html"));
  const screenshotPath = path.join(runDir, `screen-${getNowTag()}.png`);
  const networkLogPath = path.join(runDir, "network-log.json");
  const networkSummaryPath = path.join(runDir, "network-summary.json");
  const holdAnswerPath = path.join(runDir, "hold-answer.json");
  const holdAnnotationPath = path.join(runDir, `hold-annotation-${getNowTag()}.png`);
  const holdCompositePath = path.join(runDir, `hold-composite-${getNowTag()}.png`);

  if (command === "review-mode") {
    handleReviewModeCommand({ args, outputDir });
    process.exit(0);
  }

  let reviewModeState = null;
  const skipReviewGate = command === "hands-free-stop" || command === "phone-stop";
  if (!skipReviewGate) {
    try {
      reviewModeState = ensureReviewMode({ args, config, outputDir, command });
      assertHoldPath({
        command,
        actionType: args.type,
        mode: reviewModeState && reviewModeState.mode
      });
    } catch (error) {
      console.error(error.message);
      process.exit(error.exitCode || 1);
    }
  }

  if (HANDS_FREE_COMMANDS.has(command)) {
    try {
      await handlePhoneReviewCommand({ command, args, config, outputDir });
      process.exit(0);
    } catch (error) {
      console.error(error.message);
      process.exit(error.exitCode || 1);
    }
  }
  const domCheckSelector = args.domCheckSelector || config.domCheckSelector || "body";
  const cliUrl = args.url || "";
  const configuredUrl = cliUrl || config.url || "";
  const caseFilePath = args.caseFile || config.caseFile || "";
  const reviewTokenArg = String(args.reviewToken || "").trim();
  const saveCaseNoteTo = args.saveCaseNoteTo || config.saveCaseNoteTo || "";
  const caseKey = args.caseKey || config.caseKey || "";
  const caseNote = args.caseNote || config.caseNote || "";
  const caseMode = Boolean(caseFilePath);
  // Fixed behavior: case runs are always single-step with pause/review.
  const stepMode = caseMode;
  const stepBatchSize = 1;
  const resetCaseProgress = parseBoolean(
    args.resetCaseProgress,
    parseBoolean(config.resetCaseProgress, false)
  );
  const liveMode = parseBoolean(args.liveMode, parseBoolean(config.liveMode, false));
  const reviewBeforeNextStep = parseBoolean(
    args.reviewBeforeNextStep,
    parseBoolean(config.reviewBeforeNextStep, caseMode || liveMode)
  );
  const reviewPauseMs = Math.max(
    0,
    Number(args.reviewPauseMs || config.reviewPauseMs || 700)
  );
  const forceStepCapture = parseBoolean(
    args.forceStepCapture,
    parseBoolean(config.forceStepCapture, caseMode || liveMode || command === "action")
  );
  const domainCacheDir = path.resolve(
    args.domainCacheDir || config.domainCacheDir || path.join(__dirname, "domain-cache")
  );

  const forceLocalLaunchInput = parseBoolean(
    args.forceLocalLaunch,
    parseBoolean(config.forceLocalLaunch, false)
  );
  const forceLocalLaunch = caseMode ? false : forceLocalLaunchInput;
  const requestedUseCdp = parseBoolean(args.useCdp, parseBoolean(config.useCdp, true));
  const cdpAutoAttach = parseBoolean(
    args.cdpAutoAttach,
    parseBoolean(config.cdpAutoAttach, true)
  );
  const useCdp = caseMode ? true : (!forceLocalLaunch && (requestedUseCdp || liveMode || cdpAutoAttach));
  const cdpEndpoint = args.cdpEndpoint || config.cdpEndpoint || "http://127.0.0.1:9223";
  const cdpAutoStart = parseBoolean(args.cdpAutoStart, parseBoolean(config.cdpAutoStart, true));
  const browserName = String(args.browser || config.browser || "edge").trim().toLowerCase();
  const localChannel = browserName === "chrome" ? "chrome" : undefined;
  const cdpLaunchDetached = parseBoolean(
    args.cdpLaunchDetached,
    parseBoolean(config.cdpLaunchDetached, true)
  );
  const cdpStartupRetries = Math.max(
    1,
    Number(args.cdpStartupRetries || config.cdpStartupRetries || 2)
  );
  const cdpRetryLaunchDetached = parseBoolean(
    args.cdpRetryLaunchDetached,
    parseBoolean(config.cdpRetryLaunchDetached, true)
  );
  const cdpBrowserPath = args.cdpBrowserPath
    || config.cdpBrowserPath
    || (browserName === "chrome"
      ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
      : "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe");
  const cdpUserDataDir = args.cdpUserDataDir || config.cdpUserDataDir || "";
  const cdpNavigate = caseMode
    ? (resetCaseProgress ? true : parseBoolean(args.cdpNavigate, parseBoolean(config.cdpNavigate, false)))
    : parseBoolean(args.cdpNavigate, parseBoolean(config.cdpNavigate, false));
  const cdpAutoOpenIfMissing = parseBoolean(
    args.cdpAutoOpenIfMissing,
    parseBoolean(config.cdpAutoOpenIfMissing, true)
  );
  const attachRequireMatch = parseBoolean(
    args.attachRequireMatch,
    parseBoolean(config.attachRequireMatch, false)
  );
  const runOptions = resolveRunOptions({ args, config, useCdp, liveMode });
  const {
    rawPreset,
    preset,
    agentOverlayEnabled,
    agentOverlayText,
    agentOverlayDisableClicks,
    agentOverlayLockDuringActions,
    agentOverlayKeepAfterRun,
    forgetPageAfterRun: runForgetPageAfterRun,
    forgetDomainCacheAfterRun,
    forgetSessionAfterRun,
    forgetArtifactsAfterRun,
    enableDomainCache,
    maxDomainRuns,
    captureDomAfterRun,
    captureScreenshotAfterRun,
    waitAfterActionMs
  } = runOptions;
  const networkLogEnabled = parseBoolean(
    args.networkLogEnabled,
    parseBoolean(config.networkLogEnabled, true)
  );
  const networkLogOnlyApi = parseBoolean(
    args.networkLogOnlyApi,
    parseBoolean(config.networkLogOnlyApi, true)
  );
  const networkLogIncludeBodies = parseBoolean(
    args.networkLogIncludeBodies,
    parseBoolean(config.networkLogIncludeBodies, true)
  );
  const networkLogMaxEntries = Math.max(
    50,
    Number(args.networkLogMaxEntries || config.networkLogMaxEntries || 500)
  );
  const networkLogBodyMaxChars = Math.max(
    200,
    Number(args.networkLogBodyMaxChars || config.networkLogBodyMaxChars || 2000)
  );
  let forgetPageAfterRun = runForgetPageAfterRun;
  if (caseMode) {
    // Keep attached page state between case steps.
    forgetPageAfterRun = false;
  }
  if (rawPreset !== preset) {
    // no-op (logging disabled)
  }

  const backgroundEnabled = parseBoolean(args.background, parseBoolean(config.background, false));
  const effectiveCdpLaunchDetached = backgroundEnabled
    ? true
    : cdpLaunchDetached;
  const keepBrowserOpenForInteractive = !backgroundEnabled && (liveMode || caseMode) && useCdp;
  const headless = backgroundEnabled ? true : (liveMode ? false : parseBoolean(config.headless, false));
  let keepProgress;
  if (liveMode) {
    keepProgress = true;
  } else if (caseMode && stepMode && !liveMode && args.keepProgress === undefined) {
    // Force clean step-by-step case runs unless user explicitly opts in.
    keepProgress = false;
  } else {
    keepProgress = parseBoolean(args.keepProgress, parseBoolean(config.keepProgress, true));
  }
  const sessionName = args.session || config.sessionName || (liveMode ? "live-default" : "default");
  const hasSessionOverride = Boolean(args.session);
  const resolvedSessionDir = args.sessionDir
    || (hasSessionOverride ? path.join(outputDir, "sessions", sessionName) : null)
    || config.sessionDir
    || path.join(outputDir, "sessions", sessionName);
  const sessionDir = path.resolve(resolvedSessionDir);

  const loadedCase = caseFilePath ? loadCaseFile(caseFilePath) : null;
  const caseTargetUrl = loadedCase ? (loadedCase.data.targetUrl || "") : "";
  const suppressDefaultConfigUrlInLiveMode = liveMode && !cliUrl && !caseTargetUrl;
  const effectiveConfiguredUrl = cliUrl
    || caseTargetUrl
    || (suppressDefaultConfigUrlInLiveMode ? "" : configuredUrl);
  const explicitAttachMatchUrl = args.attachMatchUrl || config.attachMatchUrl || "";
  const attachDomainHint = getDomainFromAnyUrl(effectiveConfiguredUrl || "", "");
  const effectiveAttachMatchUrl = explicitAttachMatchUrl || attachDomainHint || effectiveConfiguredUrl || "";
  if (!effectiveConfiguredUrl && !useCdp) {
    throw new Error("Missing URL. Set `url` in config.json or pass --url");
  }
  const cdpPreferredTargetRaw = args.url || args.attachMatchUrl || effectiveConfiguredUrl || effectiveAttachMatchUrl;
  const targetUrl = normalizeUrlInput(useCdp ? cdpPreferredTargetRaw : effectiveConfiguredUrl);
  const initialDomainHint = getDomainFromAnyUrl(targetUrl || effectiveConfiguredUrl || "", "unknown-domain");

  ensureDir(runDir);
  if (!useCdp && keepProgress) {
    ensureDir(sessionDir);
  }
  if (enableDomainCache) {
    ensureDir(domainCacheDir);
  }
  appendLog(logPath, `Command: ${command}`);
  emitLiveProgress(useCdp ? `Connecting over CDP ${cdpEndpoint}` : "Opening browser");
  appendLog(logPath, `Run directory: ${runDir}`);
  appendLog(logPath, `Preset: ${preset}`);
  appendLog(logPath, `Mode: ${useCdp ? "cdp-attach" : "local-launch"}`);
  appendLog(logPath, `Browser: ${browserName}`);
  appendLog(logPath, `Background: ${backgroundEnabled ? "enabled" : "disabled"}`);
  appendLog(logPath, `Step mode: ${stepMode ? "enabled" : "disabled"}`);
  if (stepMode) {
    appendLog(logPath, `Step batch size: ${stepBatchSize}`);
  }
  appendLog(logPath, `Live mode: ${liveMode ? "enabled" : "disabled"}`);
  appendLog(logPath, `Keep browser open (interactive): ${keepBrowserOpenForInteractive ? "enabled" : "disabled"}`);
  appendLog(logPath, `CDP auto-attach: ${cdpAutoAttach ? "enabled" : "disabled"}`);
  appendLog(logPath, `Force local launch: ${forceLocalLaunch ? "enabled" : "disabled"}`);
  appendLog(logPath, `Session: ${sessionName}`);
  appendLog(logPath, `Session mode: ${keepProgress ? "persistent" : "ephemeral"}`);
  if (useCdp) {
    appendLog(logPath, `CDP endpoint: ${cdpEndpoint}`);
    appendLog(logPath, `CDP auto-start: ${cdpAutoStart ? "enabled" : "disabled"}`);
    appendLog(logPath, `CDP launch detached: ${effectiveCdpLaunchDetached ? "enabled" : "disabled"}`);
    appendLog(logPath, `CDP startup retries: ${cdpStartupRetries}`);
    appendLog(logPath, `CDP retry launch detached: ${cdpRetryLaunchDetached ? "enabled" : "disabled"}`);
    appendLog(
      logPath,
      `CDP page match: ${effectiveAttachMatchUrl || "(first available tab)"}`
    );
    appendLog(logPath, `CDP navigate: ${cdpNavigate ? "enabled" : "disabled"}`);
    appendLog(logPath, `CDP auto-open missing target: ${cdpAutoOpenIfMissing ? "enabled" : "disabled"}`);
  }
  appendLog(logPath, `Agent overlay: ${agentOverlayEnabled ? "enabled" : "disabled"}`);
  if (agentOverlayEnabled) {
    appendLog(logPath, `Agent overlay text: ${agentOverlayText}`);
    appendLog(logPath, `Agent click lock: ${agentOverlayDisableClicks ? "enabled" : "disabled"}`);
  }
  appendLog(logPath, `Forget page after run: ${forgetPageAfterRun ? "enabled" : "disabled"}`);
  appendLog(logPath, `Forget domain cache after run: ${forgetDomainCacheAfterRun ? "enabled" : "disabled"}`);
  appendLog(logPath, `Forget session after run: ${forgetSessionAfterRun ? "enabled" : "disabled"}`);
  appendLog(logPath, `Forget artifacts after run: ${forgetArtifactsAfterRun ? "enabled" : "disabled"}`);
  appendLog(logPath, `Domain cache mode: ${enableDomainCache ? "enabled" : "disabled"}`);
  appendLog(logPath, `Capture DOM after run: ${captureDomAfterRun ? "enabled" : "disabled"}`);
  appendLog(logPath, `Capture screenshot after run: ${captureScreenshotAfterRun ? "enabled" : "disabled"}`);
  appendLog(logPath, `Network log: ${networkLogEnabled ? "enabled" : "disabled"}`);
  appendLog(logPath, `Network log only API: ${networkLogOnlyApi ? "enabled" : "disabled"}`);
  appendLog(logPath, `Network log include bodies: ${networkLogIncludeBodies ? "enabled" : "disabled"}`);
  appendLog(logPath, `Force step capture: ${forceStepCapture ? "enabled" : "disabled"}`);
  appendLog(logPath, `Review before next step: ${reviewBeforeNextStep ? "enabled" : "disabled"}`);
  appendLog(logPath, `Wait after action (ms): ${waitAfterActionMs}`);
  if (effectiveConfiguredUrl) {
    appendLog(logPath, `Configured URL: ${effectiveConfiguredUrl}`);
  }
  const domainFlowNote = readDomainFlowNote({
    flowDomainDir: FLOW_DOMAIN_DIR,
    domain: initialDomainHint
  });
  if (domainFlowNote.found) {
    appendLog(logPath, `Domain flow note loaded: ${domainFlowNote.path}`);
    domainFlowNote.preview.forEach((line, index) => {
      appendLog(logPath, `Flow note [${index + 1}]: ${line}`);
    });
  } else {
    appendLog(
      logPath,
      `Domain flow note missing for '${initialDomainHint}'. Add one under ${FLOW_DOMAIN_DIR}.`
    );
  }
  writeTextFile(
    path.join(outputDir, "last-domain-flow.json"),
    JSON.stringify(
      {
        domain: domainFlowNote.domain,
        found: domainFlowNote.found,
        path: domainFlowNote.path || null,
        candidate: domainFlowNote.candidate || null,
        preview: domainFlowNote.preview
      },
      null,
      2
    )
  );
  if (loadedCase) {
    appendLog(logPath, `Case file loaded: ${loadedCase.path} (${loadedCase.actions.length} action(s))`);
  }

  let browser;
  let context;
  let page;
  let usingCdp = false;
  let domain = "unknown-domain";
  let domainCachePath = "";
  let domainCache = null;
  let runStatus = "failed";
  let runError = "";
  let domLength = 0;
  let finalDomPath = null;
  let finalUrl = effectiveConfiguredUrl || "";
  let finalScreenshotPath = null;
  let finalNetworkLogPath = null;
  let finalNetworkSummaryPath = null;
  let holdAnswer = null;
  let actionSummary = "";
  const stepTrace = [];
  const stepReviews = [];
  let failedStep = null;
  const stepCaptureDir = path.join(runDir, "steps");
  const startedAt = new Date().toISOString();
  let networkMonitor = null;

  try {
    if (useCdp) {
      if (cdpAutoStart || liveMode || (caseMode && !backgroundEnabled)) {
        const cdpReady = await ensureLiveCdpEndpoint({
          endpoint: cdpEndpoint,
          autoStart: cdpAutoStart,
          browserName,
          browserPath: cdpBrowserPath,
          userDataDir: cdpUserDataDir,
          launchDetached: effectiveCdpLaunchDetached,
          startupRetries: cdpStartupRetries,
          retryLaunchDetached: cdpRetryLaunchDetached,
          timeoutMs: Math.min(timeoutMs, 30000)
        });
        if (!cdpReady.available) {
          throw new Error(
            `CDP endpoint unavailable at ${cdpEndpoint}. Start browser with remote debugging or enable cdpAutoStart.`
          );
        }
        if (cdpReady.startedByTool) {
          appendLog(logPath, "Started browser with CDP automatically.");
        }
      }
      try {
        browser = await chromium.connectOverCDP(cdpEndpoint);
        usingCdp = true;
        const selected = await pickPageFromBrowser(browser, { matchUrl: effectiveAttachMatchUrl, timeoutMs });
        context = selected.context;
        page = selected.page;
        let cdpMatchedOrRecovered = Boolean(selected.matched);
        if (effectiveAttachMatchUrl && !selected.matched) {
          const previews = selected.availableUrls.slice(0, 5).join(" | ");
          appendLog(logPath, `CDP warning: no tab matched '${effectiveAttachMatchUrl}'.`);
          appendLog(logPath, `CDP available tabs: ${previews || "(none)"}`);
          if (cdpAutoOpenIfMissing && targetUrl) {
            appendLog(logPath, `CDP fallback: navigating current tab to '${targetUrl}'`);
            await gotoWithTimeoutRecovery({
              page,
              targetUrl,
              timeoutMs,
              logPath,
              label: "cdp-fallback"
            });
            appendLog(logPath, `CDP fallback attached to navigated tab: ${page.url() || "(blank)"}`);
            cdpMatchedOrRecovered = true;
          }
          if (attachRequireMatch && !cdpMatchedOrRecovered) {
            throw new Error(
              `No tab matched '${effectiveAttachMatchUrl}'. Use --attachMatchUrl with exact URL fragment or set --attachRequireMatch false.`
            );
          }
        }
        appendLog(logPath, `Attached to page: ${page.url() || "(blank)"}`);

        if (targetUrl && cdpNavigate) {
          await gotoWithTimeoutRecovery({
            page,
            targetUrl,
            timeoutMs,
            logPath,
            label: "cdp-navigate"
          });
          appendLog(logPath, "Navigated attached tab to configured URL");
        }
      } catch (cdpError) {
        const canFallbackToLocal = !requestedUseCdp && !liveMode && !caseMode;
        if (!canFallbackToLocal) {
          throw cdpError;
        }
        appendLog(logPath, `CDP auto-attach unavailable: ${cdpError.message || String(cdpError)}`);
        appendLog(logPath, "Falling back to local browser launch.");
        if (browser) {
          try {
            await browser.close();
          } catch {
            // ignore close failure while switching mode
          }
          browser = null;
        }
        usingCdp = false;
      }
    }

    if (!usingCdp && keepProgress) {
      context = await chromium.launchPersistentContext(sessionDir, {
        headless,
        channel: localChannel
      });
      appendLog(logPath, `Loaded persistent profile from ${sessionDir}`);
      const existingPages = context.pages();
      page = existingPages.length ? existingPages[0] : await context.newPage();
      await gotoWithTimeoutRecovery({
        page,
        targetUrl,
        timeoutMs,
        logPath,
        label: "persistent-context"
      });
    } else if (!usingCdp) {
      browser = await chromium.launch({ headless, channel: localChannel });
      context = await browser.newContext();
      appendLog(logPath, "Started clean ephemeral browser context");
      page = await context.newPage();
      await gotoWithTimeoutRecovery({
        page,
        targetUrl,
        timeoutMs,
        logPath,
        label: "ephemeral-context"
      });
    }

    try {
      await page.waitForSelector(domCheckSelector, { timeout: timeoutMs });
    } catch (error) {
      const message = String((error && error.message) || error || "");
      const isTimeout = message.toLowerCase().includes("timeout");
      if (!isTimeout) throw error;
      const html = await page.content().catch(() => "");
      const hasBodyMarkup = html.toLowerCase().includes("<body");
      if (!hasBodyMarkup) throw error;
      appendLog(
        logPath,
        `waitForSelector timeout recovered (${domCheckSelector}): page content exists and contains <body>.`
      );
    }
    finalUrl = page.url() || finalUrl;
    if (usingCdp && !cdpNavigate) {
      emitLiveProgress(`Reusing open tab: ${finalUrl || "(blank)"}`);
    } else {
      emitLiveProgress(`Navigating on: ${finalUrl || targetUrl || "unknown-page"}`);
    }
    appendLog(logPath, `Page ready at selector: ${domCheckSelector}`);
    appendLog(logPath, `Resolved final URL: ${finalUrl || "(unknown)"}`);
    networkMonitor = createNetworkMonitor({
      page,
      appendLogFn: appendLog,
      logPath,
      options: {
        enabled: networkLogEnabled,
        onlyApi: networkLogOnlyApi,
        includeBodies: networkLogIncludeBodies,
        maxEntries: networkLogMaxEntries,
        bodyMaxChars: networkLogBodyMaxChars,
      },
    });
    if (agentOverlayEnabled) {
      await setupAgentOverlay(page, {
        text: agentOverlayText,
        disableClicks: agentOverlayDisableClicks,
        lockOnStart: agentOverlayDisableClicks && agentOverlayLockDuringActions
      });
      appendLog(logPath, "Agent overlay mounted (fixed top-right)");
    }

    if (enableDomainCache) {
      const domainSourceForCache = finalUrl || effectiveConfiguredUrl;
      domain = getDomainFromAnyUrl(domainSourceForCache);
      domainCachePath = path.join(domainCacheDir, `${sanitizeDomainForFile(domain)}.json`);
      domainCache = loadDomainCache(domainCachePath, domain);
      appendLog(logPath, `Domain cache: ${domainCachePath}`);
      appendLog(logPath, `Previous runs for domain (${domain}): ${domainCache.runs.length}`);
      const recentDomainSummaries = summarizeRecentDomainRuns(domainCache, 3);
      if (recentDomainSummaries.length) {
        recentDomainSummaries.forEach((line, index) => {
          appendLog(logPath, `Previous[${index + 1}]: ${line}`);
        });
      }
      const currentPageSummary = summarizePageMemoryForUrl(domainCache, finalUrl || effectiveConfiguredUrl);
      if (currentPageSummary) {
        appendLog(logPath, `Page memory loaded: ${currentPageSummary.pageKey}`);
        appendLog(logPath, `Page memory visits: ${currentPageSummary.visits || 0}`);
        if (currentPageSummary.lastSummary) {
          appendLog(logPath, `Page memory last summary: ${currentPageSummary.lastSummary}`);
        }
      } else {
        appendLog(logPath, "Page memory loaded: (none for current URL)");
      }
      writeTextFile(
        path.join(outputDir, "last-domain-page-summary.json"),
        JSON.stringify(
          {
            domain,
            pageUrl: finalUrl || effectiveConfiguredUrl || null,
            found: Boolean(currentPageSummary),
            summary: currentPageSummary || null
          },
          null,
          2
        )
      );
    }

    if (command === "dom") {
      domLength = await captureDom(page, domPath, writeTextFile);
      finalDomPath = domPath;
      actionSummary = "captured-dom";
      appendLog(logPath, `DOM saved to ${domPath} (${domLength} chars)`);
      ensureLatestPointers({ outputDir, domPath, screenshotPath: null, logPath, fsModule: fs });
      runStatus = "success";
      return;
    }

    if (command === "action") {
      const type = args.type;
      if (!type) {
        throw new Error("For `action` command, pass --type <actionType>");
      }

      const action = {
        type,
        selector: args.selector,
        value: args.value,
        key: args.key,
        url: args.actionUrl || effectiveConfiguredUrl,
        ms: args.ms,
        script: args.script,
        expectSelector: args.expectSelector,
        expectUrlIncludes: args.expectUrlIncludes,
        expectDomChange: args.expectDomChange,
        // holdForUserAnswer
        prompt: args.prompt || args.instruction,
        toolbarTitle: args.toolbarTitle,
        submitLabel: args.submitLabel,
        acceptLabel: args.acceptLabel,
        placeholder: args.placeholder,
        requireNote: args.requireNote,
        holdTimeoutMs: args.holdTimeoutMs,
        fullScreenEdit: args.fullScreenEdit,
        drawScope: args.drawScope
      };

      let result;
      const startedStepAt = new Date().toISOString();
      const urlBeforeStep = page.url() || finalUrl || null;
      if (agentOverlayEnabled && agentOverlayDisableClicks && agentOverlayLockDuringActions) {
        await setAgentOverlayLocked(page, false);
        appendLog(logPath, "Agent click lock temporarily disabled for action execution");
      }
      try {
        result = await applyAction(page, action, timeoutMs);
      } catch (error) {
        failedStep = {
          index: 1,
          action,
          actionPreview: getActionPreview(action),
          error: error.message || String(error),
          urlAtFailure: page.url() || null
        };
        const failedRecord = {
          index: 1,
          action,
          actionPreview: getActionPreview(action),
          status: "failed",
          error: error.message || String(error),
          startedAt: startedStepAt,
          finishedAt: new Date().toISOString(),
          urlBefore: urlBeforeStep,
          urlAfter: page.url() || null
        };
        if (forceStepCapture) {
          const captured = await captureStepArtifacts({
            page,
            stepCaptureDir,
            stepIndex: 1,
            phase: "error",
            timeoutMs
          }).catch(() => null);
          if (captured) {
            failedRecord.domPath = captured.domPath;
            failedRecord.screenshotPath = captured.screenshotPath;
          }
        }
        stepTrace.push(failedRecord);
        const failedReview = buildStepReview({
          stepRecord: failedRecord,
          previousStep: stepTrace.length > 1 ? stepTrace[stepTrace.length - 2] : null
        });
        stepReviews.push(failedReview);
        writeTextFile(
          path.join(stepCaptureDir, "step-1-review.json"),
          JSON.stringify(failedReview, null, 2)
        );
        appendLog(logPath, `Step review 1: ${failedReview.observation}`);
        appendLog(logPath, `Step next 1: ${failedReview.nextSuggestion}`);
        writeStepAgentState({
          runDir,
          outputDir,
          runTag,
          finalUrl: page.url() || finalUrl,
          stepTrace,
          failedStep,
          stepReviews,
          runError: error.message || String(error),
          logPath
        });
        throw error;
      } finally {
        if (agentOverlayEnabled && agentOverlayDisableClicks && agentOverlayLockDuringActions) {
          await setAgentOverlayLocked(page, true);
          appendLog(logPath, "Agent click lock re-enabled after action");
        }
      }
      // `holdForUserAnswer` returns a structured payload (answer + annotation data URL).
      if ((action.type === "holdForUserAnswer" || action.type === "hold") && result && typeof result === "object") {
        holdAnswer = result;
        actionSummary = result.summary || "holdForUserAnswer";
        appendLog(logPath, `Action result: ${actionSummary}`);

        try {
          writeTextFile(holdAnswerPath, JSON.stringify(result, null, 2));
          appendLog(logPath, `Hold answer saved: ${holdAnswerPath}`);
        } catch (e) {
          appendLog(logPath, `Hold answer save failed: ${(e && e.message) || String(e)}`);
        }

        try {
          const dataUrl = result?.data?.annotationDataUrl || "";
          const m = String(dataUrl).match(/^data:image\/png;base64,(.+)$/);
          if (m && m[1]) {
            fs.writeFileSync(holdAnnotationPath, Buffer.from(m[1], "base64"));
            appendLog(logPath, `Hold annotation saved: ${holdAnnotationPath}`);
          } else {
            appendLog(logPath, "Hold annotation missing (no PNG data URL).");
          }
        } catch (e) {
          appendLog(logPath, `Hold annotation save failed: ${(e && e.message) || String(e)}`);
        }
        try {
          await page.screenshot({ path: holdCompositePath, fullPage: true, timeout: timeoutMs });
          appendLog(logPath, `Hold composite saved: ${holdCompositePath}`);
        } catch (e) {
          appendLog(logPath, `Hold composite save failed: ${(e && e.message) || String(e)}`);
        }
        try {
          await page.evaluate(() => {
            const hold = window.__browserEmulatorHold;
            if (hold && typeof hold.cleanup === "function") hold.cleanup();
          });
        } catch {
          // best effort cleanup only
        }
      } else {
        actionSummary = result;
        appendLog(logPath, `Action result: ${result}`);
      }
      const stepRecord = {
        index: 1,
        action,
        actionPreview: getActionPreview(action),
        status: "success",
        result,
        startedAt: startedStepAt,
        finishedAt: new Date().toISOString(),
        urlBefore: urlBeforeStep,
        urlAfter: page.url() || null
      };
      if (forceStepCapture) {
        const afterCaptured = await captureStepArtifacts({
          page,
          stepCaptureDir,
          stepIndex: 1,
          phase: "after",
          timeoutMs
        }).catch(() => null);
        stepRecord.domPath = (afterCaptured && afterCaptured.domPath) || null;
        stepRecord.screenshotPath = (afterCaptured && afterCaptured.screenshotPath) || null;
      }
      stepTrace.push(stepRecord);
      const successReview = buildStepReview({
        stepRecord,
        previousStep: stepTrace.length > 1 ? stepTrace[stepTrace.length - 2] : null
      });
      stepReviews.push(successReview);
      writeTextFile(
        path.join(stepCaptureDir, "step-1-review.json"),
        JSON.stringify(successReview, null, 2)
      );
      appendLog(logPath, `Step review 1: ${successReview.observation}`);
      appendLog(logPath, `Step next 1: ${successReview.nextSuggestion}`);
      if (reviewBeforeNextStep) {
        runStepReviewGate({
          review: successReview,
          stepRecord,
          forceStepCapture
        });
        appendLog(logPath, "Step review gate passed (step 1).");
      }
      writeStepAgentState({
        runDir,
        outputDir,
        runTag,
        finalUrl: page.url() || finalUrl,
        stepTrace,
        failedStep,
        stepReviews,
        runError,
        logPath
      });
      if (saveCaseNoteTo) {
        if (!String(caseKey || "").trim()) {
          appendLog(logPath, "Step note skipped: set --caseKey when using --saveCaseNoteTo.");
        } else {
          const savedNotePath = saveCaseNote({
            notesPath: saveCaseNoteTo,
            caseKey,
            targetUrl: targetUrl || finalUrl || "",
            action,
            runTag,
            finalUrl: page.url() || finalUrl || "",
            noteText: caseNote,
            ensureDirFn: ensureDir
          });
          appendLog(logPath, `Step note saved to case notes: ${savedNotePath} (key=${caseKey})`);
        }
      }
      if (captureDomAfterRun) {
        domLength = await captureDom(page, domPath, writeTextFile);
        finalDomPath = domPath;
        appendLog(logPath, `DOM saved to ${domPath} (${domLength} chars)`);
      } else {
        appendLog(logPath, "DOM capture skipped (captureDomAfterRun=false)");
      }
      if (captureScreenshotAfterRun) {
        await page.screenshot({ path: screenshotPath, fullPage: true, timeout: timeoutMs });
        finalScreenshotPath = screenshotPath;
        appendLog(logPath, `Screenshot saved to ${screenshotPath}`);
      } else {
        appendLog(logPath, "Screenshot capture skipped (captureScreenshotAfterRun=false)");
      }
      finalUrl = page.url() || finalUrl;
      ensureLatestPointers({
        outputDir,
        domPath: finalDomPath,
        screenshotPath: finalScreenshotPath,
        logPath,
        fsModule: fs
      });
      runStatus = "success";
      return;
    }

    const actions = loadedCase
      ? loadedCase.actions
      : (Array.isArray(config.actions) ? config.actions : []);
    let startIndex = 0;
    let endIndexExclusive = actions.length;
    let caseProgressPath = "";
    if (caseMode && stepMode) {
      caseProgressPath = getCaseProgressPath(outputDir, loadedCase.path);
      const progress = resetCaseProgress ? { nextIndex: 0 } : loadCaseProgress(caseProgressPath);
      startIndex = Math.max(0, Number(progress.nextIndex || 0));
      if (startIndex > 0) {
        const expectedToken = String(progress.pendingReviewToken || "").trim();
        if (!expectedToken || reviewTokenArg !== expectedToken) {
          throw new Error(
            `Missing/invalid review token for next step. Read previous image/review, then run with --reviewToken "${expectedToken || "TOKEN_FROM_PREVIOUS_STEP"}".`
          );
        }
      }
      if (startIndex >= actions.length) {
        appendLog(logPath, "Case already completed in step mode. Use --resetCaseProgress true to restart.");
        actionSummary = "case-already-complete";
        runStatus = "success";
        return;
      }
      endIndexExclusive = Math.min(actions.length, startIndex + stepBatchSize);
      appendLog(
        logPath,
        `Step mode progress: running step(s) ${startIndex + 1}..${endIndexExclusive} of ${actions.length}`
      );
    }
    appendLog(logPath, `Starting emulator run with ${actions.length} action(s)`);

    const unlockOverlayForLoop = agentOverlayEnabled && agentOverlayDisableClicks && agentOverlayLockDuringActions;
    if (unlockOverlayForLoop) {
      await setAgentOverlayLocked(page, false);
      appendLog(logPath, "Agent click lock disabled for action loop (keeps Vuetify menus open between steps)");
    }

    try {
    for (let i = startIndex; i < endIndexExclusive; i += 1) {
      let result;
      const action = actions[i];
      emitLiveProgress(`Running step ${i + 1}: ${getActionPreview(action)}`);
      const startedStepAt = new Date().toISOString();
      const urlBeforeStep = page.url() || finalUrl || null;
      try {
        result = await applyAction(page, action, timeoutMs);
      } catch (error) {
        failedStep = {
          index: i + 1,
          action,
          actionPreview: getActionPreview(action),
          error: error.message || String(error),
          urlAtFailure: page.url() || null
        };
        const failedRecord = {
          index: i + 1,
          action,
          actionPreview: getActionPreview(action),
          status: "failed",
          error: error.message || String(error),
          startedAt: startedStepAt,
          finishedAt: new Date().toISOString(),
          urlBefore: urlBeforeStep,
          urlAfter: page.url() || null
        };
        if (forceStepCapture) {
          const captured = await captureStepArtifacts({
            page,
            stepCaptureDir,
            stepIndex: i + 1,
            phase: "error",
            timeoutMs
          }).catch(() => null);
          if (captured) {
            failedRecord.domPath = captured.domPath;
            failedRecord.screenshotPath = captured.screenshotPath;
          }
        }
        stepTrace.push(failedRecord);
        const failedReview = buildStepReview({
          stepRecord: failedRecord,
          previousStep: stepTrace.length > 1 ? stepTrace[stepTrace.length - 2] : null
        });
        stepReviews.push(failedReview);
        writeTextFile(
          path.join(stepCaptureDir, `step-${i + 1}-review.json`),
          JSON.stringify(failedReview, null, 2)
        );
        appendLog(logPath, `Step review ${i + 1}: ${failedReview.observation}`);
        appendLog(logPath, `Step next ${i + 1}: ${failedReview.nextSuggestion}`);
        writeStepAgentState({
          runDir,
          outputDir,
          runTag,
          finalUrl: page.url() || finalUrl,
          stepTrace,
          failedStep,
          stepReviews,
          runError: error.message || String(error),
          logPath
        });
        throw error;
      }
      const stepRecord = {
        index: i + 1,
        action,
        actionPreview: getActionPreview(action),
        status: "success",
        result,
        startedAt: startedStepAt,
        finishedAt: new Date().toISOString(),
        urlBefore: urlBeforeStep,
        urlAfter: page.url() || null
      };
      if (forceStepCapture) {
        const captured = await captureStepArtifacts({
          page,
          stepCaptureDir,
          stepIndex: i + 1,
          phase: "after",
          timeoutMs
        }).catch(() => null);
        stepRecord.domPath = captured ? captured.domPath : null;
        stepRecord.screenshotPath = captured ? captured.screenshotPath : null;
      }
      stepTrace.push(stepRecord);
      const successReview = buildStepReview({
        stepRecord,
        previousStep: stepTrace.length > 1 ? stepTrace[stepTrace.length - 2] : null
      });
      stepReviews.push(successReview);
      writeTextFile(
        path.join(stepCaptureDir, `step-${i + 1}-review.json`),
        JSON.stringify(successReview, null, 2)
      );
      appendLog(logPath, `Step review ${i + 1}: ${successReview.observation}`);
      appendLog(logPath, `Step next ${i + 1}: ${successReview.nextSuggestion}`);
      if (reviewBeforeNextStep) {
        runStepReviewGate({
          review: successReview,
          stepRecord,
          forceStepCapture
        });
        appendLog(logPath, `Step review gate passed (step ${i + 1}).`);
      }
      writeStepAgentState({
        runDir,
        outputDir,
        runTag,
        finalUrl: page.url() || finalUrl,
        stepTrace,
        failedStep,
        stepReviews,
        runError,
        logPath
      });
      if (reviewBeforeNextStep && reviewPauseMs > 0) {
        await page.waitForTimeout(reviewPauseMs);
      }
      appendLog(logPath, `Step ${i + 1}/${actions.length}: ${result}`);
      emitLiveProgress(`Completed step ${i + 1}`);
      await page.waitForTimeout(waitAfterActionMs);
    }
    } finally {
      if (unlockOverlayForLoop) {
        await setAgentOverlayLocked(page, true).catch(() => {});
        appendLog(logPath, "Agent click lock re-enabled after action loop");
      }
    }

    if (caseMode && stepMode) {
      const nextIndex = endIndexExclusive;
      const progressPath = getCaseProgressPath(outputDir, loadedCase.path);
      const nextReviewToken = nextIndex < actions.length ? makeReviewToken(nextIndex) : "";
      saveCaseProgress(progressPath, {
        caseFilePath: loadedCase.path,
        nextIndex,
        totalActions: actions.length,
        pendingReviewToken: nextReviewToken,
        updatedAt: new Date().toISOString(),
        lastRunTag: runTag
      });
      if (nextIndex < actions.length) {
        actionSummary = `paused-after-step-${nextIndex}`;
        appendLog(logPath, `Step mode pause: review captures now, next step is ${nextIndex + 1}.`);
        appendLog(logPath, "Agent instruction: read step image + review JSON before next run.");
        appendLog(logPath, "Case run exits now. Next step only runs on a new command.");
        console.log(`REVIEW_TOKEN: ${nextReviewToken}`);
        emitLiveProgress("Rendering playback");
      } else {
        actionSummary = `case-complete-${actions.length}-steps`;
        appendLog(logPath, "Step mode: case completed.");
        emitLiveProgress("Rendering playback");
      }
    } else {
      actionSummary = `ran-${actions.length}-actions`;
    }
    if (captureDomAfterRun) {
      domLength = await captureDom(page, domPath, writeTextFile);
      finalDomPath = domPath;
      appendLog(logPath, `DOM saved to ${domPath} (${domLength} chars)`);
    } else {
      appendLog(logPath, "DOM capture skipped (captureDomAfterRun=false)");
    }
    if (captureScreenshotAfterRun) {
      await page.screenshot({ path: screenshotPath, fullPage: true, timeout: timeoutMs });
      finalScreenshotPath = screenshotPath;
      appendLog(logPath, `Screenshot saved to ${screenshotPath}`);
    } else {
      appendLog(logPath, "Screenshot capture skipped (captureScreenshotAfterRun=false)");
    }
    finalUrl = page.url() || finalUrl;
    ensureLatestPointers({
      outputDir,
      domPath: finalDomPath,
      screenshotPath: finalScreenshotPath,
      logPath,
      fsModule: fs
    });
    runStatus = "success";
  } catch (error) {
    runError = error.message || String(error);
    appendLog(logPath, `Run failed: ${runError}`);
    if (page) {
      try {
        const failureDomPath = path.join(runDir, "dom-error.html");
        domLength = await captureDom(page, failureDomPath, writeTextFile);
        finalDomPath = failureDomPath;
        appendLog(logPath, `Failure DOM saved to ${failureDomPath} (${domLength} chars)`);
      } catch {
        appendLog(logPath, "Failure DOM capture failed");
      }
      try {
        const failureScreenPath = path.join(runDir, `screen-error-${getNowTag()}.png`);
        await page.screenshot({ path: failureScreenPath, fullPage: true, timeout: timeoutMs });
        finalScreenshotPath = failureScreenPath;
        appendLog(logPath, `Failure screenshot saved to ${failureScreenPath}`);
      } catch {
        appendLog(logPath, "Failure screenshot capture failed");
      }
      if (failedStep) {
        const stepFallbackDom = failedStep.domPath || (stepTrace.length ? stepTrace[stepTrace.length - 1].domPath : null);
        const stepFallbackShot = failedStep.screenshotPath || (stepTrace.length ? stepTrace[stepTrace.length - 1].screenshotPath : null);
        finalDomPath = resolveBestFailureArtifactPath({
          preferredPath: finalDomPath,
          fallbackPath: stepFallbackDom,
          existsSyncFn: fs.existsSync
        });
        finalScreenshotPath = resolveBestFailureArtifactPath({
          preferredPath: finalScreenshotPath,
          fallbackPath: stepFallbackShot,
          existsSyncFn: fs.existsSync
        });
      }
      finalUrl = page.url() || finalUrl;
    }
    throw error;
  } finally {
    if (page && forgetPageAfterRun) {
      try {
        await forgetPageData(page, appendLog, logPath);
      } catch {
        appendLog(logPath, "Forget mode: failed to clear some page data");
      }
    }

    if (page && agentOverlayEnabled && !agentOverlayKeepAfterRun) {
      try {
        await removeAgentOverlay(page);
        appendLog(logPath, "Agent overlay removed");
      } catch {
        appendLog(logPath, "Agent overlay cleanup skipped (page unavailable)");
      }
    }

    // Intentionally do not close browser/context here.

    const finishedAt = new Date().toISOString();
    let networkSummary = null;
    if (networkMonitor) {
      await networkMonitor.flush();
      const networkEntries = networkMonitor.getEntries();
      networkSummary = networkMonitor.buildSummary();
      writeTextFile(networkLogPath, JSON.stringify(networkEntries, null, 2));
      writeTextFile(networkSummaryPath, JSON.stringify(networkSummary, null, 2));
      finalNetworkLogPath = networkLogPath;
      finalNetworkSummaryPath = networkSummaryPath;
      appendLog(logPath, `Network log saved to ${networkLogPath} (${networkEntries.length} entries)`);
      appendLog(logPath, `Network summary saved to ${networkSummaryPath}`);
    }
    const warnings = [];
    if (runStatus === "success" && isLikelyAuthRedirect(targetUrl, finalUrl)) {
      warnings.push("Redirected to login page; authentication likely required.");
      appendLog(logPath, "Warning: redirected to login page after navigation/action.");
    }
    const severity = runStatus === "success" && warnings.length > 0 ? "warning" : runStatus;
    ensureLatestPointers({
      outputDir,
      domPath: finalDomPath,
      screenshotPath: finalScreenshotPath,
      logPath,
      fsModule: fs
    });
    const summary = {
      runTag,
      command,
      preset,
      mode: usingCdp ? "cdp-attach" : "local-launch",
      status: runStatus,
      severity,
      warnings,
      startedAt,
      finishedAt,
      targetUrl: targetUrl || null,
      finalUrl: finalUrl || null,
      actionSummary: actionSummary || null,
      holdAnswerPath: holdAnswer ? holdAnswerPath : null,
      holdAnnotationPath: holdAnswer ? holdAnnotationPath : null,
      holdCompositePath: holdAnswer ? holdCompositePath : null,
      domCaptured: Boolean(finalDomPath),
      screenshotCaptured: Boolean(finalScreenshotPath),
      domPath: finalDomPath,
      screenshotPath: finalScreenshotPath,
      networkLogPath: finalNetworkLogPath,
      networkSummaryPath: finalNetworkSummaryPath,
      networkApiErrorCount: networkSummary ? networkSummary.apiErrorResponses.length : 0,
      logPath,
      caseFilePath: loadedCase ? loadedCase.path : null,
      stepCount: stepTrace.length,
      failedStep
    };
    writeRunSummary({ outputDir, runDir, summary });
    writeCaseDiagnostics({
      runDir,
      outputDir,
      runTag,
      caseFilePath: loadedCase ? loadedCase.path : caseFilePath,
      targetUrl,
      finalUrl,
      runStatus: severity,
      runError,
      stepTrace,
      stepReviews,
      failedStep,
      logPath,
      domPath: finalDomPath,
      screenshotPath: finalScreenshotPath,
      networkLogPath: finalNetworkLogPath,
      networkSummaryPath: finalNetworkSummaryPath,
      holdAnswerPath: holdAnswer ? holdAnswerPath : null,
      holdAnnotationPath: holdAnswer ? holdAnnotationPath : null,
      holdCompositePath: holdAnswer ? holdCompositePath : null
    });
    appendLog(logPath, `Run summary saved: ${path.join(runDir, "run-summary.json")}`);
    const finalStatus = (summary.severity === "success" || summary.severity === "warning")
      ? "SUCCESS"
      : "FAIL";
    console.log(`${finalStatus}: agent read image then do next step.`);
    let currentPageTitle = "";
    if (page) {
      try {
        currentPageTitle = await page.title();
      } catch {
        currentPageTitle = "";
      }
    }

    if (enableDomainCache && domainCachePath) {
      if (!domainCache) {
        domainCache = loadDomainCache(domainCachePath, domain);
      }
      domainCache.runs.push({
        runTag,
        command,
        status: severity,
        startedAt,
        finishedAt,
        url: effectiveConfiguredUrl || finalUrl || null,
        finalUrl: finalUrl || null,
        sessionName,
        keepProgress,
        mode: usingCdp ? "cdp-attach" : "local-launch",
        domPath: finalDomPath,
        domLength,
        screenshotPath: finalScreenshotPath,
        logPath,
        runDir,
        summary: actionSummary || null,
        error: runError || null
      });
      const updatedPageSummary = updateDomainPageSummary(domainCache, {
        targetUrl: targetUrl || effectiveConfiguredUrl || "",
        finalUrl: finalUrl || "",
        runTag,
        status: severity,
        actionSummary: actionSummary || "",
        stepTrace,
        pageTitle: currentPageTitle
      });
      saveDomainCache(domainCachePath, domainCache, maxDomainRuns);
      appendLog(logPath, `Domain note saved: ${domainCachePath}`);
      if (updatedPageSummary) {
        appendLog(logPath, `Page memory updated: ${updatedPageSummary.pageKey}`);
        writeTextFile(
          path.join(outputDir, "last-domain-page-summary.json"),
          JSON.stringify(
            {
              domain,
              pageUrl: updatedPageSummary.pageUrl || finalUrl || null,
              found: true,
              summary: updatedPageSummary
            },
            null,
            2
          )
        );
      }
      if (forgetDomainCacheAfterRun) {
        safeDeletePath(domainCachePath);
        appendLog(logPath, `Forget mode: domain cache removed (${domainCachePath})`);
      }
    }

    if (!usingCdp && keepProgress && forgetSessionAfterRun) {
      safeDeletePath(sessionDir);
      appendLog(logPath, `Forget mode: session profile removed (${sessionDir})`);
    }

    if (forgetArtifactsAfterRun) {
      const keepLogSnapshot = path.join(outputDir, "last-run.log");
      const keepMetaSnapshot = path.join(outputDir, "last-run.json");
      if (finalDomPath) safeDeletePath(finalDomPath);
      if (finalScreenshotPath) safeDeletePath(finalScreenshotPath);
      appendLog(logPath, "Forget mode: DOM/screenshot artifacts removed");
      if (fs.existsSync(keepLogSnapshot)) safeDeletePath(keepLogSnapshot);
      if (fs.existsSync(keepMetaSnapshot)) safeDeletePath(keepMetaSnapshot);
    }

    // End process explicitly because browser/context close logic is disabled.
    process.exit((summary.severity === "success" || summary.severity === "warning") ? 0 : 1);
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
