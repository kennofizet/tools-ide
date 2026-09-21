const VALID_COMMANDS = new Set(["start", "health", "send", "stop", "help"]);

function printHelp() {
  console.log(`
Socket Server CLI

Realtime hub for Cursor tools. Tools, agents, and clients join a room and
exchange JSON events/actions over WebSocket.

Usage:
  node server.js <command> [--flags]

Commands:
  start     Start the hub (foreground, or --detach true)
  health    GET /health on a running hub
  send      Connect, publish one event or action, then exit
  stop      Stop a detached hub
  help      Show this help

Flags:
  --config <path>          Config file (default: config.json)
  --port <number>          Listen port (default: 8787)
  --bind <host>            Bind address (default: 127.0.0.1)
  --path <path>            WebSocket path (default: /hub)
  --token <secret>         Shared token (required if bind is not loopback)
  --room <name>            Default room (default: tools)
  --detach true            Start in background and write output/last-hub.json
  --tool <name>            Sender tool name for send (default: cli)
  --role <agent|tool|client>
  --type <event|action>    Message kind for send (default: event)
  --name <string>          Event/action name (example: run.started)
  --payload <json>         JSON object string for send
  --timeoutMs <number>     Wait for action ack (default: 5000)

Examples:
  node server.js start
  node server.js start --port 8787 --bind 127.0.0.1
  node server.js health
  node server.js send --name run.started --payload "{\\"runTag\\":\\"example-1\\"}"
  node server.js send --type action --name reload --tool browser-emulator
  node server.js stop
`);
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }
  return args;
}

module.exports = {
  VALID_COMMANDS,
  printHelp,
  parseArgs
};
