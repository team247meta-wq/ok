# aech-bot group silence hard fix

Base tip: `4433ab8` (`sandbox/3e2c0ddd-7474-4f47-810d--ki7q`)

## Admin config (not missing)
Bot already knows the super admin via Railway env (user id, **not** group id):

- `SUPER_ADMIN_ID=7527677281`
- `SUPER_ADMIN_IDS` includes `7527677281`
- `ADMIN_CHAT_ID=7527677281` (legacy compat; must stay a user id)

Boot logs should show `SUPER_ADMIN_COUNT=1` and DIAG lines `ENV_*_EQ_EXPECTED=yes`.
Self-check in Telegram: `/whoami` (aliases `/me`, `/quyen`) → `SuperAdmin: yes`.

## Rule
In non-private chats, process text if it is a **slash** (`/cmd` or `/cmd@bot`) **or** an exact `MENU_LABELS` button.
Leftover sessions, `pendingNv`, payment free-text, quick `+/-`, and AI analyze do **not** bypass silence in groups.
Private chats keep menus + sessions + wizards. `callback_query` unchanged.

Slash matching uses `isSlashCmd` so `/cmd@BotName` (Telegram group menu form) works the same as `/cmd`.
Boot markers: `GROUP_SILENCE_HARD=1 ADMIN_MENU=1 SLASH_AT=1` and `SUPER_ADMIN_COUNT=<n>` (count only, no ids).

## Why commands looked “ignored”
1. Tip matched `text==='/in'` exactly → Telegram group menus send `/in@ngayngo_bot` → no match.
2. Earlier patcher imported `{ isSlashCmd }` from tip `routing.js` that did **not** export it → runtime `isSlashCmd is not a function`.
3. Admin env was fine; symptom was recognition/matching, not missing admin config.

## Apply into aech git (required for permanent cutover)
Railway `railway-agent` must open a sandbox PR on `ngayngo666-ship-it/aech` off `4433ab8`, commit these mirrored files, deploy that commit, restore:

```
startCommand: node --require ./preload.js server.js
```

Then delete `GROUP_FIX_PATCHER_GZB64` (and related temp `GROUP_FIX_*` patcher vars). Keep `VIETQR_LOOKUP=1`, `AI_MESSAGE_ANALYZE=0`, `SUPER_ADMIN_ID=7527677281`, `DATABASE_URL`.

**Blocker:** `railway-agent` / private `aech` write access. Until then, production stays on tip `4433ab8` + startCommand patcher.

## Current live workaround
Inline surgical patcher in `GROUP_FIX_PATCHER_GZB64` (defines `slashCmd`/`isSlashCmd`/`isMenuLabel` on `server.js`, no gzip routing blob — large env blobs get corrupted via MCP).
`startCommand`:

```
node -e "const b=process.env.GROUP_FIX_PATCHER_GZB64||'';console.log('PATCHER_LEN='+b.length);eval(require('zlib').gunzipSync(Buffer.from(b,'base64')).toString('utf8'))"
```

Keep patcher gzb64 under ~2.2KB when setting via Railway MCP.

## How admin should send commands
- **Groups:** `/command` or Telegram `/` menu (`/command@ngayngo_bot` OK). Exact reply-keyboard labels also work for users with access.
- **Private chat:** reply-keyboard menus for super admin `7527677281`.
- Check identity: `/whoami`
- Admin-only examples: `/gan_bank`, `/setgroup`, `/them_nv`, `/kiemtra`, `/thongbao`.

## Tests
```bash
node --test test/routing.test.js test/routing_payment.test.js test/group_silence.test.js test/stk_info.test.js
```
