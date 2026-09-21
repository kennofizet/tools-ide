const VALID_COMMANDS = new Set(["start", "health", "stop", "help"]);

function printHelp() {
  console.log(`
IDE Working CLI

Realtime viewer for the current IDE/tool task. Shows title, content, and a
live stream. Requires the sibling socket-server hub to be online.

Usage:
  node server.js <command> [--flags]

Commands:
  start     Start the viewer (foreground, or --detach true)
  health    GET /health (200 only when the socket hub is online)
  stop      Stop a detached viewer
  help      Show this help

Flags:
  --config <path>          Config file (default: config.json)
  --port <number>          Listen port (default: 8788)
  --bind <host>            Bind address (default: 127.0.0.1)
  --hubUrl <http://...>    Socket hub HTTP origin (default: http://127.0.0.1:8787)
  --hubPath <path>         Hub websocket path (default: /hub)
  --hubToken <secret>      Shared hub token
  --room <name>            Hub room (default: tools)
  --detach true            Start in background and write output/last-ide-working.json

Examples:
  node server.js start
  node server.js start --port 8788 --bind 127.0.0.1 --hubUrl http://127.0.0.1:8787
  node server.js health
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
