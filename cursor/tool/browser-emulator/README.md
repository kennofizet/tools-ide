# Browser Emulator Tool (Cursor IDE)

This tool gives AI agents a browser emulator for debug/testing workflows:

- Open app URL in Chromium
- Run actions (click/fill/wait/etc.)
- Capture current DOM to file
- Save screenshot after action runs
- Run in detached background mode on Windows
- Reuse previous browser progress (cookies/localStorage/session)
- Keep each test run in a separate output folder (no mixed artifacts)
- Attach to an already-open Edge browser tab via CDP
- Show fixed in-page badge ("Agent in progress") while running
- Security forget mode: clear page data after run
- Domain flow notes: read site map/known selectors before run

Testing defaults for agents:

- Use Edge CDP attach mode by default (`--useCdp true`) for best stability/tab reuse
- Keep command timeout within `1000..8000` ms (recommended `3000`)
- For CDP auto-start, use startup retries (`--cdpStartupRetries 2`) for first-run reliability
- `--background true` is valid in all browser modes (CDP attach and local launch)

## Must Read First

- `TESTING_RULES.md` (required before each test run)

## Review device (ask once, remember)

Before any test or feedback run, the tool needs to know **where the human is reviewing**:

| Choice | Meaning | Hold path |
|---|---|---|
| **desktop** | This computer | Edge CDP `holdForUserAnswer` |
| **hands-free** | Another device (phone, tablet, another PC) | `hands-free` Docker tunnel + on-device form |

The agent must **ask the human** the first time, then save:

```bash
node emulator.js review-mode --mode desktop
node emulator.js review-mode --mode hands-free
```

That writes `output/review-mode.local.json` and later commands reuse it. Pass `--reviewMode desktop|hands-free` on any command to change it.

Hard rule: if they want feedback or testing on **another device**, hands-free is required. CDP hold cannot inject a form there.

## Mandatory Agent Test Loop

Use this loop for every navigation/testing request:

1. Read `domain-cache/<domain>.json` + `flow/domain/<domain>.md` first.
2. Run one small action with unique `--runTag`.
3. Validate artifacts (`agent-state.json`, screenshot, DOM, log).
4. If failed, adjust selector/step and retry with a new `--runTag`.
5. Continue until the target behavior is visible and confirmed in artifacts.
6. Write a short result summary (URL, finalUrl, status, key blocker/fix).

Practical rule:

- Never stop on first failure.
- Do not claim success from CLI text alone; only from artifacts.
- Keep retries incremental (small selector/action changes each loop).
- Retry loop is autonomous: after a failed run, agent should continue retry steps (new `--runTag`) without waiting for extra user prompt.
- Do not stop after one failed run; perform at least 3 focused retries unless PASS is reached earlier.
- During retries, always read failed screenshot image artifacts (not only logs/state JSON) before the next action.
- For every run result (success or fail), read the latest screenshot image artifact before deciding the next step.
- By default this tool is execution-focused: do not auto-edit browser-emulator source/rules/docs during normal test loops.
- Change tool code/docs only when the user explicitly asks for tool maintenance/update work.

## Folder

`tools-ide/cursor/tool/browser-emulator`

## Setup

1. Open terminal in this folder.
2. Install dependencies:

```bash
npm install
npx playwright install chromium
```

3. Create local config:

```bash
copy config.example.json config.json
```

4. Edit `config.json` for your local URL and actions.

## Quick Start (Friendly)

1. Show CLI help:

```bash
npm run help
```

2. Fast smoke test:

```bash
node emulator.js action --config config.json --useCdp true --cdpEndpoint "http://127.0.0.1:9223" --type waitForSelector --selector body --preset quick --timeout 3000
```

3. Security-first test:

```bash
node emulator.js run --config config.json --useCdp true --cdpEndpoint "http://127.0.0.1:9223" --preset secure --timeout 3000
```

3b. Reliable first-start CDP test (retry when Edge opens slowly):

```bash
node emulator.js action --config config.json --useCdp true --cdpEndpoint "http://127.0.0.1:9223" --cdpAutoStart true --cdpLaunchDetached false --cdpStartupRetries 2 --cdpRetryLaunchDetached true --url "https://example.com" --type waitForSelector --selector body --runTag cdp-retry-check-1 --timeout 3000
```

