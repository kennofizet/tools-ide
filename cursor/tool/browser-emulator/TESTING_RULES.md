# Browser Emulator Testing Rules (Read First)

Read this file before every test run.

## 0) Review device (ask once, remember)

Before the first `run` / `action` / `dom` / hold in a workspace:

1. If `output/review-mode.local.json` is missing, **ask the human**:
   - This computer (desktop Edge CDP)
   - Another device (hands-free: Docker tunnel + on-device form)
2. Save it:
   - `node emulator.js review-mode --mode desktop`
   - `node emulator.js review-mode --mode hands-free`
3. Later runs print `REVIEW_MODE_USING` and reuse that file.
4. If they want feedback or testing on **another device**, hands-free is required. Do not use CDP `holdForUserAnswer` for that.
5. To switch later: `review-mode --mode ...` or `--reviewMode ...` on a command.

If the CLI prints `REVIEW_MODE_REQUIRED`, stop and ask. Do not guess.

## 1) Core Rules

- Always reuse session unless you intentionally need a clean state.
- Default browser mode is Edge CDP attach (best/recommended); reuse matching open domain tab before opening new tab.
- `--background true` is supported for all modes (Edge/CDP and local launch).
- For any `node emulator.js ...` command, keep timeout between `1000` and `8000` ms.
- On Windows PowerShell, `--selector` quotes are stripped and the value is split on spaces. Pass **one class token** as the click target (put that class on the element itself). Never `--selector .parent .child`.
- For CDP auto-start reliability, use startup retries (`--cdpStartupRetries 2` or more).
- If first Edge launch is slow/fails, allow retry in detached mode (`--cdpRetryLaunchDetached true`).
- Always check old domain history before new actions.
- Always check domain flow note before new actions (`flow/domain/<domain>.md` or `flow/domain/default.md`).
- Always check page memory summary for current link before new actions (`output/last-domain-page-summary.json` + `domain-cache/<domain>.json`).
- Always keep each run isolated with a unique `runTag`.
- Always review log + screenshot + DOM after each run.
- Always review network artifacts after each run:
  - `output/runs/<runTag>/network-log.json`
  - `output/runs/<runTag>/network-summary.json`
- Always read `agent-state.json` after each run to decide next step.
- Always open/read the latest screenshot image artifact after each run (success or fail) before deciding next action.
- For case runs, always read latest step capture (`steps/step-*-dom.html` + `steps/step-*-screen.png`) before next action.
- For case runs, always read latest `steps/step-*-review.json` and follow `nextSuggestion`.
- Keep `reviewBeforeNextStep` enabled so tool enforces review gate before continuing.
- Case runs always execute only 1 step, then pause for review (fixed behavior).
- Use `resetCaseProgress` when you need to restart from step 1.
- Never trust a run only from CLI output; validate artifacts.
- Default for workspace flows: keep session/cache (do not forget) to avoid unexpected logout.
- Enable forget mode only for explicitly sensitive/privacy-required runs.
- Prefer presets for consistency: `quick`, `balanced`, `secure`.
- Do not auto-generate test scripts under `test/tmp` for ad-hoc runs.
- Use iterative cycle: think -> do one action -> save step note by scenario key -> continue.

## 2) Required Pre-Run Checklist

1. Confirm review mode (`output/review-mode.local.json` or ask + `review-mode --mode`).
2. Confirm target URL and expected page behavior.
3. Confirm domain flow note exists (or use `flow/domain/default.md`) and read it first.
4. Confirm config file exists (`config.json` or `config.example.json` for quick tests).
5. Confirm persistent mode:
   - `--keepProgress true`
   - `--session <stable-name>`
6. Confirm run is traceable:
   - `--runTag <descriptive-tag>`
7. Confirm timeout is realistic for the page and within enforced range:
   - minimum `1000`
   - maximum `8000`
   - recommended default `3000`
8. Confirm session policy:
   - normal workspace test: `--forgetPageAfterRun false`
   - normal workspace test: `--forgetDomainCacheAfterRun false`
   - normal workspace test: `--forgetSessionAfterRun false`
   - keep `--enableDomainCache true` for flow memory
   - switch to strict privacy mode only when user explicitly requests it
