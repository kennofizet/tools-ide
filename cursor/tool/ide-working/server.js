const fs = require("fs");
const http = require("http");
const path = require("path");
const { spawn } = require("child_process");
const { VALID_COMMANDS, printHelp, parseArgs } = require("./lib/cli");
const { createViewer, DEFAULT_PORT } = require("./lib/viewer");

const TOOL_ROOT = __dirname;
const DEFAULT_CONFIG = path.join(TOOL_ROOT, "config.json");

function parseBoolean(value) {
  if (value === true || value === false) return value;
  const text = String(value || "").trim().toLowerCase();
  return text === "1" || text === "true" || text === "yes";
}

function loadConfig(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return {};
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    throw new Error(`Could not parse config: ${filePath}`);
  }
}

function readSiblingHubState() {
  const file = path.join(TOOL_ROOT, "..", "socket-server", "output", "last-hub.json");
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function outputDir() {
  const dir = path.join(TOOL_ROOT, "output");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function statePath() {
  return path.join(outputDir(), "last-ide-working.json");
}

function readState() {
  const file = statePath();
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writeState(data) {
  fs.writeFileSync(statePath(), JSON.stringify(data, null, 2));
}

function isLoopbackHost(hostname) {
  const host = String(hostname || "")
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

function resolveOptions(args) {
  const configPath = args.config ? path.resolve(String(args.config)) : DEFAULT_CONFIG;
  const config = loadConfig(configPath);
  const sibling = readSiblingHubState();
  const bind = String(args.bind || config.bind || "127.0.0.1");
  const port = Number(args.port || config.port || DEFAULT_PORT);
  const hubUrl = String(
    args.hubUrl || config.hubUrl || (sibling && `http://127.0.0.1:${sibling.port}`) || "http://127.0.0.1:8787"
  ).replace(/\/$/, "");
  const hubPath = String(args.hubPath || config.hubPath || (sibling && sibling.path) || "/hub");
  const hubToken = String(args.hubToken || config.hubToken || process.env.TOOLS_HUB_TOKEN || "");
  const room = String(args.room || config.room || (sibling && sibling.room) || "tools");
  return { configPath, bind, port, hubUrl, hubPath, hubToken, room };
}

function publicHost(bind) {
  return isLoopbackHost(bind) ? "127.0.0.1" : bind;
}

function httpHealth(options) {
  const host = publicHost(options.bind);
  return new Promise((resolve, reject) => {
    const req = http.get(
      { hostname: host, port: options.port, path: "/health", timeout: 2000 },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          let body = {};
          try {
            body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
          } catch {
            body = {};
          }
          resolve({ status: res.statusCode, body });
        });
      }
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("health timeout"));
    });
  });
}

async function startForeground(options) {
  const viewer = createViewer(options);
  const address = await viewer.listen();
  const actualPort = address.port || options.port;
  const host = publicHost(options.bind);
  const state = {
    pid: process.pid,
    bind: options.bind,
    port: actualPort,
    hubUrl: options.hubUrl,
    room: options.room,
    url: `http://${host}:${actualPort}/`,
    startedAt: new Date().toISOString()
  };
  writeState(state);
  console.log(`IDE_WORKING_URL=${state.url}`);
  console.log(`IDE_WORKING_HEALTH=http://${host}:${actualPort}/health`);
  console.log(`IDE_WORKING_HUB=${options.hubUrl}`);
  const stop = async () => {
    await viewer.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  await new Promise(() => {});
}

function startDetached(rawArgv) {
  const pass = ["start"];
  const keep = ["config", "port", "bind", "hubUrl", "hubPath", "hubToken", "room"];
  keep.forEach((key) => {
    if (rawArgv[key] !== undefined && rawArgv[key] !== true) {
      pass.push(`--${key}`, String(rawArgv[key]));
    }
  });
  const child = spawn(process.execPath, [path.join(TOOL_ROOT, "server.js"), ...pass], {
    cwd: TOOL_ROOT,
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
  console.log(`IDE_WORKING_DETACHED pid=${child.pid}`);
  return child.pid;
}

function stopViewer() {
  const state = readState();
  if (!state || !state.pid) {
    console.log("IDE_WORKING_STOPPED already idle");
    return;
  }
  try {
    process.kill(state.pid);
  } catch {
    // already gone
  }
  console.log("IDE_WORKING_STOPPED");
}

async function main() {
  const argv = process.argv.slice(2);
  const command = argv[0] && !argv[0].startsWith("--") ? argv[0] : "help";
  const args = parseArgs(argv.slice(command === argv[0] ? 1 : 0));
  if (!VALID_COMMANDS.has(command) || command === "help") {
    printHelp();
    process.exit(command === "help" ? 0 : 2);
  }
  const options = resolveOptions(args);
  if (command === "start") {
    if (parseBoolean(args.detach)) {
      startDetached(args);
      return;
    }
    await startForeground(options);
    return;
  }
  if (command === "health") {
    const result = await httpHealth(options);
    if (result.status !== 200 || !result.body.ok) {
      console.log("IDE_WORKING_HUB_OFF");
      console.log(JSON.stringify(result.body, null, 2));
      process.exit(1);
    }
    console.log("IDE_WORKING_HEALTH_OK");
    console.log(JSON.stringify(result.body, null, 2));
    return;
  }
  if (command === "stop") {
    stopViewer();
  }
}

main().catch((error) => {
  console.error(String(error && error.stack ? error.stack : error));
  process.exit(1);
});