4. Login test script (inside `test/`):

```bash
node emulator.js run --config test/login/config.login.invalid.example.json --runTag login-test
node test/login/report-login-result.js --runTag login-test
```

5. First case test script (safe template, no secrets):

```bash
node emulator.js run --config test/first-case/config.first-case.example.json --runTag first-case-test
```

6. Live iterative mode (keep state between actions):

```bash
node emulator.js action --config config.json --useCdp true --cdpEndpoint "http://127.0.0.1:9223" --liveMode true --url "https://example.com" --type waitForSelector --selector body --runTag live-step-1 --timeout 3000
```

Run next actions with the same browser profile/session behavior, for example:

```bash
node emulator.js action --config config.json --useCdp true --cdpEndpoint "http://127.0.0.1:9223" --liveMode true --type click --selector "a[href*='example']" --runTag live-step-2 --timeout 3000
```

Live mode details:

- uses CDP session reuse so browser state continues across commands
- browser is not force-closed after each step
- does not force navigation to `config.url` unless you explicitly pass `--url` (or case target URL)
- if CDP endpoint is down, tool can auto-start browser when `cdpAutoStart` is enabled (absolute user-data-dir, `--remote-allow-origins=*`, dedicated profile — relative dirs on Windows can miss `:9224`)
- if first CDP auto-start attempt is not ready yet, tool retries launch (`cdpStartupRetries`), and retry can switch to detached mode (`cdpRetryLaunchDetached`)
- per-case runs force step captures by default (`forceStepCapture: true`)

7. Save tested steps into reusable case notes:

```bash
node emulator.js action --config config.json --liveMode true --type fill --selector "input[name='email']" --value "demo" --saveCaseNoteTo "output/case-notes.json" --caseKey "open-project" --caseNote "try login form" --runTag case-step-1
node emulator.js action --config config.json --liveMode true --type click --selector "a:has-text('Projects')" --saveCaseNoteTo "output/case-notes.json" --caseKey "open-project" --caseNote "open projects menu" --runTag case-step-2
```

8. Step-break case run (use only when you already have a case JSON):

```bash
node emulator.js run --config config.json --useCdp true --cdpEndpoint "http://127.0.0.1:9223" --caseFile "test/tmp/my-case.local.json" --runTag case-step-1 --timeout 3000
```

Then review artifacts and continue with next step:

```bash
node emulator.js run --config config.json --useCdp true --cdpEndpoint "http://127.0.0.1:9223" --caseFile "test/tmp/my-case.local.json" --runTag case-step-2 --timeout 3000
```

Restart from first step when needed:

```bash
node emulator.js run --config config.json --useCdp true --cdpEndpoint "http://127.0.0.1:9223" --caseFile "test/tmp/my-case.local.json" --resetCaseProgress true --runTag case-restart --timeout 3000
```

## Attach To Existing Edge Tab (CDP, Recommended)

Default behavior prefers this mode: if a matching domain tab is already open in Edge, emulator attaches to it instead of opening a new tab.

1. Launch Edge with remote debugging enabled (new instance). Use a **dedicated port** when `9223` is already your everyday browser:

```powershell
"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --remote-debugging-port=9224 --user-data-dir="C:\temp\edge-cdp-profile-9224"
```

2. Open your target page in that Edge window and **leave it open**.
3. Run emulator in CDP attach mode (match `--cdpEndpoint` to the port above):

```bash
node emulator.js action --config config.json --useCdp true --liveMode true --cdpEndpoint "http://127.0.0.1:9224" --attachMatchUrl "domain-link/examplse" --cdpNavigate false --cdpAutoOpenIfMissing false --type waitForSelector --selector body --runTag edge-live-check-1 --timeout 3000
```

Notes:
- `--attachMatchUrl` can be full URL or partial string.
- If `--attachMatchUrl` is not provided, emulator auto-uses the target URL domain as attach hint.
- Add `--attachRequireMatch true` to fail fast if wrong tab is selected.
- In CDP + `--liveMode true` (no `--background true`), emulator keeps the browser open and reuses the matching tab.
- After the tab exists: omit `--url` and keep `--cdpNavigate false` so later steps do not reload the page.
- Edge/CDP is enabled by default (`useCdp: true`, `cdpAutoAttach: true`) and falls back to local launch if CDP is unavailable.
- To use Chrome instead of Edge, set `--browser chrome` (or `"browser": "chrome"` in config).
- If `--cdpNavigate true`, emulator will navigate the attached tab to `url`.
- Overlay behavior while running:
  - fixed top-right status card
  - optional click-lock to prevent manual clicking during automation
