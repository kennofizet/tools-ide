const http = require("http");
const { WebSocketServer, WebSocket } = require("ws");
const {
  PROTOCOL_VERSION,
  decodeRaw,
  encode,
  makeMessage,
  errorMessage,
  normalizeRole,
  isLoopbackHost,
  randomId
} = require("./protocol");

function send(ws, message) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  ws.send(encode(message));
  return true;
}

function publicClient(client) {
  return {
    id: client.id,
    role: client.role,
    tool: client.tool,
    name: client.name,
    rooms: [...client.rooms]
  };
}

function createHub(options = {}) {
  const bind = String(options.bind || "127.0.0.1");
  const port = options.port == null || options.port === "" ? 8787 : Number(options.port);
  const path = String(options.path || "/hub");
  const token = String(options.token || "");
  const defaultRoom = String(options.room || "tools");
  const clients = new Map();

  if (!isLoopbackHost(bind) && !token) {
    throw new Error("A --token is required when --bind is not loopback.");
  }

  const httpServer = http.createServer((req, res) => {
    const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
    if (url.pathname === "/health" || url.pathname === "/") {
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(
        JSON.stringify({
          ok: true,
          protocol: PROTOCOL_VERSION,
          path,
          room: defaultRoom,
          bind,
          port,
          clients: clients.size,
          rooms: roomCounts()
        })
      );
      return;
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, message: "not found" }));
  });

  const wss = new WebSocketServer({
    server: httpServer,
    path
  });

  function roomCounts() {
    const counts = {};
    clients.forEach((client) => {
      client.rooms.forEach((room) => {
        counts[room] = (counts[room] || 0) + 1;
      });
    });
    return counts;
  }

  function clientsInRoom(room) {
    const name = String(room || defaultRoom);
    const out = [];
    clients.forEach((client) => {
      if (client.rooms.has(name)) out.push(client);
    });
    return out;
  }

  function broadcast(room, message, exceptId) {
    const payload = encode(message);
    clientsInRoom(room).forEach((client) => {
      if (exceptId && client.id === exceptId) return;
      if (client.ws.readyState === WebSocket.OPEN) client.ws.send(payload);
    });
  }

  function matchingActionTargets(room, message) {
    const targetTool = String(
      (message.payload && (message.payload.to || message.payload.tool || message.payload.targetTool)) || ""
    );
    return clientsInRoom(room).filter((client) => {
      if (client.role !== "tool") return false;
      if (!targetTool) return true;
      return client.tool === targetTool;
    });
  }

  function joinRoom(client, room) {
    const name = String(room || defaultRoom).trim() || defaultRoom;
    if (client.rooms.has(name)) return name;
    client.rooms.add(name);
    broadcast(
      name,
      makeMessage({
        type: "presence",
        name: "join",
        room: name,
        payload: publicClient(client)
      }),
      client.id
    );
    return name;
  }

  function leaveAll(client) {
    client.rooms.forEach((room) => {
      broadcast(
        room,
        makeMessage({
          type: "presence",
          name: "leave",
          room,
          payload: publicClient(client)
        }),
        client.id
      );
    });
    client.rooms.clear();
  }

  function helloTimeout(ws) {
    return setTimeout(() => {
      const client = [...clients.values()].find((item) => item.ws === ws);
      if (client && !client.authed) {
        send(ws, errorMessage("hello required"));
        ws.close(4001, "hello required");
      }
    }, 5000);
  }

  wss.on("connection", (ws, req) => {
    const client = {
      id: randomId("cli"),
      ws,
      authed: false,
      role: "",
      tool: "",
      name: "",
      rooms: new Set(),
      helloTimer: helloTimeout(ws)
    };
    clients.set(client.id, client);

    ws.on("message", (raw) => {
      let msg;
      try {
        msg = decodeRaw(raw);
      } catch (error) {
        send(ws, errorMessage(error.message));
        return;
      }

      if (!client.authed) {
        if (msg.type !== "hello") {
          send(ws, errorMessage("send hello first", { replyTo: msg.id }));
          return;
        }
        const offered = String((msg.payload && msg.payload.token) || "");
        if (token && offered !== token) {
          send(ws, errorMessage("unauthorized", { replyTo: msg.id, name: "unauthorized" }));
          ws.close(4003, "unauthorized");
          return;
        }
        client.authed = true;
        client.role = normalizeRole(msg.from && msg.from.role) || normalizeRole(msg.payload.role) || "client";
        client.tool = String((msg.from && msg.from.tool) || msg.payload.tool || "");
        client.name = String((msg.from && msg.from.name) || msg.payload.name || client.tool || client.id);
        clearTimeout(client.helloTimer);
        const room = joinRoom(client, msg.room || defaultRoom);
        send(
          ws,
          makeMessage({
            type: "welcome",
            room,
            replyTo: msg.id,
            payload: {
              clientId: client.id,
              room,
              protocol: PROTOCOL_VERSION,
              you: publicClient(client),
              peers: clientsInRoom(room)
                .filter((item) => item.id !== client.id)
                .map(publicClient)
            }
          })
        );
        return;
      }

      if (msg.type === "ping") {
        send(ws, makeMessage({ type: "pong", replyTo: msg.id, room: msg.room }));
        return;
      }

      if (msg.type === "join") {
        const room = joinRoom(client, msg.room || (msg.payload && msg.payload.room) || defaultRoom);
        send(ws, makeMessage({ type: "ack", name: "join", replyTo: msg.id, room, payload: { room } }));
        return;
      }

      if (msg.type === "leave") {
        const room = String(msg.room || (msg.payload && msg.payload.room) || "");
        if (room && client.rooms.has(room)) {
          broadcast(
            room,
            makeMessage({
              type: "presence",
              name: "leave",
              room,
              payload: publicClient(client)
            }),
            client.id
          );
          client.rooms.delete(room);
        }
        send(ws, makeMessage({ type: "ack", name: "leave", replyTo: msg.id, payload: { room } }));
        return;
      }

      if (msg.type === "event" || msg.type === "action") {
        const room = String(msg.room || [...client.rooms][0] || defaultRoom);
        if (!client.rooms.has(room)) joinRoom(client, room);
        const outbound = makeMessage({
          ...msg,
          room,
          from: {
            role: client.role,
            tool: client.tool,
            name: client.name
          }
        });
        outbound.id = msg.id;
        if (msg.type === "action") {
          const targets = matchingActionTargets(room, outbound).filter((target) => target.id !== client.id);
          if (!targets.length) {
            send(ws, errorMessage("no matching tool in room", { replyTo: msg.id, name: "no-target" }));
            return;
          }
          const payload = encode(outbound);
          targets.forEach((target) => {
            if (target.ws.readyState === WebSocket.OPEN) target.ws.send(payload);
          });
          return;
        }
        broadcast(room, outbound, client.id);
        return;
      }

      if (msg.type === "ack" || msg.type === "error") {
        const room = String(msg.room || [...client.rooms][0] || defaultRoom);
        const outbound = makeMessage({
          ...msg,
          room,
          from: {
            role: client.role,
            tool: client.tool,
            name: client.name
          }
        });
        outbound.id = msg.id;
        if (msg.replyTo) outbound.replyTo = msg.replyTo;
        broadcast(room, outbound, client.id);
        return;
      }

      send(ws, errorMessage(`unsupported type ${msg.type}`, { replyTo: msg.id }));
    });

    ws.on("close", () => {
      clearTimeout(client.helloTimer);
      leaveAll(client);
      clients.delete(client.id);
    });

    ws.on("error", () => {
      try {
        ws.close();
      } catch {
        // ignore
      }
    });
  });

  function listen() {
    return new Promise((resolve, reject) => {
      httpServer.listen(port, bind, () => resolve(httpServer.address()));
      httpServer.on("error", reject);
    });
  }

  function close() {
    return new Promise((resolve) => {
      clients.forEach((client) => {
        try {
          client.ws.close(1001, "hub stopping");
        } catch {
          // ignore
        }
      });
      wss.close(() => {
        httpServer.close(() => resolve());
      });
    });
  }

  return {
    bind,
    port,
    path,
    token,
    defaultRoom,
    httpServer,
    listen,
    close,
    clients,
    roomCounts
  };
}

module.exports = {
  createHub
};
