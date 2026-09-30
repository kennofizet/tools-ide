# Default Domain Note

## Summary
- No domain-specific flow note found.
- Start with DOM probe + one safe action before complex clicks.

## Review device
- If `output/review-mode.local.json` is missing, ask: this computer (desktop) or another device (hands-free).
- Save with `node emulator.js review-mode --mode desktop|hands-free`.
- Other-device feedback requires `hands-free`.

## Fast Checklist
- Confirm target URL and runTag.
- Reuse stable session (`--session`, `--keepProgress true`) unless clean state is required.
- Prefer scoped selectors over plain `text=...` when duplicate labels exist.
- Vue/SPA pages: first `goto` often captures the boot spinner. After navigate, run a second step (`waitForSelector` / `waitForText` on a known post-load marker, or `reload` then wait) before treating screenshot/DOM as the product UI.
- Always read `flow/domain/<host>.md` first — domain notes may require a dedicated CDP port (not the tool default), and they stay local / gitignored.

## Artifacts to read
- `output/runs/<runTag>/run-summary.json`
- `output/runs/<runTag>/agent-state.json`
- `output/runs/<runTag>/screen-*.png`
- `output/runs/<runTag>/dom*.html`
