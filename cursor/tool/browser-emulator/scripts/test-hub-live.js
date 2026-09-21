const http = require("http");
const os = require("os");
const path = require("path");
const fs = require("fs");
const { WebSocket } = require("ws");
const { createHub } = require("../../socket-server/lib/hub");
const { connectHub } = require("../../socket-server/lib/client");
const { createHandsFreeProxy } = require("../lib/phone-review/proxy-server");
const { attachLiveChannel, overlayPreamble, checkHubHealth, resolveHubOptions, publishHoldReceived, holdIdeTask } = require("../lib/hub-live");
const { writeTextFile } = require("../lib/io");

function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function postJson(port, pathname, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: pathname,
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers }
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          try {
            resolve({
              status: res.statusCode,
              body: JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")
            });
          } catch (error) {
            reject(error);
          }
        });
      }
    );
    req.on("error", reject);
    req.end(JSON.stringify(body));
  });
}

function originOf(server) {
  return `http://127.0.0.1:${server.address().port}`;
}

(async () => {
  const hub = createHub({ bind: "127.0.0.1", port: 0, room: "tools", token: "" });
  const hubAddr = await hub.listen();
  const hubHttp = `http://127.0.0.1:${hubAddr.port}`;
  const app = await listen((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<html><body>ok</body></html>");
  });
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), "emu-hub-live-"));
  const files = {
    holdAnswer: path.join(runDir, "hold-answer.json"),
    version: path.join(runDir, "phone-version.txt"),
    status: path.join(runDir, "phone-status.txt"),
    screenshot: path.join(runDir, "hold-composite.jpg"),
    annotation: path.join(runDir, "hold-annotation.png"),
    waiting: path.join(runDir, "phone-waiting.txt")
  };
  fs.writeFileSync(files.status, "listening");
  fs.writeFileSync(files.version, "1");

  const hubOptions = await checkHubHealth(
    resolveHubOptions({ args: { hubUrl: hubHttp, hubRoom: "tools" }, config: {} })
  );
  if (!hubOptions.ok) throw new Error("hub health should be ok");

  const liveRef = { channel: null };
  const holdToken = "test-hold-token";
  const proxy = createHandsFreeProxy({
    origin: originOf(app),
    hostHeader: "127.0.0.1",
    stripScripts: [],
    overlayJs: `${overlayPreamble(true)}console.log('overlay')`,
    files,
    viteOrigin: originOf(app),
    extraOrigins: [],
    extraHosts: [],
    saveDataUrl: () => false,
    writeTextFile,
    liveEnabled: true,
    holdToken,
    onHold: (payload) => {
      const waiting = Boolean(files.waiting && fs.existsSync(files.waiting));
      publishHoldReceived({
        channel: liveRef.channel,
        hubOptions,
        payload,
        nextState: "listening",
        waiting,
        runTag: "example-1",
        live: { state: "listening", runTag: "example-1", liveUpdate: true, reload: false }
      }).catch(() => {});
    },
    handleLiveUpgrade: (req, socket, head) => {
      if (liveRef.channel && liveRef.channel.handleUpgrade) liveRef.channel.handleUpgrade(req, socket, head);
      else socket.destroy();
    }
  });
  liveRef.channel = attachLiveChannel(proxy, { hubOptions });
  await new Promise((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  const joined = await liveRef.channel.connect();
  if (!joined) throw new Error("tool did not join hub");

  const overlayUrl = `ws://127.0.0.1:${proxy.address().port}/__emu/live`;
  const overlay = new WebSocket(overlayUrl);
  const gotState = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("overlay did not get live.state")), 4000);
    overlay.on("message", (raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.name === "live.state" && msg.payload && msg.payload.state === "progress") {
        clearTimeout(timer);
        resolve(msg);
      }
    });
  });
  await new Promise((resolve, reject) => {
    overlay.once("open", resolve);
    overlay.once("error", reject);
  });

  const agent = await connectHub({
    url: `ws://127.0.0.1:${hubAddr.port}/hub`,
    role: "agent",
    tool: "cli",
    room: "tools"
  });
  agent.sendEvent("live.state", { v: "2", state: "progress", runTag: "example-1", liveUpdate: true, reload: false });
  const msg = await gotState;
  if (!msg.payload || msg.payload.runTag !== "example-1") throw new Error("payload missing");
  if (msg.name === "live.reload") throw new Error("hub live must not send live.reload for state updates");

  const startedWithoutWait = holdIdeTask({ decision: "accept", waiting: false, runTag: "example-1" });
  if (startedWithoutWait.phase !== "work" || !/Agent started/i.test(startedWithoutWait.content)) {
    throw new Error("hold without wait must auto-start the agent");
  }

  const viewer = await connectHub({
    url: `ws://127.0.0.1:${hubAddr.port}/hub`,
    role: "client",
    tool: "ide-working",
    name: "viewer",
    room: "tools"
  });
  const gotIdeStart = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("hold without wait did not publish ide.task")), 4000);
    viewer.on("event", (msg) => {
      if (msg.name !== "ide.task") return;
      const content = String((msg.payload && msg.payload.content) || "");
      if (msg.payload && msg.payload.phase === "work" && /Agent started/i.test(content)) {
        clearTimeout(timer);
        resolve(msg);
      }
    });
  });
  const denied = await postJson(proxy.address().port, "/__emu/hold", { decision: "accept", noteText: "nope" });
  if (denied.status !== 401 || denied.body.ok) throw new Error("hold without token must be rejected");
  const holdRes = await postJson(
    proxy.address().port,
    "/__emu/hold",
    { decision: "accept", noteText: "ok", holdToken },
    { "x-emu-hold-token": holdToken }
  );
  if (!holdRes.body.ideStarted) throw new Error("hold without wait must set ideStarted");
  await gotIdeStart;

  agent.close();
  viewer.close();
  overlay.close();
  liveRef.channel.close();
  proxy.close();
  app.close();
  await hub.close();
  console.log("HUB_LIVE_OK");
})().catch((error) => {
  console.error(String(error && error.stack ? error.stack : error));
  process.exit(1);
});
