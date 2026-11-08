# aech-bot group silence hard fix

Base tip: `4433ab8` (`sandbox/3e2c0ddd-7474-4f47-810d--ki7q`)

## Rule
In non-private chats, process text **only** if it is a slash command (`isSlashCommand`).
`MENU_LABELS`, leftover sessions, `pendingNv`, payment free-text, quick `+/-`, and AI analyze do **not** bypass silence in groups.
Private chats keep menu labels + sessions + wizards. `callback_query` unchanged.

Boot marker: `console.log('GROUP_SILENCE_HARD=1')`.

## Apply into aech git (required for permanent cutover)
Railway `railway-agent` must open a sandbox PR on `ngayngo666-ship-it/aech` off `4433ab8`, commit these mirrored files, deploy that commit, restore:

```
startCommand: node --require ./preload.js server.js
```

Then delete `GROUP_FIX_PATCHER_GZB64` (and related temp `GROUP_FIX_*` patcher vars). Keep `VIETQR_LOOKUP=1`, `AI_MESSAGE_ANALYZE=0`, `SUPER_ADMIN_ID=7527677281`, `DATABASE_URL`.

**Blocker (2026-11-07):** `railway-agent` returns `Agent usage limit reached`. Cursor `gh` cannot access private `aech`. Until the Railway agent quota is raised (or a GitHub token with `contents:write` on `aech` is provided), production remains on tip `4433ab8` + startCommand patcher.

## Current live workaround
Patched `routing.js` + `server.js` applied at process start via `GROUP_FIX_PATCHER_GZB64` then `node --require ./preload.js server.js`.

## Tests
```bash
node --test test/routing.test.js test/routing_payment.test.js test/group_silence.test.js test/stk_info.test.js
```
