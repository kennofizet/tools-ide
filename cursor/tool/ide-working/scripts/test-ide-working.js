const http = require("http");
const { createHub } = require("../../socket-server/lib/hub");
const { connectHub } = require("../../socket-server/lib/client");
const { createViewer } = require("../lib/viewer");

function getJson(port, pathname) {
  return new Promise((resolve, reject) => {
    http
      .get({ hostname: "127.0.0.1", port, path: pathname, timeout: 2000 }, (res) => {
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
      })
      .on("error", reject);
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

(async () => {
  const offline = createViewer({ bind: "127.0.0.1", port: 0, hubUrl: "http://127.0.0.1:1" });
  const offlineAddr = await offline.listen();
  const offlineHealth = await getJson(offlineAddr.port, "/health");
  if (offlineHealth.status !== 503 || offlineHealth.body.ok !== false) {
    throw new Error(`offline health should be 503 ${JSON.stringify(offlineHealth)}`);
  }
  const offlineState = await getJson(offlineAddr.port, "/api/state");
  if (offlineState.status !== 503) throw new Error("offline /api/state should be 503");
  await offline.close();

  const hub = createHub({ bind: "127.0.0.1", port: 0, room: "tools", token: "" });
  const hubAddr = await hub.listen();
  const hubHttp = `http://127.0.0.1:${hubAddr.port}`;
  const viewer = createViewer({
    bind: "127.0.0.1",
    port: 0,
    hubUrl: hubHttp,
    hubPath: "/hub",
    room: "tools"
  });
  const addr = await viewer.listen();
  let health = await getJson(addr.port, "/health");
  for (let i = 0; i < 10 && !(health.status === 200 && health.body.ok); i += 1) {
    await sleep(200);
    health = await getJson(addr.port, "/health");
  }
  if (health.status !== 200 || health.body.ok !== true) {
    throw new Error(`viewer health should be 200 when hub is up ${JSON.stringify(health)}`);
  }

  const agent = await connectHub({
    url: `ws://127.0.0.1:${hubAddr.port}/hub`,
    role: "agent",
    tool: "browser-emulator",
    name: "test-agent",
    room: "tools"
  });
  agent.sendEvent("ide.task", {
    title: "Navigate",
    content: "Open /login then the dashboard.",
    stream: "goto /login",
    phase: "wait",
    runTag: "example-1"
  });
  let state = await getJson(addr.port, "/api/state");
  for (let i = 0; i < 15 && !(state.body.task && state.body.task.title === "Navigate"); i += 1) {
    await sleep(100);
    state = await getJson(addr.port, "/api/state");
  }
  if (!state.body.task || state.body.task.title !== "Navigate") {
    throw new Error(`ide.task not rendered ${JSON.stringify(state.body)}`);
  }
  if (!String(state.body.task.stream || "").includes("goto /login")) {
    throw new Error("stream missing");
  }

  agent.sendEvent("live.state", { state: "progress", runTag: "example-1" });
  state = await getJson(addr.port, "/api/state");
  for (let i = 0; i < 15 && state.body.live.state !== "progress"; i += 1) {
    await sleep(100);
    state = await getJson(addr.port, "/api/state");
  }
  if (state.body.live.state !== "progress") throw new Error("live.state not applied");
  if (state.body.task.phase !== "wait") throw new Error("live.state must not override ide.task phase");

  agent.sendEvent("ide.task", {
    title: "Thinking",
    content: "Review accepted. Agent is continuing.",
    kind: "thinking",
    phase: "work",
    runTag: "example-1"
  });
  state = await getJson(addr.port, "/api/state");
  for (let i = 0; i < 15 && state.body.task.phase !== "work"; i += 1) {
    await sleep(100);
    state = await getJson(addr.port, "/api/state");
  }
  if (state.body.task.phase !== "work") throw new Error("thinking task should set work");
  agent.sendEvent("live.state", { state: "listening", runTag: "example-1" });
  await sleep(150);
  state = await getJson(addr.port, "/api/state");
  if (state.body.task.phase !== "work") throw new Error("overlay listening must not flip ide-working to wait");

  agent.sendEvent("ide.task", {
    title: "Review accepted",
    content: "WAIT until the next check.",
    phase: "done",
    runTag: "example-1"
  });
  state = await getJson(addr.port, "/api/state");
  for (let i = 0; i < 15 && state.body.task.phase !== "work"; i += 1) {
    await sleep(100);
    state = await getJson(addr.port, "/api/state");
  }
  if (state.body.task.phase !== "work") throw new Error("stale accept-wait copy must become work");
  if (!/Agent is continuing/i.test(state.body.task.content || "")) {
    throw new Error("stale accept-wait copy was not rewritten");
  }

  agent.close();
  await viewer.close();
  await hub.close();
  console.log("IDE_WORKING_OK");
})().catch((error) => {
  console.error(String(error && error.stack ? error.stack : error));
  process.exit(1);
});