9. If testing an already-open Edge tab:
   - Start Edge with `--remote-debugging-port=<port>` that matches `--cdpEndpoint` (default example is `9223`; use a **dedicated other port** such as `9224` when the user's everyday browser already occupies `9223`)
   - Use a dedicated `--user-data-dir` / `cdpUserDataDir` per port so sessions do not collide
   - run with `--useCdp true --liveMode true`
   - NEVER pass `--background true` when the browser must stay open for reuse (background closes interactive keep-open)
   - keep browser preference as Edge unless user explicitly requests Chrome (`--browser edge`)
   - set `--attachMatchUrl` to the domain/path already in that tab
   - use `--attachRequireMatch true` for strict reuse (fail instead of picking the wrong tab)
   - after the tab exists: `--cdpNavigate false`, omit `--url`, and `--cdpAutoOpenIfMissing false` so the current page is not reloaded or duplicated
   - for first-time public runs when no tab exists yet, `--cdpAutoOpenIfMissing true` is OK
   - for startup reliability when the dedicated-port browser is not running, keep `--cdpAutoStart true --cdpStartupRetries 2 --cdpRetryLaunchDetached true`
   - CDP auto-start must use an **absolute** `--user-data-dir` plus `--remote-allow-origins=*`. A relative profile path on Windows can attach to everyday Edge and never open `:9224`.
   - `connectOverCDP` is capped at 25s per attempt (2 attempts). An 8s cap was too short and left a zombie attach that wedged `:9224`. If `/json/version` answers but attach still times out, wait and retry once; do not overlap attaches.
   - If attach stays hung after that, the dedicated Edge CDP session is wedged. Relaunch **only** the `:9224` profile (`output/live-edge-profile-9224`), not everyday Edge. Login lives in that profile. Then attach again with `--cdpNavigate false`.
9. Default attach matching:
   - if `--attachMatchUrl` is empty, tool should match by target URL domain first
   - only open/navigate a new tab when no matching domain tab exists
   - once a matching tab is attached, keep reusing it for later steps in the same session
   - Vuetify `VMenu` closes when the agent overlay remounts between separate `action` commands. Open a menu and click its item in one `run` actions array (same attach). Prefer `.v-list-item:has-text("...")` over `a:has-text("...")`.
10. Keep automation UI lock visible:
   - `--agentOverlayEnabled true`
   - `--agentOverlayText "Agent in progress"`
   - `--agentOverlayDisableClicks true`
   - Never run two `emulator.js` CDP attaches at once on the same port. A leftover session makes overlay `evaluate` hang. Overlay mount/lock/remove is capped at 4s and skipped if it times out (`Agent overlay skipped`).
11. If command should be non-interactive/background:
   - append `--background true` (works on every mode)

## 3) Standard Test Steps (All Pages)

1. **Read old domain memory**
   - file: `domain-cache/<domain>.json`
   - look for:
     - last `status`
     - last `finalUrl`
     - repeated errors/timeouts
     - `pageSummaries` for the same link/path
2. **Read page memory summary**
   - file: `output/last-domain-page-summary.json`
   - look for:
     - same-route flow preview
     - stable selector hints
     - last status + summary note
3. **Read domain flow note**
   - file: `flow/domain/<domain>.md` (fallback `flow/domain/default.md`)
   - look for:
     - route map
     - stable selectors
     - known hidden/duplicate selector pitfalls
4. **Run smoke DOM check**
   - command type: `dom`
   - goal: confirm page loads and DOM is captured
   - for already-open Edge tab, include `--useCdp true`
5. **Run one safe action**
   - command type: `action`
   - example: `waitForSelector body`
   - for phone CSS (`max-width` media queries), first `setViewport --width 390 --height 844` on the CDP tab; desktop window size does not apply those rules
6. **Run scenario actions**
   - command type: `run` (actions array in config) or multiple `action` calls
7. **Validate artifacts**
   - log: `output/runs/<runTag>/emulator.log`
   - network log: `output/runs/<runTag>/network-log.json`
   - network summary: `output/runs/<runTag>/network-summary.json`
   - screenshot: `output/runs/<runTag>/screen-*.png`
   - error screenshot fallback: `output/runs/<runTag>/steps/step-*-error-screen.png`
   - dom: `output/runs/<runTag>/dom.html`
   - error DOM fallback: `output/runs/<runTag>/steps/step-*-error-dom.html` or `output/runs/<runTag>/dom-error.html`
   - trace: `output/runs/<runTag>/case-trace.json`
   - agent state: `output/runs/<runTag>/agent-state.json`
   - step captures: `output/runs/<runTag>/steps/`
   - step reviews: `output/runs/<runTag>/steps/step-*-review.json`
8. **Check latest pointers**
   - `output/last-run.json`
   - `output/last-run.log`
   - `output/dom-latest.html`
   - `output/screen-latest.png`
   - `output/last-domain-page-summary.json`
9. **Check domain note updated**
   - `domain-cache/<domain>.json` should add new run entry
10. **Check page summary updated**
   - `domain-cache/<domain>.json` should update `pageSummaries` for current URL/path
11. **Check domain flow pointer**
   - `output/last-domain-flow.json` should point to the note loaded for this run
12. **Mandatory screenshot review after every run**
   - open/read latest screenshot image artifact (`screen-*.png` or `screen-error-*.png`)
   - in case-step runs, also prioritize `steps/step-*-screen.png` or `steps/step-*-error-screen.png`
   - do this even when run status is success

## 4) Result Validation Rules

- Success means all are true:
  - page reached expected URL (or expected redirect)
  - DOM saved with reasonable size (not near-zero) **if capture enabled**
  - screenshot generated **if capture enabled**
  - log contains action results without timeout/fatal error
- Warning if:
  - redirected to `/login` unexpectedly
  - DOM captured but app body is mostly empty shell
  - overlay not visible while run is in progress
- Failed if:
  - timeout on page load/selector
  - screenshot missing
  - DOM missing

## 4b) Required Retry Loop (Do Not Stop Early)

When a run fails, follow this loop until pass or hard blocker:

1. Read `output/runs/<runTag>/agent-state.json` first.
2. Read latest step review (`steps/step-*-review.json`) and take `nextSuggestion`.
3. Inspect failed screenshot + failed DOM to confirm page state.
   - mandatory: open/read the failed screenshot image artifact itself (for example `screen-error-*.png` or `steps/step-*-error-screen.png`) before choosing the next retry.
4. Apply one focused change only (selector scope, wait strategy, route step, or attach target).
5. Re-run with a new runTag and re-validate artifacts.
6. Continue retries automatically without asking user again, until PASS or HARD BLOCKER.
7. Minimum retry requirement: do at least 3 focused retry attempts after the first failure unless PASS happens earlier.

Selector escalation order:

1. specific stable selector
2. role/text selector
3. parent + child scoped selector
4. explicit open-panel step before target selector

Overlay interception recovery:

- If error says `... intercepts pointer events` (for example `.v-overlay__scrim`), run one focused dismiss action first:
  - click `.v-overlay__scrim` (or panel close button)
  - then retry the original target action with a new `runTag`

Stop conditions:

- PASS: target UI/behavior verified in artifacts
- HARD BLOCKER: auth/permission/environment issue that code/test cannot resolve automatically

Never report success when the target selector was never visible.
Never stop after one failed run when next retry action is available.
Never mark HARD BLOCKER before minimum retries are attempted (unless blocked by explicit permission/auth/environment wall).
Never skip failed image artifact review in retry cycles.
Never skip success image artifact review before planning the next action.

## 4c) Tool-Issue Handling (No Auto Self-Edit)

When failure appears caused by emulator/tool behavior (not app UI logic), do this before normal selector retries:

1. Identify concrete tool issue from artifacts/logs (`agent-state.json`, `run-summary.json`, `emulator.log`).
2. Retry with usage-level adjustments only (selector strategy, attach target, timeout within policy, explicit pre-step navigation).
3. Re-run the same scenario with a new `runTag`.
4. Re-check artifacts and confirm whether issue persists.
5. Continue loop until:
   - PASS: behavior verified in artifacts, or
   - HARD BLOCKER: tool/environment/auth/permission issue outside safe runtime retries.

Hard rule:

- Do not auto-edit browser-emulator source/rules/docs during this loop unless user explicitly requests tool changes.
- Do not stop at first failure; provide blocker evidence with failed run tags/artifacts when escalation is needed.
- Retry loop is mandatory and autonomous: do not wait for an extra user message between retries.

## 4d) Visual Delta Guardrail (UI Styling Tasks)

When user feedback says "nothing changed" or "still same style", enforce a visual delta check:

1. Capture a baseline run (`<feature>-before-*`) and an updated run (`<feature>-after-*`).
2. Compare both screenshots at the exact same UI state (same panel open, same tab active).
3. Verify at least 3 concrete CSS deltas in DOM or computed style (for example: `background`, `border`, `color`, `font-weight`, `padding`).
4. In report, include the concrete deltas; do not only say "looks better".

Hard rule:

- If visual deltas are not explicit in artifacts, continue edit + rerun loop.

## 4e) Mandatory Hold Mode After Every UI Task (Human-in-the-Loop)

After completing ANY UI edit task (styling, layout, component change, visual fix), the agent MUST run `holdForUserAnswer` before declaring the task done. This is NOT optional. `--type hold` is an alias of `holdForUserAnswer` (do not treat it as a different action).

Required workflow:

1. Navigate the browser to the exact edited zone:
   - open the correct page URL
   - click into the right panel/tab/record so the edited UI is visible
   - use `waitForSelector` to confirm the edited element is on screen
2. Run `holdForUserAnswer` with:
   - a stable `runTag` (e.g. `<feature>-hold-review-1`)
   - `--selector` pointing at the edited zone (e.g. `.checklist-history-panel`)
   - `--fullScreenEdit true` so user can draw across the full viewport (zone remains only for navigation/target validation)
   - `--prompt` describing what was changed and asking the user to draw/annotate issues or approve
   - `--acceptLabel` (explicit "confirm done" button in toolbar)
  - `--holdTimeoutMs 300000` to `600000` (minimum 5 minutes for real review)
   - do NOT rely on `--timeout` for hold duration; hold duration is controlled by `--holdTimeoutMs`
3. The Shell/terminal call MUST block (e.g. `block_until_ms: 660000`) so the agent hangs and waits.
   NEVER background this command. The agent must stay blocked until one valid hold end state occurs.
4. Hold end states (only these are valid):
   - explicit toolbar `accept` from user
   - explicit toolbar feedback `submit` from user
   - hold timeout reached (`holdTimeoutMs`)
5. Do not treat generic CLI text (for example "SUCCESS: agent read image then do next step.") as hold completion.
   Hold is complete only after process exit + `hold-answer.json` validation (except true timeout case).
6. Immediately read artifacts after submit:
   - `output/runs/<runTag>/hold-answer.json` (user note text)
   - `output/runs/<runTag>/hold-annotation-*.png` (draw-only image, no page background)
   - `output/runs/<runTag>/hold-composite-*.png` (page + drawing combined)
   - `zoneFound` in hold answer/agent state must be `true`
   - mandatory: open/read BOTH hold images (`hold-annotation` + `hold-composite`) before deciding next action
   - if `strokesCount` > 0, map the drawing to the on-page region in the composite (which card, leftover space vs empty cell) before changing code. Do not treat a circled leftover area as a request to restyle a different empty module.
7. If `zoneFound=false` or hold annotation is blank/unrelated:
   - treat as failed navigation, not user feedback on UI
   - run focused pre-hold navigation actions (open detail row, switch tab/panel, `waitForSelector` target)
   - rerun hold with a new `runTag` until `zoneFound=true`
8. Decide and execute next action automatically based on user answer (do not wait for another prompt):
   - `decision=accept`: report task done
   - `decision=feedback`: fix the issues, then loop back to step 1
9. Keep looping until one stop condition:
   - explicit user accept from toolbar, or
   - hold timeout/hard blocker
10. Feedback-cycle enforcement (mandatory):
   - after each feedback submission, do focused code fixes
   - reopen the same edited zone in browser
   - run hold mode again
   - read both images + answer again
   - repeat until accept/timeout

Hard rules:

- NEVER declare a UI task done without running `holdForUserAnswer`.
- NEVER skip the navigation step (the user must see the edited zone, not a random page).
- NEVER force zone-only drawing unless explicitly required for a specific workflow.
- NEVER guess user satisfaction; always wait for explicit submission.
- NEVER stop hold mode while user is still typing.
- NEVER use accidental short hold durations from generic `--timeout`; set `--holdTimeoutMs` explicitly.
- NEVER use `--holdTimeoutMs` below `300000` (5 minutes) for feedback hold mode.
- Do not clear session/cache during hold mode runs (keep session intact).
- If the hold command itself fails (timeout, selector issue), fix and retry hold - do not skip it.
- NEVER stop after submission analysis; agent must continue the loop automatically.
- NEVER stop while hold decision is feedback.
- NEVER continue editing indefinitely without returning to hold mode.
- NEVER ignore visual-only feedback when `decision=feedback` and note text is empty; analyze drawings from hold images and continue fix/retest loop.

## 4f) Hands-free mode (another device)

When the reviewer is on another device, CDP `holdForUserAnswer` cannot show the form. Hands-free is required.

Required workflow:

1. `node emulator.js review-mode --mode hands-free` (skip if already saved).
2. `node emulator.js hands-free --origin http://127.0.0.1 --hostHeader <vhost> --holdTimeoutMs 600000 --runTag hands-free-1`
3. Shell must block. Watch for `HANDS_FREE_HOLD_RECEIVED` or `HANDS_FREE_HOLD_TIMEOUT`.
4. Tell the user the printed `HANDS_FREE_URL`.
5. After submit, read:
   - `output/runs/<runTag>/hold-answer.json`
   - `output/runs/<runTag>/hold-composite.jpg`
   - `output/runs/<runTag>/hold-annotation.png` (if drawn)
6. Feedback loop:
   - Submit/Accept immediately sets the badge to **IN PROGRESS**. Follow with `hands-free-reload --state progress` while the IDE is working. The hub keeps the page live (Vite HMR); do not full-refresh.
   - When the reviewer should look again: `hands-free-reload --state listening` (badge **WAIT**)
   - `hands-free` wait again. Never start wait while you are still editing.
7. `hands-free-stop` when done with the other-device session.

Hard rules:

- NEVER use desktop CDP hold as a substitute for another-device review.
- NEVER background the `hands-free` wait.
- NEVER leave a hands-free session on `--startOnly`. That only serves the tunnel. Submit/Accept cannot start the agent until `hands-free` wait is blocking. Viewer `:8788` is not the IDE starting.
- After wait ends, start `hands-free-watch` in the background (`HANDS_FREE_HOLD_WAKE`) so Submit without a wait loop still auto-starts the agent. Do not show “Agent is not in listen.” on `:8788`.
- NEVER invent a project-local hold JSON watcher when this command exists.
- If saved mode is `hands-free`, refuse CDP hold and use this path.
- If a notification badge or other product text shows `__emu-origin-map` / `/__emu/hold.js`, the proxy wrapped a non-document `text/html` API body. Capability `rewrite-v23+` injects those scripts only into full HTML documents. Keep-tunnel restart the proxy; do not treat that as an app bug. Pass `--extraOrigin` for API hosts; do not guess names from the app vhost. If the other device gets `503`, Cloudflare **Error 1033**, `ERR_NAME_NOT_RESOLVED`, or Chrome “can’t reach this page”, the trycloudflare host is dead or not in DNS. **Do not keep using that hostname.** `hands-free-stop`, start a new tunnel, wait for `HANDS_FREE_TUNNEL_READY`, and send the new `HANDS_FREE_URL`. Public health checks resolve via `1.1.1.1` when Node `getaddrinfo` fails. `hands-free --startOnly` must wait for `HANDS_FREE_TUNNEL_READY` before treating the URL as usable.
- Navigate testing is **not** a hands-free wait. Use `node emulator.js action --type goto --actionUrl <url>` (then `waitForSelector`) on the dedicated CDP session. `ide-working` (`:8788`) must show title/content/stream for those steps. Do not ask the human to type routes instead of the tool.
- If the socket hub is healthy, `hands-free` prints `HUB_LIVE_ON` and live updates go over the socket. **Do not full-refresh after edits** while the hub is up: `hands-free-reload` only publishes `live.state`. Vite HMR must stay on the tunnel host. The proxy converts Vite `full-reload` into a **single-module** `js-update` (payload path, or the last seen `.vue` — never every seen module) and forces Vue SFC HMR to `reload` (not rerender-only) so static templates live-update without product-source edits (`rewrite-v23+`, keep-tunnel restart). Overlay WAIT must not blast HMR. If the other device still full-refreshes or stays stale after that, restart `hands-free` so the new capability is serving. Badge is **WAIT** while a wait loop is active and after **Accept**. **IN PROGRESS** only if Submit arrives during that wait. Submit/Accept still publishes `ide.task` (Agent started) to ide-working even when no wait loop is listening. `--startOnly` is not listen; the agent must then block on `hands-free` wait or Submit cannot start real work. With the hub socket up, the overlay must not poll `/__emu/version`. Task title / content / stream belong in sibling `cursor/tool/ide-working` (`IDE_WORKING_ON`, `:8788`). On WAIT, the overlay also pins the last `--answer` into Box 1 (a host-page feature slot when present) so the other device can read the result; do not write that copy into the product app. If `HUB_LIVE_OFF`, file poll + refresh is the fallback.
- Share **`HANDS_FREE_OPEN`** (includes `?emu_hold=`), not only the bare tunnel host. That URL is a capability link: it can submit hold feedback and wake the local agent. `POST /__emu/hold` requires the session hold token (query, header, body, or cookie set after opening `HANDS_FREE_OPEN`).
- Upstream HTTPS to `--extraOrigin` verifies certificates by default. Pass `--insecureUpstream true` only for local self-signed certs.
- If the other device console shows module scripts with MIME `text/html`, a Vite path was sent to the app server. Restart `hands-free` so Vite modules go to the dev server and public files stay on the app server.

## 4g) Hold UX Defaults (Public-Friendly)

Use these hold defaults for all UI review runs unless explicitly overridden by user:

- Toolbar is movable by dragging the title row ("Drag toolbar").
- Hands-free review form default is **top-right** (below the WAIT badge), not bottom-left, so it does not cover common page hover targets (for example a mosaic card or floating action). It can still be moved (title row) and resized (bottom-right handle). Drag the form to a screen edge to collapse it into a **movable border icon**; tap the icon to open the form again. Layout is remembered on the device (`__emu-hold-form-v3`).
- Desktop CDP hold defaults to **Draw: OFF** so the page stays clickable/scrollable when the form appears.
- Desktop hold includes a **Test first** button. It hides the form, unlocks the page, and shows a **Resume feedback** dock. Reviewers must use this when they need to click through the app before Accept/Submit. Do not treat “form blocked my testing” as product feedback — tell them to use Test first.
- Keep Draw: OFF while checking hover animations. Draw: ON puts a full-screen canvas over the page and blocks pointerenter.
- Never paint `--answer` into the host app. Clear `[data-emu-answer]` instead. Review notes stay in the overlay form.
- Hands-free `hold-composite.jpg` must stay readable for frost/smoothness review: capture at up to 960px wide JPEG quality 0.82. Do not cap that capture at 480px.
- Pointer-follow animations: dispatch `pointermove` on the **parent interactive module**, not only a nested canvas/child.
- Default draw scope is full screen.
- Zone selector is still required for navigation validation, even when draw scope is full.
- Use zone-only draw mode only when reviewer explicitly asks.

Hard rule:

- Do not assume "no note text" means no feedback if drawing strokes are present.
- Treat drawn annotations as actionable feedback and continue loop automatically.
- If a hold note says “apply the same” to another region, map it to **style of that region’s live page**, not to copy an illustration from the annotated cell, unless the note names that illustration.

## 5) Common Domain Warnings

- If `finalUrl` contains `/login`, session/auth is not ready.
- If page loads but no interactive elements exist, app may not be hydrated.
- If behavior changes between runs, compare:
  - `domain-cache/<domain>.json` recent entries
  - current run log vs previous run log

## 6) Suggested Command Pattern

Use this order for stable runs:

1. DOM probe
2. one safe action
3. real scenario actions

Example:

```bash
node emulator.js dom --config config.json --url "https://example.com/page" --useCdp true --cdpEndpoint "http://127.0.0.1:9223" --session example-main --keepProgress true --runTag example-dom-1 --timeout 3000
node emulator.js action --config config.json --url "https://example.com/page" --useCdp true --cdpEndpoint "http://127.0.0.1:9223" --type waitForSelector --selector body --session example-main --keepProgress true --runTag example-action-1 --timeout 3000
```

CDP startup retry example (first launch may be slow):

```bash
node emulator.js action --config config.json --useCdp true --cdpEndpoint "http://127.0.0.1:9223" --cdpAutoStart true --cdpLaunchDetached false --cdpStartupRetries 2 --cdpRetryLaunchDetached true --url "https://example.com" --type waitForSelector --selector body --runTag example-cdp-retry-1 --timeout 3000
```

CDP example (already-open Edge tab):

```bash
node emulator.js dom --config config.json --useCdp true --cdpEndpoint "http://127.0.0.1:9223" --attachMatchUrl "example.com/page" --runTag example-cdp-dom-1 --timeout 3000
node emulator.js action --config config.json --useCdp true --cdpEndpoint "http://127.0.0.1:9223" --attachMatchUrl "example.com/page" --type waitForSelector --selector body --runTag example-cdp-action-1 --timeout 3000
```

## 10) Timeout Guardrail (Agent Commands)

- Enforced timeout range for testing commands:
  - min: `1000` ms
  - max: `8000` ms
- If a flow needs more wait, use repeated short waits (`waitForTimeout`) instead of one long timeout.
- Reject command drafts that set `--timeout` below `1000` or above `8000`.

## 7) Naming Convention

- Session names: `<domain>-main` or `<project>-main`
- Run tags: `<domain>-<flow>-<index>`
  - example: `example-create-task-1`

## 8) Minimum Report After Every Test

Record at least:

- URL tested
- runTag
- status: success/warning/failed
- finalUrl
- log path
- screenshot path
- dom path
- key observation (1 line)

## 9) Test Folder Requirement

- Place scenario scripts/configs inside `test/` (do not keep them at project root).
- For temporary one-off scenarios, prefer `output/case-notes.json` with `caseKey`.
- Commit only safe templates/examples; keep credentials in local-only files.
- Ignore local test credential files with: `test/**/*.local.json`.
- Default first test case path: `test/first-case/config.first-case.example.json`.
- Run first case directly with:
  - `node emulator.js run --config test/first-case/config.first-case.example.json --runTag first-case-test`
- For login flow, use:
  - config template: `test/login/config.login.invalid.example.json`
  - report helper: `test/login/report-login-result.js`
- For live iterative testing on user-opened browser:
  - use `--liveMode true` (never `--background true`)
  - keep Edge open with remote debugging on the **same port** as `--cdpEndpoint`
  - prefer a dedicated port other than the user's daily browser port
  - reuse the matching open tab (`--attachMatchUrl`, `--cdpNavigate false`, omit `--url`)
  - keep `cdpAutoStart` enabled only for first-time reliability
  - after in-tab JS that reloads/navigates (`evaluate`), wait for a stable selector in the **same** `run`; do not start a new command while the document is still swapping
  - prefer waiting for a new selector over `location.reload()` when HMR already applied the change
  - step capture waits for `domcontentloaded` and retries once if the screenshot races a navigation
  - save each confirmed step with `--saveCaseNoteTo output/case-notes.json --caseKey <scenario-key>`
  - store human-readable flow notes (example: login -> projects -> open project)
  - do not close browser between steps unless user explicitly asks

