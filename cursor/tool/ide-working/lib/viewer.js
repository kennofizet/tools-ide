const fs = require("fs");
const http = require("http");
const path = require("path");

const TOOL_NAME = "ide-working";
const DEFAULT_PORT = 8788;
const MAX_STREAM_LINES = 400;

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

function httpToWs(httpUrl, wsPath) {
  const url = new URL(httpUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = wsPath || "/hub";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

function createViewer(options = {}) {
  const connectHub = loadConnectHub();
  const wsMod = loadWs();
  if (!connectHub || !wsMod) {
    throw new Error("ide-working needs sibling cursor/tool/socket-server (and ws).");
  }
  const { WebSocketServer, WebSocket } = wsMod;
  const bind = String(options.bind || "127.0.0.1");
  const port = options.port == null || options.port === "" ? DEFAULT_PORT : Number(options.port);
  const hubHttp = String(options.hubUrl || "http://127.0.0.1:8787").replace(/\/$/, "");
  const hubPath = String(options.hubPath || "/hub");
  const hubToken = String(options.hubToken || "");
  const room = String(options.room || "tools");
  const publicDir = String(options.publicDir || path.join(__dirname, "..", "public"));
  const indexPath = path.join(publicDir, "index.html");

  const state = {
    hub: false,
    hubError: "socket server offline",
    live: { state: "idle", runTag: "" },
    task: {
      title: "",
      content: "",
      phase: "idle",
      tool: "",
      name: "",
      runTag: "",
      file: "",
      kind: "",
      at: ""
    },
    stream: [],
    events: []
  };

  const viewers = new Set();
  let hubClient = null;
  let closed = false;
  let reconnectTimer = null;

  function sanitizeTask(next = {}) {
    const title = String(next.title || "");
    const content = String(next.content || "");
    if (/wait until the next check/i.test(content) || (title === "Review accepted" && String(next.phase || "") === "done")) {
      return {
        ...next,
        title: "Thinking",
        content: "Review accepted. Agent is continuing.",
        kind: "thinking",
        phase: "work"
      };
    }
    return next;
  }

  function snapshot() {
    const task = sanitizeTask(state.task);
    return {
      ok: state.hub,
      hub: state.hub,
      hubError: state.hubError,
      live: { ...state.live },
      task: { ...task, stream: state.stream.join("\n") },
      stream: state.stream.slice(),
      events: state.events.slice(-80).map((item) => sanitizeTask(item))
    };
  }

  function pushViewers() {
    const raw = JSON.stringify({ type: "event", name: "ide.snapshot", payload: snapshot() });
    viewers.forEach((ws) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(raw);
    });
  }

  function appendStream(line) {
    const text = String(line || "").replace(/\r/g, "");
    if (!text) return;
    text.split("\n").forEach((part) => {
      if (!part) return;
      state.stream.push(part);
    });
    if (state.stream.length > MAX_STREAM_LINES) {
      state.stream = state.stream.slice(-MAX_STREAM_LINES);
    }
  }

  function applyTask(payload = {}, from = {}) {
    const next = sanitizeTask(payload || {});
    if (next.title != null) state.task.title = String(next.title);
    if (next.content != null) state.task.content = String(next.content);
    if (next.phase) state.task.phase = String(next.phase);
    if (next.file != null) state.task.file = String(next.file);
    if (next.kind != null) state.task.kind = String(next.kind);
    state.task.tool = String(next.tool || from.tool || state.task.tool || "");
    state.task.name = String(from.name || next.name || state.task.name || "");
    if (next.runTag != null) state.task.runTag = String(next.runTag);
    state.task.at = String(next.at || new Date().toISOString());
    const kind = String(next.kind || inferKind(next) || "log");
    state.events.push({
      kind,
      title: String(next.title || kind),
      content: String(next.content || next.file || ""),
      at: state.task.at
    });
    if (state.events.length > 80) state.events = state.events.slice(-80);
    if (next.append === false) {
      state.stream = [];
      appendStream(next.stream);
    } else if (next.stream != null) {
      appendStream(next.stream);
    }
  }

  function inferKind(next) {
    if (next && next.kind) return String(next.kind);
    const title = String((next && next.title) || "").toLowerCase();
    if (title.includes("think")) return "thinking";
    if (title.includes("command") || title.includes("running")) return "command";
    if (title.includes("edit") || title.includes("writing") || next.file) return "edit";
    if (/\bwait(ing)?\b/.test(title)) return "wait";
    return "log";
  }

  function applyLive(payload = {}) {
    const raw = String(payload.state || state.live.state || "idle");
    const nextState = raw === "progress" ? "progress" : raw === "listening" ? "listening" : raw;
    state.live = {
      state: nextState,
      runTag: String(payload.runTag || state.live.runTag || "")
    };
  }

  function scheduleReconnect() {
    if (closed || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, 2000);
  }

  async function connect() {
    if (closed) return;
    try {
      hubClient = await connectHub({
        url: httpToWs(hubHttp, hubPath),
        token: hubToken,
        role: "client",
        tool: TOOL_NAME,
        name: "viewer",
        room,
        connectTimeoutMs: 2500
      });
      state.hub = true;
      state.hubError = "";
      hubClient.on("event", (msg) => {
        if (msg.name === "ide.task") applyTask(msg.payload || {}, msg.from || {});
        else if (msg.name === "live.state") applyLive(msg.payload || {});
        else if (msg.name === "hold.submitted") appendStream(`hold.submitted ${JSON.stringify(msg.payload || {})}`);
        else return;
        pushViewers();
      });
      if (hubClient.ws) {
        hubClient.ws.on("close", () => {
          state.hub = false;
          state.hubError = "socket server disconnected";
          pushViewers();
          scheduleReconnect();
        });
      }
      pushViewers();
    } catch (error) {
      state.hub = false;
      state.hubError = String(error && error.message ? error.message : error) || "socket server offline";
      pushViewers();
      scheduleReconnect();
    }
  }

  const httpServer = http.createServer((req, res) => {
    const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
    if (url.pathname === "/health") {
      const body = {
        ok: state.hub,
        hub: state.hub,
        tool: TOOL_NAME,
        port,
        bind,
        room,
        hubUrl: hubHttp,
        error: state.hub ? "" : state.hubError || "socket server offline"
      };
      res.writeHead(state.hub ? 200 : 503, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify(body));
      return;
    }
    if (url.pathname === "/api/state") {
      if (!state.hub) {
        res.writeHead(503, { "Content-Type": "application/json", "Cache-Control": "no-store" });
        res.end(JSON.stringify({ ok: false, hub: false, error: state.hubError || "socket server offline" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify(snapshot()));
      return;
    }
    if (url.pathname === "/" || url.pathname === "/index.html") {
      let html = "";
      try {
        html = fs.readFileSync(indexPath, "utf8");
      } catch {
        html = "<!DOCTYPE html><title>IDE Working</title><p>index.html missing</p>";
      }
      res.writeHead(200, {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store, no-cache, must-revalidate",
        Pragma: "no-cache",
        Expires: "0"
      });
      res.end(html);
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, message: "not found" }));
  });

  const wss = new WebSocketServer({ noServer: true });
  httpServer.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
    if (url.pathname !== "/live") {
      socket.destroy();
      return;
    }
    if (!state.hub) {
      socket.write("HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      viewers.add(ws);
      ws.on("close", () => viewers.delete(ws));
      ws.send(JSON.stringify({ type: "event", name: "ide.snapshot", payload: snapshot() }));
    });
  });

  async function listen() {
    await new Promise((resolve, reject) => {
      httpServer.once("error", reject);
      httpServer.listen(port, bind, () => {
        httpServer.removeListener("error", reject);
        resolve();
      });
    });
    await connect();
    return httpServer.address();
  }

  async function close() {
    closed = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
    if (hubClient) {
      try {
        hubClient.close();
      } catch {
        // ignore
      }
    }
    viewers.forEach((ws) => {
      try {
        ws.close();
      } catch {
        // ignore
      }
    });
    viewers.clear();
    await new Promise((resolve) => httpServer.close(() => resolve()));
  }

  return { listen, close, snapshot, state, httpServer };
}

module.exports = {
  TOOL_NAME,
  DEFAULT_PORT,
  createViewer
};
