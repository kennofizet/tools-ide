const VALID_COMMANDS = new Set([
  "run",
  "dom",
  "action",
  "help",
  "review-mode",
  "hands-free",
  "hands-free-reload",
  "hands-free-stop",
  "hands-free-watch",
  "phone-review",
  "phone-reload",
  "phone-stop"
]);
const VALID_PRESETS = new Set(["quick", "balanced", "secure"]);

function printHelp() {
  console.log(`
Browser Emulator CLI

Usage:
  node emulator.js <command> [--flags]

Commands:
  run                 Run full actions array from config
  dom                 Capture DOM only
  action              Run one action via CLI flags
  review-mode         Ask/save desktop vs hands-free (remembered locally)
  hands-free          Other-device review: Docker tunnel + on-device form, then wait
  hands-free-reload   Publish live WAIT / IN PROGRESS (no full refresh when hub is on)
  hands-free-watch    Print HANDS_FREE_HOLD_WAKE when feedback arrives without a wait
  hands-free-stop     Stop the hands-free tunnel and proxy
  help                Show this help

Common flags:
  --config <path>                 Config file path (default: config.json)
  --caseFile <path>               Load actions from case file (for run)
  --url <https://...>             Target URL (or domain in CDP mode)
  --browser <edge|chrome>         Browser preference (default: edge)
  --background true               Run background-friendly behavior for any mode
  --preset <quick|balanced|secure>
  --quiet true                    Reduce terminal output (logs still saved)
  --runTag <tag>
  --timeout <ms>
  --useCdp true                   Attach to Edge CDP endpoint (default true)
  --cdpAutoStart true             Auto-start browser when CDP is unavailable
  --cdpLaunchDetached true        Start Edge in background (set false for foreground)
  --cdpStartupRetries <number>    Retry count when CDP startup is slow (default 2)
  --cdpRetryLaunchDetached true   Retry launches Edge in background mode
  --cdpBrowserPath <path>         Browser executable for CDP auto-start
  --cdpUserDataDir <path>         Profile directory for CDP auto-start
  --cdpAutoAttach true            Try attaching to user browser first (default true)
  --forceLocalLaunch true         Skip CDP auto-attach and launch local browser
  --cdpEndpoint http://127.0.0.1:9223
  --attachMatchUrl <partial-url>  Match open tab URL/domain (auto-domain when omitted)
  --liveMode true                 Keep live-state defaults for iterative testing
  --forceStepCapture true         Capture DOM/screenshot for every step in case runs
  --reviewBeforeNextStep true     Enforce step review gate before continuing
  --reviewPauseMs <ms>            Pause after review gate before next step
  --resetCaseProgress true        Restart case from step 1

Action mode flags:
  --type <click|fill|press|waitForSelector|waitForTimeout|goto|evaluate|setViewport|holdForUserAnswer|hold>
  --selector <css|text=...>
  --value <text>
  --key <Enter|Tab|...>
  --actionUrl <https://...>       Used by type=goto
  --script <js>                   Used by type=evaluate (runs in the open tab)
  --ms <number>                   Used by type=waitForTimeout
  --width <px>                    Used by type=setViewport
  --height <px>                   Used by type=setViewport
  --expectSelector <css|text=...> Require selector visible after action
  --expectUrlIncludes <text>      Require current URL to contain text after action
  --expectDomChange true          Require DOM content to change after action
  --prompt <text>                 Used by type=holdForUserAnswer
  --toolbarTitle <text>           Used by type=holdForUserAnswer
  --submitLabel <text>            Used by type=holdForUserAnswer
  --acceptLabel <text>            Used by type=holdForUserAnswer
  --placeholder <text>            Used by type=holdForUserAnswer
  --requireNote true              Used by type=holdForUserAnswer (reject empty note)
  --holdTimeoutMs <number>        Used by type=holdForUserAnswer (min: 60000 ms, default: 600000 ms)
  --fullScreenEdit <true|false>   Used by type=holdForUserAnswer (default: true)
  --drawScope <full|zone>         Used by type=holdForUserAnswer (default: full when enabled)
  --instruction <text>            Alias of --prompt for holdForUserAnswer
  --saveCaseNoteTo <path>         Save step note into case-notes JSON
  --caseKey <name>                Scenario key (example: open-project)
  --caseNote <text>               Optional human note for current step

Phone / hands-free flags:
  --reviewMode <desktop|local-open|hands-free>  Save and use this review device (remembered)
  --mode <desktop|local-open|hands-free>        Used by review-mode
  --origin <http://127.0.0.1>        Local app origin the tunnel proxies to
  --hostHeader <host>                Host header for local vhosts (example: app.example.test)
  --viteOrigin <http://127.0.0.1:5173>  Vite (or other) dev server to keep off loopback
  --extraOrigin <https://...>        Extra origin to proxy at /__emu/x/N (comma list)
  --backendOrigin <https://...>      Alias of the first extra origin
  --extraHost <host>                 Optional Host header for extra origins (comma list)
  --dockerHost host.docker.internal
  --stripScript <file.js>            Remove an app script before injecting hold.js
  --startOnly true                   Start tunnel only, do not wait for submit
  --state <listening|progress>       Used by hands-free-reload (live state only when hub is on)
  --answer <text>                    Show this text in Box 1 on the other device when WAIT
  --holdToken <secret>               Session token required for POST /__emu/hold (auto-generated)
  --localOpen true                   Local feedback mode: proxy on 127.0.0.1, no Docker tunnel
  --insecureUpstream true            Allow bad/self-signed TLS to --extraOrigin (default: false)
  --hubUrl <http://127.0.0.1:8787>   Socket hub HTTP origin (used when /health is ok)
  --hubToken <secret>                Shared hub token
  --hubRoom <name>                   Hub room (default: tools)
  --noHub true                       Do not use the socket hub

Live tools:
  Socket hub (cursor/tool/socket-server) on :8787. When /health is ok, hands-free
  publishes live.state and ide.task. The sibling IDE working viewer on :8788
  renders title / content / stream. Overlay stays WAIT / IN PROGRESS only.

Security:
  HANDS_FREE_OPEN includes ?emu_hold=<token>. Treat that URL as a capability link
  (it can submit hold feedback and wake the agent). Do not paste the bare tunnel
  host into public chats. Upstream HTTPS verifies certificates unless
  --insecureUpstream true.

Review modes:
  desktop      CDP hold on this computer
  local-open   Same hold overlay via local proxy (no Cloudflare / Docker tunnel)
  hands-free   Other-device tunnel review

Examples:
  node emulator.js dom --config config.json --url "https://example.com"
  node emulator.js action --config config.json --type waitForSelector --selector body
  node emulator.js run --config config.json --preset secure
  node emulator.js review-mode --mode local-open
  node emulator.js hands-free --localOpen true --config config.json --origin http://127.0.0.1 --hostHeader app.example.test --holdTimeoutMs 600000 --runTag local-open-1
  node emulator.js review-mode --mode hands-free
  node emulator.js hands-free --config config.json --origin http://127.0.0.1 --hostHeader app.example.test --holdTimeoutMs 600000 --runTag hands-free-1
  node emulator.js hands-free-reload --config config.json --state listening
  node emulator.js hands-free-stop --config config.json
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
  VALID_PRESETS,
  printHelp,
  parseArgs
};

