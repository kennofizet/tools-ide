const VALID_COMMANDS = new Set(["run", "dom", "action", "help"]);
const VALID_PRESETS = new Set(["quick", "balanced", "secure"]);

function printHelp() {
  console.log(`
Browser Emulator CLI

Usage:
  node emulator.js <command> [--flags]

Commands:
  run      Run full actions array from config
  dom      Capture DOM only
  action   Run one action via CLI flags
  help     Show this help

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
  --type <click|fill|press|waitForSelector|waitForTimeout|goto|holdForUserAnswer>
  --selector <css|text=...>
  --value <text>
  --key <Enter|Tab|...>
  --actionUrl <https://...>       Used by type=goto
  --ms <number>                   Used by type=waitForTimeout
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

Examples:
  node emulator.js dom --config config.json --url "https://example.com"
  node emulator.js action --config config.json --type waitForSelector --selector body
  node emulator.js run --config config.json --preset secure
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

