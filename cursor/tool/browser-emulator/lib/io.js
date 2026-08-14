const fs = require("fs");
const path = require("path");

const runtimeState = {
  quiet: false
};

function setQuietMode(quiet) {
  runtimeState.quiet = Boolean(quiet);
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function loadConfig(configPath) {
  let resolvedConfigPath = configPath;
  if (!fs.existsSync(resolvedConfigPath)) {
    const fallbackExamplePath = path.join(path.dirname(configPath), "config.example.json");
    if (path.basename(configPath).toLowerCase() === "config.json" && fs.existsSync(fallbackExamplePath)) {
      resolvedConfigPath = fallbackExamplePath;
      console.log(`Config not found at ${configPath}. Using ${fallbackExamplePath} instead.`);
    } else {
      throw new Error(
        `Config not found: ${configPath}. Copy config.example.json to config.json first.`
      );
    }
  }

  const content = fs.readFileSync(resolvedConfigPath, "utf8");
  return JSON.parse(content);
}

function getNowTag() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null) {
    return fallback;
  }
  if (typeof value === "boolean") {
    return value;
  }

  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off"].includes(normalized)) return false;
  return fallback;
}

function writeTextFile(filePath, content) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, content, "utf8");
}

function safeDeletePath(targetPath) {
  if (!targetPath) return;
  if (!fs.existsSync(targetPath)) return;
  fs.rmSync(targetPath, { recursive: true, force: true });
}

function appendLog(filePath, message) {
  if (!filePath) return;
  try {
    ensureDir(path.dirname(filePath));
    const line = `[${new Date().toISOString()}] ${String(message || "")}\n`;
    fs.appendFileSync(filePath, line, "utf8");
    if (!runtimeState.quiet) {
      // Keep console output minimal; the run already prints key lines.
      // This is only useful when running the tool directly.
    }
  } catch {
    // Best-effort logging; never crash the run due to log write failure.
  }
}

module.exports = {
  ensureDir,
  loadConfig,
  getNowTag,
  parseBoolean,
  writeTextFile,
  safeDeletePath,
  appendLog,
  setQuietMode,
  runtimeState
};