- If no matching tab is found, emulator can auto-open your target URL in a new tab (`cdpAutoOpenIfMissing: true`). Do not use that flag when you already have the tab open.

### First-Time Friendly Command (Recommended)

Use this when users just provide a domain/link and want it to work:

```bash
node emulator.js dom --config config.json --useCdp true --cdpEndpoint "http://127.0.0.1:9223" --attachMatchUrl "domain-link" --runTag first-time-cdp-1 --timeout 3000
```

Behavior:
- tries to attach matching tab first
- if not found, opens `https://domain-link` automatically
- captures DOM/log using the same run pipeline

## Read This First (Recommended Flow)

1. Read this file before running tests.
2. Keep `keepProgress: true` in `config.json` to reuse old browser progress.
3. Use a stable `sessionName` (example: `example-main`) so next run reuses same profile.
4. Run tests with `npm run run` or `node emulator.js action ...`.
5. After each run, always check:
   - `output/last-run.log`
   - latest screenshot path in `output/last-run.json`
   - latest DOM in `output/dom-latest.html`
6. Domain memory is auto-saved/read from `domain-cache/<domain>.json`.
7. For security-first usage, keep forget mode enabled (default in example config).

This makes it easy to see exactly what happened and prevents output mixups.

## Domain Flow Notes (New)

Before running actions, emulator now tries to read a domain note from:

- `flow/domain/<domain>.md`
- fallback: `flow/domain/default.md`

What it does:

- reads note at run start (before action execution)
- writes a pointer to `output/last-domain-flow.json`
- logs first note lines into `output/runs/<runTag>/emulator.log`
- also reads/writes route memory in `domain-cache/<domain>.json` under `pageSummaries`
- writes current route summary pointer to `output/last-domain-page-summary.json`

Use this to store fast navigation map, stable selectors, and known pitfalls per domain.

## Commands

- Run full flow from `actions` in config:

```bash
npm run run
```

- Capture only DOM:

```bash
npm run dom
```

- Run single action from CLI:

```bash
node emulator.js action --config config.json --useCdp true --cdpEndpoint "http://127.0.0.1:9223" --type click --selector "button[type='submit']" --timeout 3000
```

## Hands-free mode (another device)

Use this when the reviewer is on **another device**. Desktop CDP `holdForUserAnswer` cannot inject a form there.

What it does:

- starts a local HTML proxy that injects a Submit/Accept overlay
- opens a Cloudflare quick tunnel with Docker (`cloudflared`)
- waits for the other device to POST feedback
- writes the same hold artifacts as desktop hold (`hold-answer.json`, screenshot, drawing)

Commands:

```bash
node emulator.js review-mode --mode hands-free
node emulator.js hands-free --config config.json --origin http://127.0.0.1 --hostHeader app.example.test --holdTimeoutMs 600000 --runTag hands-free-1
node emulator.js hands-free-reload --config config.json --state progress
node emulator.js hands-free-reload --config config.json --state listening --answer "Result for Box 1"
node emulator.js hands-free-stop --config config.json
```

Agent workflow:

1. Confirm saved mode is `hands-free`.
2. Run `hands-free` and **block** (`block_until_ms` >= `--holdTimeoutMs`).
3. Open the printed `HANDS_FREE_OPEN` on the other device (includes `?emu_hold=` session token; login, go to the edited page).
4. Watch for `HANDS_FREE_HOLD_RECEIVED` / `HANDS_FREE_HOLD_TIMEOUT`.
5. Read `output/runs/<runTag>/hold-answer.json` plus `hold-composite.jpg` / `hold-annotation.png`.
6. On feedback: badge becomes **IN PROGRESS** as soon as Submit/Accept is sent. Keep `--state progress` while the IDE is working (Vite HMR live-updates the page; no full refresh when the hub is up). When the reviewer should look again, `--state listening` (badge **WAIT**), then `hands-free` wait. Do not start a new wait while you are still editing.
7. `hands-free-stop` when the other-device session is finished.

