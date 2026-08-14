const path = require("path");
const { writeTextFile } = require("./io");

function ensureLatestPointers({ outputDir, domPath, screenshotPath, logPath, fsModule }) {
  const latestDomPath = path.join(outputDir, "dom-latest.html");
  const latestScreenshotPath = path.join(outputDir, "screen-latest.png");
  const latestLogPath = path.join(outputDir, "last-run.log");
  const latestMetaPath = path.join(outputDir, "last-run.json");

  if (domPath && fsModule.existsSync(domPath)) {
    fsModule.copyFileSync(domPath, latestDomPath);
  }
  if (logPath && fsModule.existsSync(logPath)) {
    fsModule.copyFileSync(logPath, latestLogPath);
  }
  if (screenshotPath && fsModule.existsSync(screenshotPath)) {
    fsModule.copyFileSync(screenshotPath, latestScreenshotPath);
  }

  const metadata = {
    updatedAt: new Date().toISOString(),
    domPath,
    screenshotPath,
    logPath
  };
  writeTextFile(latestMetaPath, JSON.stringify(metadata, null, 2));
}

function isLikelyAuthRedirect(targetUrl, finalUrl) {
  try {
    if (!targetUrl || !finalUrl) return false;
    const target = new URL(targetUrl);
    const final = new URL(finalUrl);
    const targetPath = (target.pathname || "").toLowerCase();
    const finalPath = (final.pathname || "").toLowerCase();
    return final.host === target.host
      && finalPath.includes("/login")
      && !targetPath.includes("/login");
  } catch {
    return false;
  }
}

function writeRunSummary({ outputDir, runDir, summary }) {
  const runSummaryPath = path.join(runDir, "run-summary.json");
  const latestSummaryPath = path.join(outputDir, "last-run-summary.json");
  writeTextFile(runSummaryPath, JSON.stringify(summary, null, 2));
  writeTextFile(latestSummaryPath, JSON.stringify(summary, null, 2));
}

module.exports = {
  ensureLatestPointers,
  isLikelyAuthRedirect,
  writeRunSummary
};

