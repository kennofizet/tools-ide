const fs = require("fs");
const http = require("http");
const path = require("path");
const { spawn } = require("child_process");
const { VALID_COMMANDS, printHelp, parseArgs } = require("./lib/cli");
const { createHub } = require("./lib/hub");
const { connectHub } = require("./lib/client");
const { isLoopbackHost } = require("./lib/protocol");

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

function outputDir() {
  const dir = path.join(TOOL_ROOT, "output");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function statePath() {
  return path.join(outputDir(), "last-hub.json");
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

function resolveOptions(args) {
  const configPath = args.config ? path.resolve(String(args.config)) : DEFAULT_CONFIG;
  const config = loadConfig(configPath);
  const bind = String(args.bind || config.bind || "127.0.0.1");
  const port = Number(args.port || config.port || 8787);
  const wsPath = String(args.path || config.path || "/hub");
  const token = String(args.token || config.token || process.env.TOOLS_HUB_TOKEN || "");
  const room = String(args.room || config.room || "tools");
  return { configPath, bind, port, path: wsPath, token, room };
}

function wsUrl(options) {
  const host = isLoopbackHost(options.bind) ? "127.0.0.1" : options.bind;
  return `ws://${host}:${options.port}${options.path}`;
}

function httpHealth(options) {
  const host = isLoopbackHost(options.bind) ? "127.0.0.1" : options.bind;
  return new Promise((resolve, reject) => {
    const req = http.get(
      { hostname: host, port: options.port, path: "/health", timeout: 2000 },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
          } catch (error) {
            reject(error);
          }
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
  const hub = createHub(options);
  const address = await hub.listen();
  const actualPort = address.port || options.port;
  const state = {
    pid: process.pid,
    bind: options.bind,
    port: actualPort,
    path: options.path,
    room: options.room,
    url: `ws://${isLoopbackHost(options.bind) ? "127.0.0.1" : options.bind}:${actualPort}${options.path}`,
    startedAt: new Date().toISOString()
  };
  writeState(state);
  console.log(`HUB_URL=${state.url}`);
  console.log(`HUB_HEALTH=http://${isLoopbackHost(options.bind) ? "127.0.0.1" : options.bind}:${actualPort}/health`);
  console.log(`HUB_ROOM=${options.room}`);
  const stop = async () => {
    await hub.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  await new Promise(() => {});
}

function startDetached(rawArgv) {
  const pass = ["start"];
  const keep = ["config", "port", "bind", "path", "token", "room"];
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
  console.log(`HUB_DETACHED pid=${child.pid}`);
  return child.pid;
}

function stopHub() {
  const state = readState();
  if (!state || !state.pid) {
    console.log("HUB_STOPPED already idle");
    return;
  }
  try {
    process.kill(state.pid);
  } catch {
    // already gone
  }
  console.log("HUB_STOPPED");
}

async function sendOnce(options, args) {
  const hub = await connectHub({
    url: wsUrl(options),
    token: options.token,
    room: options.room,
    role: String(args.role || "agent"),
    tool: String(args.tool || "cli"),
    name: String(args.nameSender || args.sender || "cli")
  });
  let payload = {};
  if (args.payload) {
    payload = JSON.parse(String(args.payload));
  }
  const type = String(args.type || "event");
  const name = String(args.name || "ping");
  if (type === "action") {
    const ack = await hub.sendAction(name, payload, { timeoutMs: Number(args.timeoutMs || 5000) });
    console.log("HUB_ACK");
    console.log(JSON.stringify(ack, null, 2));
  } else {
    hub.sendEvent(name, payload);
    console.log("HUB_SENT");
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  hub.close();
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
    const body = await httpHealth(options);
    console.log("HUB_HEALTH_OK");
    console.log(JSON.stringify(body, null, 2));
    return;
  }
  if (command === "send") {
    await sendOnce(options, args);
    return;
  }
  if (command === "stop") {
    stopHub();
  }
}

main().catch((error) => {
  console.error(String(error && error.stack ? error.stack : error));
  process.exit(1);
});
