const fs = require("fs");
const http = require("http");
const path = require("path");
const { spawn } = require("child_process");

const DEFAULT_HUB_HTTP = "http://127.0.0.1:8787";
const DEFAULT_IDE_WORKING_HTTP = "http://127.0.0.1:8788";
const LIVE_PATH = "/__emu/live";
const TOOL_NAME = "browser-emulator";

function parseBoolean(value, fallback = false) {
  if (value === true || value === false) return value;
  if (value == null || value === "") return fallback;
  const text = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(text)) return true;
  if (["0", "false", "no", "off"].includes(text)) return false;
  return fallback;
}

function loadConnectHub() {
  try {
    return require("../../socket-server/lib/client").connectHub;
  } catch {
    return null;
  }
}

function loadWs() {
  try {
    return require("ws");
  } catch {
    try {
      return require("../../socket-server/node_modules/ws");
    } catch {
      return null;
    }
  }
}

function readSiblingHubState() {
  const file = path.join(__dirname, "..", "..", "socket-server", "output", "last-hub.json");
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function httpToWs(httpUrl, wsPath) {
  const url = new URL(httpUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = wsPath || "/hub";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function resolveHubOptions({ args = {}, config = {} } = {}) {
  if (parseBoolean(args.noHub, false) || parseBoolean(config.hubEnabled, true) === false) {
    return { enabled: false, ok: false };
  }
  const sibling = readSiblingHubState();
  const httpUrl = String(args.hubUrl || config.hubUrl || config.handsFreeHubUrl || (sibling && `http://127.0.0.1:${sibling.port}`) || DEFAULT_HUB_HTTP).replace(
    /\/$/,
    ""
  );
  let parsed;
  try {
    parsed = new URL(httpUrl);
  } catch {
    return { enabled: false, ok: false };
  }
  const token = String(args.hubToken || config.hubToken || config.handsFreeHubToken || process.env.TOOLS_HUB_TOKEN || "");
  const room = String(args.hubRoom || config.hubRoom || config.handsFreeHubRoom || (sibling && sibling.room) || "tools");
  const wsPath = String(args.hubPath || config.hubPath || (sibling && sibling.path) || "/hub");
  return {
    enabled: true,
    ok: false,
    httpUrl,
    healthUrl: `${parsed.origin}/health`,
    wsUrl: httpToWs(httpUrl, wsPath),
    token,
    room,
    host: parsed.hostname,
    port: Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80))
  };
}

function checkHubHealth(hubOptions, timeoutMs = 1500) {
  return new Promise((resolve) => {
    if (!hubOptions || !hubOptions.enabled) {
      resolve({ ...hubOptions, ok: false });
      return;
    }
    let url;
    try {
      url = new URL(hubOptions.healthUrl);
    } catch {
      resolve({ ...hubOptions, ok: false });
      return;
    }
    const req = http.get(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === "https:" ? 443 : 80),
        path: url.pathname || "/health",
        timeout: timeoutMs
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
            resolve({ ...hubOptions, ok: res.statusCode === 200 && body.ok === true, health: body });
          } catch {
            resolve({ ...hubOptions, ok: false });
          }
        });
      }
    );
    req.on("error", () => resolve({ ...hubOptions, ok: false }));
    req.on("timeout", () => {
      req.destroy();
      resolve({ ...hubOptions, ok: false });
    });
  });
}

async function publishLive(hubOptions, { name, payload, role = "agent" }) {
  const connectHub = loadConnectHub();
  if (!connectHub || !hubOptions || !hubOptions.ok) return false;
  const hub = await connectHub({
    url: hubOptions.wsUrl,
    token: hubOptions.token,
    role,
    tool: TOOL_NAME,
    name: "live-publisher",
    room: hubOptions.room,
    connectTimeoutMs: 2500
  });
  try {
    hub.sendEvent(name, payload || {});
    await new Promise((resolve) => setTimeout(resolve, 40));
    return true;
  } finally {
    hub.close();
  }
}