Notes:

- `--origin` is the local server the proxy forwards to. `--hostHeader` is for name-based vhosts.
- Treat `HANDS_FREE_OPEN` as a **capability URL** (hold submit + agent wake). Do not share the bare tunnel host without the `emu_hold` token. `POST /__emu/hold` returns 401 without it.
- Upstream HTTPS (`--extraOrigin`) verifies TLS certificates by default. Use `--insecureUpstream true` only for local self-signed certs.
- The other device must not load loopback or other local origins. The proxy rewrites those to same-origin paths (`/@vite/...`, `/__emu/x/0`, `/__emu/x/1`) so Chrome Private Network Access does not block the tunnel.
- Vite-style modules (`/@...`, `/src/...`, `/resources/...`, `?import`, root source files) go to the dev server. Public files (`/*.css`, `/sw*.js`, `/js/`, `/build/`) stay on the app server.
- Pass extra API hosts with `--extraOrigin` (comma list) or `--backendOrigin` (first extra origin). Do not guess extra hosts from the app hostname. Same-origin `/api/...` is also forwarded to the first extra origin.
- Extra origins are rewritten to `/__emu/x/0`, `/__emu/x/1`, … . `/__emu/backend` is an alias of the first extra origin.
- Runtime code must not hardcode product hostnames or machine paths. Put those in gitignored `*.local.json` and `flow/domain/<your-domain>.md`.
- If the other device gets `503`, Cloudflare **Error 1033**, or the trycloudflare host does not resolve, the quick tunnel is not ready or dropped. Wait for `HANDS_FREE_TUNNEL_READY`, or restart `hands-free` and open the new `HANDS_FREE_URL`. Do not keep using an old hostname. Health checks fall back to DNS `1.1.1.1` when Node `getaddrinfo` cannot resolve trycloudflare hosts.
- If `cursor/tool/socket-server` is healthy (`GET /health`), hands-free uses it for live updates. Look for `HUB_LIVE_ON`. After a code edit, `hands-free-reload --state progress|listening` prints `HUB_LIVE_SENT` and **does not reload the page**. The socket updates the WAIT / IN PROGRESS badge. App UI updates through Vite HMR. The proxy rewrites `@vite/client` so HMR uses the tunnel host, reconnects on websocket drop instead of `location.reload()`, **rewrites Vite `full-reload` websocket messages into a single-module `js-update`** (payload path, or the last seen `.vue` — never the whole seen graph), and **rewrites compiled `.vue` HMR to always `reload` the component** so static templates update without changing app source (`rewrite-v23+`). Overlay WAIT must not trigger a live patch. Do not edit the product app to make review HMR work. Full navigation happens only when the hub is down (`HUB_LIVE_OFF`). When the hub is up, hands-free also starts sibling `cursor/tool/ide-working` (`IDE_WORKING_ON`, default `http://127.0.0.1:8788/`) and publishes `ide.task`. Overlay stays WAIT / IN PROGRESS; title / content / stream render in that viewer.
- Badge: **WAIT** while an agent wait is active (reviewer should act) and after **Accept**. **IN PROGRESS** when Submit happens during wait, or when Submit/Accept auto-starts the agent because no wait was running. `hands-free-watch` prints `HANDS_FREE_HOLD_WAKE` so the agent session continues.
- The hands-free form can be dragged by the title row and resized from the bottom-right corner. Size/position are remembered on that device.
- Default `--stripScript` is empty. Pass a filename only when the app injects its own overlay that would conflict with the tool form.
- Do not use `--background true` for the wait. The serve process is detached automatically; the wait command must stay in the foreground.
- `phone-review` / `phone-reload` / `phone-stop` remain as aliases.
- Sanity tests (no browser): `npm test` in this folder.

## Hold Mode (User Answer + Draw) — MANDATORY after UI tasks

This is the final step of every UI edit task **when review mode is desktop**. The agent MUST navigate to the edited zone and run `holdForUserAnswer` before declaring done. `--type hold` is a short alias for the same action. If review mode is `hands-free`, use `hands-free` instead — never CDP hold.

What it does:

