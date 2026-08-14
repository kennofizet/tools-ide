# Default Domain Note

## Summary
- No domain-specific flow note found.
- Start with DOM probe + one safe action before complex clicks.

## Fast Checklist
- Confirm target URL and runTag.
- Reuse stable session (`--session`, `--keepProgress true`) unless clean state is required.
- Prefer scoped selectors over plain `text=...` when duplicate labels exist.

## Artifacts to read
- `output/runs/<runTag>/run-summary.json`
- `output/runs/<runTag>/agent-state.json`
- `output/runs/<runTag>/screen-*.png`
- `output/runs/<runTag>/dom*.html`
