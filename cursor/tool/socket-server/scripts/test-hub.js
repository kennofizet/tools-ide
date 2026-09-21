const http = require("http");
const { createHub } = require("../lib/hub");
const { connectHub } = require("../lib/client");

function getHealth(port) {
  return new Promise((resolve, reject) => {
    http
      .get({ hostname: "127.0.0.1", port, path: "/health", timeout: 2000 }, (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            status: res.statusCode,
            body: JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")
          });
        });
      })
      .on("error", reject);
  });
}

(async () => {
  const hub = createHub({ bind: "127.0.0.1", port: 0, room: "tools", token: "secret-token" });
  const address = await hub.listen();
  const port = address.port;
  const url = `ws://127.0.0.1:${port}/hub`;

  try {
    const health = await getHealth(port);
    if (health.status !== 200 || health.body.ok !== true) throw new Error("health failed");
    if (health.body.protocol !== 1) throw new Error("protocol mismatch");

    const agent = await connectHub({
      url,
      token: "secret-token",
      role: "agent",
      tool: "cli",
      name: "test-agent",
      room: "tools"
    });
    const tool = await connectHub({
      url,
      token: "secret-token",
      role: "tool",
      tool: "example-tool",
      name: "example-1",
      room: "tools"
    });

    const sawEvent = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("event not received")), 2000);
      tool.on("event", (msg) => {
        if (msg.name !== "run.started") return;
        clearTimeout(timer);
        resolve(msg);
      });
    });
    agent.sendEvent("run.started", { runTag: "example-1" });
    const eventMsg = await sawEvent;
    if (eventMsg.payload.runTag !== "example-1") throw new Error("event payload");
    if (eventMsg.from.role !== "agent") throw new Error("event from role");

    tool.on("action", (msg) => {
      if (msg.name !== "reload") return;
      tool.ack(msg.id, { name: "reload", payload: { ok: true, runTag: "example-1" } });
    });
    const ack = await agent.sendAction("reload", { to: "example-tool" }, { timeoutMs: 2000 });
    if (!ack.payload || ack.payload.ok !== true) throw new Error("action ack");

    let rejected = false;
    try {
      await connectHub({ url, token: "wrong", role: "client", room: "tools", connectTimeoutMs: 1500 });
    } catch {
      rejected = true;
    }
    if (!rejected) throw new Error("bad token should fail");

    const isolated = await connectHub({
      url,
      token: "secret-token",
      role: "client",
      tool: "other-client",
      room: "other-room"
    });
    const leaked = new Promise((resolve, reject) => {
      const timer = setTimeout(() => resolve(false), 300);
      isolated.on("event", (msg) => {
        if (msg.name === "run.started") {
          clearTimeout(timer);
          reject(new Error("event leaked across rooms"));
        }
      });
    });
    agent.sendEvent("run.started", { runTag: "should-not-leak" });
    await leaked;

    agent.close();
    tool.close();
    isolated.close();
    console.log("HUB_TEST_OK");
  } finally {
    await hub.close();
  }
})().catch((error) => {
  console.error(String(error && error.stack ? error.stack : error));
  process.exit(1);
});
