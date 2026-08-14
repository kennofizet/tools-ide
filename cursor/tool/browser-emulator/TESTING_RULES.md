# Browser Emulator Testing Rules (Read First)

Read this file before every test run.

## 1) Core Rules

- Always reuse session unless you intentionally need a clean state.
- Default browser mode is Edge CDP attach (best/recommended); reuse matching open domain tab before opening new tab.
- `--background true` is supported for all modes (Edge/CDP and local launch).
- For any `node emulator.js ...` command, keep timeout between `1000` and `8000` ms.
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

1. Confirm target URL and expected page behavior.
2. Confirm domain flow note exists (or use `flow/domain/default.md`) and read it first.
3. Confirm config file exists (`config.json` or `config.example.json` for quick tests).
4. Confirm persistent mode:
   - `--keepProgress true`
   - `--session <stable-name>`
5. Confirm run is traceable:
   - `--runTag <descriptive-tag>`
6. Confirm timeout is realistic for the page and within enforced range:
   - minimum `1000`
   - maximum `8000`
   - recommended default `3000`
7. Confirm session policy:
   - normal workspace test: `--forgetPageAfterRun false`
   - normal workspace test: `--forgetDomainCacheAfterRun false`
   - normal workspace test: `--forgetSessionAfterRun false`
   - keep `--enableDomainCache true` for flow memory
   - switch to strict privacy mode only when user explicitly requests it
8. If testing an already-open Edge tab:
   - Edge must be started with `--remote-debugging-port=9223`
   - run with `--useCdp true`
   - keep browser preference as Edge unless user explicitly requests Chrome (`--browser edge`)
   - set `--attachMatchUrl` to avoid attaching wrong tab
   - use `--attachRequireMatch true` for strict safety
   - for public-friendly behavior, keep `--cdpAutoOpenIfMissing true`
   - for startup reliability, keep `--cdpAutoStart true --cdpStartupRetries 2 --cdpRetryLaunchDetached true`
9. Default attach matching:
   - if `--attachMatchUrl` is empty, tool should match by target URL domain first
   - only open/navigate new tab when no matching domain tab exists
10. Keep automation UI lock visible:
   - `--agentOverlayEnabled true`
   - `--agentOverlayText "Agent in progress"`
   - `--agentOverlayDisableClicks true`
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

After completing ANY UI edit task (styling, layout, component change, visual fix), the agent MUST run `holdForUserAnswer` before declaring the task done. This is NOT optional.

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

## 4f) Hold UX Defaults (Public-Friendly)

Use these hold defaults for all UI review runs unless explicitly overridden by user:

- Toolbar is movable by dragging the title row ("Drag toolbar").
- Default draw scope is full screen.
- Zone selector is still required for navigation validation, even when draw scope is full.
- Use zone-only draw mode only when reviewer explicitly asks.

Hard rule:

- Do not assume "no note text" means no feedback if drawing strokes are present.
- Treat drawn annotations as actionable feedback and continue loop automatically.

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
  - example: `company-project-create-task-1`

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
  - use `--liveMode true`
  - keep `cdpAutoStart` enabled for first-time reliability
  - keep Edge open with remote debugging port
  - save each confirmed step with `--saveCaseNoteTo output/case-notes.json --caseKey <scenario-key>`
  - store human-readable flow notes (example: login -> projects -> open project)
  - do not close browser between steps unless user explicitly asks

