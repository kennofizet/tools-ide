const fs = require("fs");
const { writeTextFile } = require("./io");

function sanitizeDomainForFile(domain) {
  return String(domain || "unknown-domain").toLowerCase().replace(/[^a-z0-9.-]/g, "_");
}

function getDomainFromUrl(urlString) {
  return new URL(urlString).hostname || "unknown-domain";
}

function getDomainFromAnyUrl(urlString, fallback = "unknown-domain") {
  if (!urlString) return fallback;
  try {
    return getDomainFromUrl(urlString);
  } catch {
    return fallback;
  }
}

function loadDomainCache(cachePath, domain) {
  if (!fs.existsSync(cachePath)) {
    return {
      domain,
      createdAt: new Date().toISOString(),
      updatedAt: null,
      totalRuns: 0,
      runs: [],
      pageSummaries: {}
    };
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    return {
      domain,
      createdAt: parsed.createdAt || new Date().toISOString(),
      updatedAt: parsed.updatedAt || null,
      totalRuns: Number(parsed.totalRuns || 0),
      runs: Array.isArray(parsed.runs) ? parsed.runs : [],
      pageSummaries: parsed && typeof parsed.pageSummaries === "object" && !Array.isArray(parsed.pageSummaries)
        ? parsed.pageSummaries
        : {}
    };
  } catch {
    return {
      domain,
      createdAt: new Date().toISOString(),
      updatedAt: null,
      totalRuns: 0,
      runs: [],
      pageSummaries: {}
    };
  }
}

function summarizeRecentDomainRuns(domainCache, maxItems = 3) {
  const recent = domainCache.runs.slice(-maxItems);
  return recent.map((run) => {
    const status = run.status || "unknown";
    const command = run.command || "run";
    const tag = run.runTag || "untagged";
    const url = run.finalUrl || run.url || "";
    return `${tag} | ${command} | ${status} | ${url}`;
  });
}

function saveDomainCache(cachePath, domainCache, maxRuns = 100) {
  const trimmedRuns = domainCache.runs.slice(-maxRuns);
  const payload = {
    ...domainCache,
    updatedAt: new Date().toISOString(),
    totalRuns: trimmedRuns.length,
    runs: trimmedRuns
  };
  writeTextFile(cachePath, JSON.stringify(payload, null, 2));
}

function getPageKeyFromUrl(urlString) {
  try {
    const parsed = new URL(urlString);
    const pathPart = parsed.pathname || "/";
    const queryPart = parsed.search || "";
    return `${pathPart}${queryPart}`;
  } catch {
    return "/";
  }
}

function buildStepFlowPreview(stepTrace, maxItems = 8) {
  if (!Array.isArray(stepTrace) || !stepTrace.length) return [];
  return stepTrace.slice(-maxItems).map((step) => {
    const status = step && step.status ? step.status : "unknown";
    const preview = step && step.actionPreview ? step.actionPreview : "action";
    const urlAfter = step && step.urlAfter ? step.urlAfter : "";
    return `${preview} -> ${status}${urlAfter ? ` @ ${urlAfter}` : ""}`;
  });
}

function extractSelectorHints(stepTrace, maxItems = 20) {
  if (!Array.isArray(stepTrace) || !stepTrace.length) return [];
  const hints = [];
  stepTrace.forEach((step) => {
    const selector = step && step.action && typeof step.action.selector === "string"
      ? step.action.selector.trim()
      : "";
    if (!selector) return;
    if (!hints.includes(selector)) {
      hints.push(selector);
    }
  });
  return hints.slice(0, maxItems);
}

function updateDomainPageSummary(domainCache, {
  targetUrl,
  finalUrl,
  runTag,
  status,
  actionSummary,
  stepTrace,
  pageTitle
}) {
  if (!domainCache || typeof domainCache !== "object") return null;
  const pageUrl = finalUrl || targetUrl || "";
  const pageKey = getPageKeyFromUrl(pageUrl);
  if (!domainCache.pageSummaries || typeof domainCache.pageSummaries !== "object") {
    domainCache.pageSummaries = {};
  }
  const previous = domainCache.pageSummaries[pageKey] || null;
  const now = new Date().toISOString();
  const nextVisitCount = Number(previous && previous.visits ? previous.visits : 0) + 1;
  const flowPreview = buildStepFlowPreview(stepTrace, 8);
  const selectorHints = extractSelectorHints(stepTrace, 20);
  const summaryEntry = {
    pageKey,
    pageUrl,
    title: String(pageTitle || (previous && previous.title) || "").trim(),
    visits: nextVisitCount,
    firstSeenAt: previous && previous.firstSeenAt ? previous.firstSeenAt : now,
    updatedAt: now,
    lastRunTag: runTag || "",
    lastStatus: status || "unknown",
    lastSummary: actionSummary || "",
    flowPreview,
    selectorHints
  };
  domainCache.pageSummaries[pageKey] = summaryEntry;
  return summaryEntry;
}

function summarizePageMemoryForUrl(domainCache, urlString) {
  if (!domainCache || !domainCache.pageSummaries) return null;
  const pageKey = getPageKeyFromUrl(urlString || "");
  return domainCache.pageSummaries[pageKey] || null;
}

module.exports = {
  sanitizeDomainForFile,
  getDomainFromUrl,
  getDomainFromAnyUrl,
  loadDomainCache,
  summarizeRecentDomainRuns,
  saveDomainCache,
  updateDomainPageSummary,
  summarizePageMemoryForUrl
};

