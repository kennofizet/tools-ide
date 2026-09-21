# Socket Server Tool

Realtime hub for every tool under `cursor/tool`. Agents, running tools, and UI clients join a room and exchange JSON events/actions over WebSocket.

This is a local bus. It does not guess product hostnames and does not embed app-specific action names.

## Folder

`tools-ide/cursor/tool/socket-server`

## Setup

```bash
cd cursor/tool/socket-server
npm install
```

Copy `config.example.json` to `config.json` for local defaults. `config.json` is gitignored.

## Start

```bash
node server.js start
node server.js start --port 8787 --bind 127.0.0.1
node server.js start --detach true
node server.js health
node server.js stop
```

Printed lines:

- `HUB_URL=ws://127.0.0.1:8787/hub`
- `HUB_HEALTH=http://127.0.0.1:8787/health`
- `HUB_ROOM=tools`

Default bind is loopback. If you bind a public/LAN address, pass `--token`.

## Message shape

```json
{
  "v": 1,
  "id": "msg-...",
  "type": "event",
  "name": "run.started",
  "room": "tools",
  "from": { "role": "agent", "tool": "cli", "name": "agent-1" },
  "payload": { "runTag": "example-1" }
}
```

Types: `hello`, `welcome`, `join`, `leave`, `event`, `action`, `ack`, `error`, `ping`, `pong`, `presence`.

Roles:

| Role | Who |
|---|---|
| `agent` | CLI / Cursor agent sending commands |
| `tool` | A running tool instance that performs work |
| `client` | Overlay, dashboard, or other listener |

`event` is fire-and-forget to everyone else in the room. `action` is delivered to `role=tool` connections in the room (optionally `payload.to` = tool name) and expects `ack`.

## Connect from another tool

```js
const { connectHub } = require("../socket-server/lib/client");

const hub = await connectHub({
  url: "ws://127.0.0.1:8787/hub",
  token: process.env.TOOLS_HUB_TOKEN || "",
  role: "tool",
  tool: "browser-emulator",
  room: "tools"
});

hub.on("action", async (msg) => {
  if (msg.name !== "reload") return;
  // do work
  hub.ack(msg.id, { name: "reload", payload: { ok: true } });
});

hub.sendEvent("run.started", { runTag: "example-1" });
hub.sendEvent("ide.task", {
  title: "Waiting for review",
  content: "Other-device overlay is WAIT.",
  stream: "hold until …",
  phase: "wait",
  runTag: "example-1"
});
```

`ide.task` is rendered by sibling `cursor/tool/ide-working` (`:8788`). That viewer’s `/health` is 503 until this hub is online. Overlay `live.state` (WAIT / IN PROGRESS) does **not** drive the viewer chip — only `ide.task.phase` does (`work` / `wait` / `done`).

## CLI send

```bash
node server.js send --name run.started --payload "{\"runTag\":\"example-1\"}"
node server.js send --type action --name reload --payload "{\"to\":\"browser-emulator\"}"
```

## Tests

```bash
npm test
```

## Security

- Default: `127.0.0.1` only.
- Shared token via `--token`, `config.json`, or `TOOLS_HUB_TOKEN`.
- Do not commit tokens. Keep them in gitignored `config.json` or the environment.
- Do not bind `0.0.0.0` without a token.