- scrolls/focuses a "zone" on screen via `--selector`
- overlays a drawing canvas + a small toolbar (Draw starts **OFF** so the page stays clickable)
- toolbar includes **Test first** — hides the form and unlocks the page; a **Resume feedback** dock brings the form back
- toolbar supports explicit draw scope buttons (`Full`, `Zone`) so drawing can stay full-screen when needed
- user draws annotations and types a note, then clicks "Submit to Agent"
- emulator saves:
  - `output/runs/<runTag>/hold-answer.json` (note + metadata + annotation data URL)
  - `output/runs/<runTag>/hold-annotation-*.png` (draw-only image, no page background)
  - `output/runs/<runTag>/hold-composite-*.png` (page + drawing combined)
- emulator also records these paths inside:
  - `output/runs/<runTag>/run-summary.json`
  - `output/runs/<runTag>/agent-state.json`

### Mandatory agent workflow (after any UI edit):

1. Edit code.
2. Navigate browser to the edited zone (open correct page, click correct panel/tab).
3. Confirm edited element is visible (`waitForSelector`).
4. Capture screenshot + DOM and review the result against user intent/reference.
5. If capture is not good: think -> edit again -> navigate -> capture again (repeat until self-check passes).
6. Once self-check passes, reopen/reconfirm the same zone and run `holdForUserAnswer` with a clear `--prompt`.
7. Include `--acceptLabel` so toolbar has explicit accept button.
8. The Shell call MUST use long blocking time (`block_until_ms` high enough for hold window).
9. Hold duration is controlled by `--holdTimeoutMs`, not by generic `--timeout`.
   - Minimum for real UI review: `--holdTimeoutMs 300000` (5 minutes).
   - Recommended: `300000` to `600000`.
   - Do not use short values like `60000` for feedback tasks.
10. After user submits: immediately read `hold-answer.json` + both images (`hold-annotation` + `hold-composite`).
11. If `decision=feedback`: think about feedback, edit code, navigate, capture, self-check, then hold again.
12. Continue loop until `accept` or timeout/hard blocker.

### Hard rules:

- NEVER skip this step for UI tasks.
- NEVER declare done without user submission.
- NEVER run hold on a random page; navigate to the edited zone first.
- NEVER background the hold command (`block_until_ms: 0`). The agent must stay blocked.
- NEVER pause after submission; read, reason, and continue automatically.
- NEVER stop while decision is feedback; only stop on accept/timeout/hard blocker.
- NEVER skip the re-hold after a feedback-driven edit batch.
- NEVER use short hold windows that make normal user feedback impractical.

### Example:

```bash
node emulator.js action --config config.json --useCdp true --cdpEndpoint "http://127.0.0.1:9223" --liveMode true --type holdForUserAnswer --selector ".checklist-vscode-tabs" --prompt "I updated the tab + history panel styling. Please draw what looks wrong or type OK to approve." --toolbarTitle "Style Review" --submitLabel "Submit to Agent" --requireNote true --fullScreenEdit true --drawScope full --holdTimeoutMs 600000 --runTag style-hold-1 --timeout 3000
```

- Run single action on already-open Edge tab (CDP):

```bash
node emulator.js action --config config.json --useCdp true --cdpEndpoint "http://127.0.0.1:9223" --attachMatchUrl "domain-link" --type waitForSelector --selector body --timeout 3000
```

- Reuse existing session explicitly:

```bash
node emulator.js run --config config.json --useCdp true --cdpEndpoint "http://127.0.0.1:9223" --session example-main --keepProgress true --timeout 3000
```

- Run in background (detached process):

```bash
npm run run:bg
```

Background mode writes logs to `output/emulator-bg-*.log`.
You can also append `--background true` to any `run`, `dom`, or `action` command in both Edge/CDP and local-launch modes.

- Run fastest mode (minimal artifacts, no overlay/domain memory):

```bash
npm run run:fast
```

- Run strict security mode (forget all local traces):

```bash
npm run run:secure
```

- Run reusable login test flow from `test/login`:

```bash
node emulator.js run --config test/login/config.login.invalid.example.json --useCdp true --cdpEndpoint "http://127.0.0.1:9223" --runTag login-test --timeout 3000
node test/login/report-login-result.js --runTag login-test
```

Or set preset manually:

