# IDE Working Tool

Realtime viewer for whatever the IDE / a Cursor tool is doing right now. It shows **title**, **content**, and a **stream** on its own HTTP port.

This tool does not guess product hostnames. It only works when the sibling **socket-server** hub is online.

## Folder

`tools-ide/cursor/tool/ide-working`

## Setup

```bash
cd cursor/tool/ide-working
npm install
```

Copy `config.example.json` to `config.json` for local defaults. `config.json` is gitignored.

The viewer reads the hub from:

1. `--hubUrl` / `config.json`
2. sibling `cursor/tool/socket-server/output/last-hub.json`
3. `http://127.0.0.1:8787`

## Start

Start the hub first:

```bash
cd cursor/tool/socket-server
node server.js start
```

Then the viewer:

```bash
cd cursor/tool/ide-working
node server.js start
node server.js start --port 8788 --bind 127.0.0.1 --hubUrl http://127.0.0.1:8787
node server.js start --detach true
node server.js health
node server.js stop
```

Printed lines:

- `IDE_WORKING_URL=http://127.0.0.1:8788/`
- `IDE_WORKING_HEALTH=http://127.0.0.1:8788/health`
- `IDE_WORKING_HUB=http://127.0.0.1:8787`

Open the URL in a browser. Default bind is loopback. Health and `/api/state` return **503** until the hub `/health` is ok.

## What it shows

| Field | Source |
|---|---|
| Title / content / stream | Hub event `ide.task` |
| WAIT / IN PROGRESS | Hub event `ide.task.phase` (`wait` / `work`). Overlay `live.state` must not flip this chip. |
| Running tool | `from.tool` / payload `tool` |

Payload example:

```json
{
  "title": "Waiting for review",
  "content": "Other-device overlay is WAIT.",
  "stream": "hold until 2026-01-01T00:00:00.000Z",
  "append": false,
  "phase": "wait",
  "tool": "browser-emulator",
  "runTag": "example-1"
}
```

`append: true` appends `stream` instead of replacing it.

## Browser-emulator

Hands-free uses this tool automatically when the hub is up (`IDE_WORKING_ON`). Overlay stays WAIT / IN PROGRESS only. Task detail belongs here, not in the phone overlay.

## Endpoints

| Path | When hub is down | When hub is up |
|---|---|---|
| `GET /` | HTML offline screen | HTML viewer |
| `GET /health` | 503 | 200 `{ ok: true, hub: true }` |
| `GET /api/state` | 503 | 200 snapshot |
| `WS /live` | 503 | snapshot push |

## Tests

```bash
npm test
```