function taskPayload(task = {}) {
  return {
    title: String(task.title || ""),
    content: String(task.content || ""),
    stream: String(task.stream || ""),
    append: task.append !== false,
    file: String(task.file || ""),
    kind: String(task.kind || ""),
    phase: String(task.phase || "work"),
    tool: String(task.tool || TOOL_NAME),
    runTag: String(task.runTag || ""),
    at: new Date().toISOString()
  };
}

async function publishTask(hubOptions, task = {}) {
  return publishLive(hubOptions, {
    name: "ide.task",
    payload: taskPayload(task)
  });
}

function holdIdeTask({ decision, waiting, runTag } = {}) {
  const accepted = String(decision || "") === "accept";
  return taskPayload({
    title: "Thinking",
    content: accepted
      ? "Review accepted. Agent started."
      : "Feedback received. Agent started.",
    stream: `hold decision=${decision || ""} waiting=${waiting ? "1" : "0"} autoStart=${waiting ? "0" : "1"}`,
    kind: "thinking",
    phase: "work",
    runTag: runTag || ""
  });
}

async function publishHoldReceived({ channel, hubOptions, payload = {}, nextState, waiting, runTag, live } = {}) {
  const task = holdIdeTask({ decision: payload.decision, waiting, runTag });
  const holdMsg = {
    decision: payload.decision,
    runTag: runTag || "",
    state: nextState,
    ideStarted: true,
    waiting: Boolean(waiting),
    autoStart: !waiting
  };
  if (channel && typeof channel.sendEvent === "function") {
    const sentTask = channel.sendEvent("ide.task", task);
    channel.sendEvent("hold.submitted", holdMsg);
    if (live) channel.sendEvent("live.state", live);
    if (sentTask) return true;
  }
  if (!hubOptions || !hubOptions.ok) return false;
  const sent = await publishLive(hubOptions, { name: "ide.task", payload: task });
  await publishLive(hubOptions, { name: "hold.submitted", payload: holdMsg });
  if (live) await publishLive(hubOptions, { name: "live.state", payload: live });
  return Boolean(sent);
}

function ideWorkingRoot() {
  return path.join(__dirname, "..", "..", "ide-working");
}

function checkIdeWorkingHealth(timeoutMs = 1200) {
  return new Promise((resolve) => {
    const req = http.get(
      {
        hostname: "127.0.0.1",
        port: 8788,
        path: "/health",
        timeout: timeoutMs
      },
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
          resolve({
            ok: res.statusCode === 200 && body.ok === true,
            status: res.statusCode,
            httpUrl: DEFAULT_IDE_WORKING_HTTP,
            ...body
          });
        });
      }
    );
    req.on("error", () => resolve({ ok: false, httpUrl: DEFAULT_IDE_WORKING_HTTP }));
    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false, httpUrl: DEFAULT_IDE_WORKING_HTTP });
    });
  });
}

async function ensureIdeWorking(hubOptions) {
  if (!hubOptions || !hubOptions.ok) {
    console.log("IDE_WORKING_SKIP hub offline");
    return { ok: false, reason: "hub-offline" };
  }
  let health = await checkIdeWorkingHealth();
  if (health.ok) {
    console.log(`IDE_WORKING_ON ${health.httpUrl || DEFAULT_IDE_WORKING_HTTP}`);
    return health;
  }
  const serverJs = path.join(ideWorkingRoot(), "server.js");
  if (!fs.existsSync(serverJs)) {
    console.log("IDE_WORKING_OFF missing sibling tool");
    return { ok: false, reason: "missing" };
  }
  const pass = ["start", "--detach", "true"];
  if (hubOptions.httpUrl) pass.push("--hubUrl", String(hubOptions.httpUrl));
  if (hubOptions.token) pass.push("--hubToken", String(hubOptions.token));
  if (hubOptions.room) pass.push("--room", String(hubOptions.room));
  const child = spawn(process.execPath, [serverJs, ...pass], {
    cwd: ideWorkingRoot(),
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 400));
    health = await checkIdeWorkingHealth();
    if (health.ok) {
      console.log(`IDE_WORKING_ON ${DEFAULT_IDE_WORKING_HTTP}`);
      return health;
    }
  }
  console.log("IDE_WORKING_OFF");
  return { ok: false, reason: "timeout" };
}

