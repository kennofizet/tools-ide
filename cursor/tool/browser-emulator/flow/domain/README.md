# Domain Flow Notes

Use this folder to store fast-start notes per domain so the emulator can read known flow context before actions run.

## File naming

- Preferred: `<domain>.md` (example: `example.com.md`)
- Fallback: `default.md`

The emulator checks these candidates in order:

1. exact domain
2. domain without `www.`
3. sanitized file-safe names
4. `default.md`

## Recommended structure

```md
# <domain>

## Summary
- What this domain is used for
- Typical role/account assumptions

## Fast Navigation Map (example)
- `/auth/login` -> login form
- `/user/me` -> account profile

## Known Good Selectors
- `#input-0` username/email
- `#input-2` password
- `button[type='submit']` login button

## Known Pitfalls
- Hidden duplicate menu labels can break `text=...` selectors
- Prefer scoped selectors (button/tab container) when possible
```

## Goal

Keep notes short and practical. These notes are for speeding up agent navigation and reducing repeated trial-and-error in simple flows.
