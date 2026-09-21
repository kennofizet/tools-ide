const { WebSocket } = require("ws");
const { decodeRaw, encode, makeMessage, randomId } = require("./protocol");

function waitOpen(ws, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("websocket connect timeout")), timeoutMs);
    ws.once("open", () => {
      clearTimeout(timer);
      resolve();
    });
    ws.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

async function connectHub(options = {}) {
  const url = String(options.url || "ws://127.0.0.1:8787/hub");
  const token = String(options.token || "");
  const role = String(options.role || "client");
  const tool = String(options.tool || "");
  const name = String(options.name || tool || "client");
  const room = String(options.room || "tools");
  const connectTimeoutMs = Number(options.connectTimeoutMs || 5000);
  const listeners = new Map();
  const pending = new Map();

  const ws = new WebSocket(url);

  function emit(type, message) {
    const list = listeners.get(type) || [];
    list.forEach((fn) => fn(message));
    const all = listeners.get("*") || [];
    all.forEach((fn) => fn(message));
  }

  function on(type, fn) {
    const key = type || "*";
    if (!listeners.has(key)) listeners.set(key, []);
    listeners.get(key).push(fn);
    return () => {
      listeners.set(
        key,
        (listeners.get(key) || []).filter((item) => item !== fn)
      );
    };
  }

  function send(partial) {
    const msg = makeMessage({
      ...partial,
      room: partial.room || room,
      from: partial.from || { role, tool, name }
    });
    ws.send(encode(msg));
    return msg;
  }

  function sendEvent(eventName, payload, extra = {}) {
    return send({ type: "event", name: eventName, payload, ...extra });
  }

  function sendAction(actionName, payload, extra = {}) {
    const timeoutMs = Number(extra.timeoutMs || 5000);
    const msg = send({ type: "action", name: actionName, payload, ...extra });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(msg.id);
        reject(new Error(`action ack timeout for ${actionName}`));
      }, timeoutMs);
      pending.set(msg.id, { resolve, reject, timer });
    });
  }

  function ack(replyTo, extra = {}) {
    return send({
      type: extra.ok === false ? "error" : "ack",
      name: extra.name || "ack",
      replyTo,
      payload: extra.payload || {}
    });
  }

  function close() {
    try {
      ws.close();
    } catch {
      // ignore
    }
  }

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = decodeRaw(raw);
    } catch {
      return;
    }
    if ((msg.type === "ack" || msg.type === "error") && msg.replyTo && pending.has(msg.replyTo)) {
      const waiter = pending.get(msg.replyTo);
      pending.delete(msg.replyTo);
      clearTimeout(waiter.timer);
      if (msg.type === "error") waiter.reject(new Error((msg.payload && msg.payload.message) || "action error"));
      else waiter.resolve(msg);
    }
    emit(msg.type, msg);
    if (msg.name) emit(msg.name, msg);
  });

  await waitOpen(ws, connectTimeoutMs);
  const helloId = randomId("hello");
  const welcome = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("hub hello timeout")), connectTimeoutMs);
    const off = on("welcome", (msg) => {
      if (msg.replyTo && msg.replyTo !== helloId) return;
      clearTimeout(timer);
      off();
      offErr();
      resolve(msg);
    });
    const offErr = on("error", (msg) => {
      clearTimeout(timer);
      off();
      offErr();
      reject(new Error((msg.payload && msg.payload.message) || "hub hello failed"));
    });
    ws.send(
      encode(
        makeMessage({
          id: helloId,
          type: "hello",
          room,
          from: { role, tool, name },
          payload: { token, role, tool, name }
        })
      )
    );
  });

  return {
    ws,
    url,
    room,
    role,
    tool,
    name,
    clientId: welcome.payload && welcome.payload.clientId,
    welcome,
    on,
    send,
    sendEvent,
    sendAction,
    ack,
    close
  };
}

module.exports = {
  connectHub
};