function overlayPreamble(enabled, overlayRev = "") {
  return `window.__EMU_LIVE__=${JSON.stringify({
    enabled: Boolean(enabled),
    path: LIVE_PATH,
    overlayRev: overlayRev ? String(overlayRev) : ""
  })};\n`;
}

function attachLiveChannel(httpServer, { hubOptions, files, setStatus, bumpVersion, runDir, getOverlayRev }) {
  const wsMod = loadWs();
  const connectHub = loadConnectHub();
  if (!wsMod || !hubOptions || !hubOptions.ok) {
    return { enabled: false, handleUpgrade: null, connect: async () => false, close() {} };
  }
  const { WebSocketServer, WebSocket } = wsMod;
  const wss = new WebSocketServer({ noServer: true });
  const overlays = new Set();
  let hubClient = null;

  function push(message) {
    const raw = JSON.stringify(message);
    overlays.forEach((ws) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(raw);
    });
  }

  function applyLivePayload(payload = {}) {
    const nextState = String(payload.state || "") === "progress" ? "progress" : "listening";
    if (runDir && typeof setStatus === "function") setStatus(runDir, nextState);
    if (runDir && typeof bumpVersion === "function" && payload.reload !== false) bumpVersion(runDir);
    return { v: payload.v || String(Date.now()), state: nextState, runTag: payload.runTag || "" };
  }

  function currentLiveState() {
    if (files && files.status && fs.existsSync(files.status)) {
      const raw = fs.readFileSync(files.status, "utf8").trim();
      return raw === "progress" ? "progress" : "listening";
    }
    return "listening";
  }

  function overlayRevNow() {
    if (typeof getOverlayRev !== "function") return "";
    try {
      return String(getOverlayRev() || "");
    } catch {
      return "";
    }
  }

  function handleUpgrade(req, socket, head) {
    wss.handleUpgrade(req, socket, head, (ws) => {
      overlays.add(ws);
      ws.on("close", () => overlays.delete(ws));
      ws.send(
        JSON.stringify({
          type: "event",
          name: "live.state",
          payload: {
            state: currentLiveState(),
            hub: true,
            liveUpdate: true,
            overlayRev: overlayRevNow()
          }
        })
      );
    });
  }

  function sendEvent(name, payload) {
    if (!hubClient) return false;
    try {
      hubClient.sendEvent(name, payload || {});
      if (name === "live.reload" || name === "live.state" || name === "hold.submitted") {
        push({ type: "event", name, payload: payload || {} });
      }
      return true;
    } catch {
      return false;
    }
  }

  async function connect() {
    if (!connectHub) return false;
    hubClient = await connectHub({
      url: hubOptions.wsUrl,
      token: hubOptions.token,
      role: "tool",
      tool: TOOL_NAME,
      name: "hands-free",
      room: hubOptions.room,
      connectTimeoutMs: 2500
    });
    hubClient.on("event", (msg) => {
      if (msg.name !== "live.reload" && msg.name !== "live.state" && msg.name !== "hold.submitted") return;
      push(msg);
    });
    hubClient.on("action", (msg) => {
      if (msg.name !== "reload" && msg.name !== "live.reload") return;
      const applied = applyLivePayload(msg.payload || {});
      push({
        type: "event",
        name: msg.payload && msg.payload.reload === false ? "live.state" : "live.reload",
        payload: applied
      });
      hubClient.ack(msg.id, { name: "reload", payload: { ok: true, ...applied } });
    });
    return true;
  }

  return {
    enabled: true,
    handleUpgrade,
    connect,
    push,
    sendEvent,
    close() {
      overlays.forEach((ws) => {
        try {
          ws.close();
        } catch {
          // ignore
        }
      });
      overlays.clear();
      if (hubClient) hubClient.close();
    }
  };
}

module.exports = {
  LIVE_PATH,
  TOOL_NAME,
  DEFAULT_IDE_WORKING_HTTP,
  resolveHubOptions,
  checkHubHealth,
  publishLive,
  publishTask,
  taskPayload,
  holdIdeTask,
  publishHoldReceived,
  checkIdeWorkingHealth,
  ensureIdeWorking,
  overlayPreamble,
  attachLiveChannel
};