```bash
node emulator.js run --config config.json --useCdp true --cdpEndpoint "http://127.0.0.1:9223" --preset quick --timeout 3000
node emulator.js run --config config.json --useCdp true --cdpEndpoint "http://127.0.0.1:9223" --preset balanced --timeout 3000
node emulator.js run --config config.json --useCdp true --cdpEndpoint "http://127.0.0.1:9223" --preset secure --timeout 3000
```

## Agent Timeout Policy

- For agent-generated test commands, keep `--timeout` within `1000..8000` ms.
- Recommended default is `3000` ms.
- When a page is slow, chain smaller waits rather than setting a single timeout above `8000`.

## Supported Action Types

- `click` (requires `selector`)
- `fill` (requires `selector`, optional `value`)
- `press` (requires `key`)
- `waitForSelector` (requires `selector`)
- `waitForTimeout` (optional `ms`)
- `goto` (requires `url`)
- `evaluate` (requires `script`; action result is the script return value as string/JSON, not a fixed "evaluated page script")
- `setViewport` (requires `--width` and `--height` in CSS pixels; use this before checking `@media` layouts)
- `hold` / `holdForUserAnswer`

## Output

- Per-run artifacts:
  - `output/runs/<run-tag>/emulator.log`
  - `output/runs/<run-tag>/network-log.json` (request/response/error timeline)
  - `output/runs/<run-tag>/network-summary.json` (API error summary counts)
  - `output/runs/<run-tag>/dom.html`
  - `output/runs/<run-tag>/screen-<timestamp>.png`
  - `output/runs/<run-tag>/run-summary.json`
  - `output/runs/<run-tag>/case-trace.json`
  - `output/runs/<run-tag>/agent-state.json`
  - on failure: `output/runs/<run-tag>/dom-error.html` and `screen-error-*.png`
- Latest pointers:
  - `output/last-run.json`
  - `output/last-run.log`
  - `output/last-domain-flow.json`
  - `output/last-domain-page-summary.json`
  - `output/dom-latest.html`
  - `output/last-run-summary.json`
  - `output/last-agent-state.json`
- Session storage (for progress reuse):
  - `output/sessions/<session-name>/`
- Domain notes (per-site history + flow memory):
  - `domain-cache/<domain>.json`
- Domain flow notes (manual, human curated):
  - `flow/domain/<domain>.md`
  - `flow/domain/default.md`

## Key Config Fields

- `keepProgress`: `true` to reuse browser profile/session across runs.
- `sessionName`: logical name for persistent progress bucket.
- `sessionDir`: where persistent browser profile is stored.
- `domCheckSelector`: selector that must exist after page load (`body` by default).
- `captureDomPath`: optional custom DOM file path; empty means per-run default.
- `domainCacheDir`: folder for per-domain run history notes.
- `useCdp`: attach to existing Edge via CDP instead of launching local browser.
- `cdpAutoAttach`: try attaching to an already-open user browser first (default true).
- Default matching behavior: prefer an already-open tab on the same domain before opening/navigating a new tab.
- `forceLocalLaunch`: disable CDP auto-attach and always launch local browser.
- `cdpEndpoint`: CDP URL (default `http://127.0.0.1:9223`).
- `cdpAutoStart`: auto-start browser for CDP when endpoint is unavailable.
- `cdpLaunchDetached`: first CDP auto-start launch mode (`true` background, `false` foreground).
- `cdpStartupRetries`: number of CDP startup attempts when endpoint is still unavailable.
- `cdpRetryLaunchDetached`: detached mode used for retry attempts (2nd+ launch).
- `cdpBrowserPath`: optional browser executable path for CDP auto-start.
- `cdpUserDataDir`: profile directory used for CDP auto-start.
- `attachMatchUrl`: optional URL substring to select which open tab to attach.
- `attachRequireMatch`: fail run if no tab matches `attachMatchUrl`.
- `cdpNavigate`: if `true`, navigate attached tab to configured `url`.
- `cdpAutoOpenIfMissing`: if no matched tab exists, auto-open target URL in new tab.
- `agentOverlayEnabled`: show in-page overlay card while emulator runs.
- `agentOverlayText`: overlay message text (`Agent in progress` by default).
- `agentOverlayDisableClicks`: lock manual page clicks while running.
- `agentOverlayLockDuringActions`: temporarily unlock around automation actions.
- `agentOverlayKeepAfterRun`: keep overlay after run (default false).
- `forgetPageAfterRun`: clear localStorage/sessionStorage/cache/service workers/cookies for tested page.
- `forgetDomainCacheAfterRun`: remove `domain-cache/<domain>.json` after run.
- `forgetSessionAfterRun`: remove persistent session profile after local-launch run.
- `forgetArtifactsAfterRun`: remove DOM/screenshot artifacts after run.
- `enableDomainCache`: enable/disable domain memory read/write entirely.
- `maxDomainRuns`: cap number of stored domain run records.
- `captureDomAfterRun`: enable/disable post-run DOM capture for `action`/`run`.
- `captureScreenshotAfterRun`: enable/disable post-run screenshot for `action`/`run`.
- `networkLogEnabled`: capture request/response timeline for each run.
- `networkLogOnlyApi`: focus network log on API/XHR/fetch traffic.
- `networkLogIncludeBodies`: include request/response payload snippets.
- `networkLogMaxEntries`: cap logged network events per run.
- `networkLogBodyMaxChars`: truncate payload snippets to this length.
- `preset`: quick/balanced/secure profile for easier first-time usage.
- `quiet`: reduce terminal noise while still writing run logs.
- `liveMode`: optimized iterative mode for step-by-step testing with persistent state.
- `forceStepCapture`: force capture DOM/screenshot for every step in case runs.
- `reviewBeforeNextStep`: enforce review gate for each step before next action.
- `reviewPauseMs`: configurable pause after review gate.
- Case runs are always step-break mode (pause for review before next step).
- Case step mode is fixed to 1 step per run (single-step review loop).
- `resetCaseProgress`: restart case progression from step 1.
- `caseFile`: for `run`, load action steps from external case JSON.
- `saveCaseNoteTo`: for `action`, save step notes into a case-notes JSON file.
- `caseKey`: scenario key (example: `open-project`, `chat-send-message`).
- `caseNote`: short human note for expected step behavior.

