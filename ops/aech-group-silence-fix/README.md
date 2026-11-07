# aech-bot group silence hard fix

Base tip: `4433ab8` (`sandbox/3e2c0ddd-7474-4f47-810d--ki7q`)

## Rule
In non-private chats, process text **only** if it is a slash command (`isSlashCommand`).
`MENU_LABELS`, leftover sessions, `pendingNv`, payment free-text, quick `+/-`, and AI analyze do **not** bypass silence in groups.
Private chats keep menu labels + sessions + wizards. `callback_query` unchanged.

## Apply
Patched `routing.js` + `server.js` are deployed to Railway production via gzip+base64 env vars
`GROUP_FIX_ROUTING_GZB64` / `GROUP_FIX_SERVER_GZB64` written at process start, then
`node --require ./preload.js server.js`.

## Tests
```bash
node --test test/routing.test.js test/routing_payment.test.js test/group_silence.test.js test/stk_info.test.js
```