## Iterative Agent Workflow

Use this cycle for reliable scenario note authoring:

1. Think next step.
2. Run one `action`.
3. Save step note with `--saveCaseNoteTo output/case-notes.json --caseKey <scenario-key>`.
4. Add optional expectation note in `--caseNote`.
5. Repeat until flow is complete.

After each run, read `agent-state.json` first to know:

- current error (if any)
- failed step/action selector
- last completed step
- suggested next actions

Per-step artifacts (force-captured in case runs):

- `output/runs/<runTag>/steps/step-<n>-dom.html`
- `output/runs/<runTag>/steps/step-<n>-screen.png`
- `output/runs/<runTag>/steps/step-<n>-review.json`
- on step failure: `step-<n>-error-dom.html` and `step-<n>-error-screen.png`

Step review gate:

- When `reviewBeforeNextStep` is enabled, tool validates review + capture artifacts per step.
- If review/capture is missing, run stops immediately (prevents blind step continuation).
- In case runs, tool always pauses after 1 step and tells agent to read capture/review before next run.

Browser lifecycle:

- Prefer `--liveMode true` for iterative tests so state persists between steps.
- In live mode, browser session stays reusable between commands.
- Close/cleanup only when user explicitly says finish/close.
- In foreground case/live runs, tool keeps browser open for interactive continuation.

## Presets

- `quick`: fastest run, minimal trace capture.
- `balanced`: default tradeoff for normal testing.
- `secure`: keeps security cleanup strict after each run.

## Security Forget Mode

Purpose: avoid leaving sensitive page state behind after agent testing.

When enabled:

- page storage is cleared after run
- domain note can be removed
- session profile can be removed (optional)
- saved artifacts can be removed (optional)

Recommended for public/shared use:

```json
{
  "forgetPageAfterRun": true,
  "forgetDomainCacheAfterRun": true,
  "forgetSessionAfterRun": true,
  "forgetArtifactsAfterRun": true
}
```

## Domain Cache Behavior

Each time you run the emulator:

1. It reads old test notes for the current domain from `domain-cache`.
2. It logs recent previous runs into current run log (status + flow summary).
3. It writes a new note for the current run (success/failed, DOM size, screenshot, errors).

This gives per-domain continuity for structure/flow/warnings over time.

## Notes For Cursor Agent

The AI agent can use this tool while coding/testing to:

- verify a page renders expected elements
- inspect saved DOM for debug
- replay repeatable UI interaction steps
