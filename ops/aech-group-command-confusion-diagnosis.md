# aech-bot group free-text → command confusion — DIAGNOSIS ONLY
Date: 2026-11-07
Live: tip `4433ab8` on `sandbox/3e2c0ddd-7474-4f47-810d--ki7q`
Service: aech-bot e03ec415-b0c6-4d06-a8ba-a7f79eeef6dd
Env: production 7f147702-5cd8-4e12-af18-1fccc3ea369e
Diag deploys: f47cf75a (full dump), f292fcbc (stkinfo/sessions)
No code fix deployed in this step.

## Live env flags (proven via startup dump)

| Var | Runtime value | Used in code? |
|---|---|---|
| `AI_MESSAGE_ANALYZE` | **"0"** | yes — gate is `=== '1'` at server.js:784 |
| `AI_MESSAGE_ANALYZE_GROUPS` | **"0"** | **NO** — `AI_GROUPS_USE=false` (never referenced in server.js) |

Flags being 0 is **not** enough: the remaining holes are code-path holes, not env.

## Current early-return (LIVE server.js:589)

```js
// Nhóm: tin tự do (không có /) không được xử lý, trừ khi đang trong phiên nhập liệu của người đó.
if(chat.type!=='private'&&!isSlash&&!isControl&&!sessions.has(sessionKey(chat.id,from.id)))return;
```

Definitions just above (server.js:563–565):
```js
const isSlash=text.startsWith('/');
const isControl=routing.isCommandText(text);
```

`routing.js` (full live file, 52 lines):
```js
const MENU_LABELS = ['💰 Tiền vào', '💸 Tiền ra', '📊 Tổng', '🏦 Tạo QR', '⚙️ Quản lý', '📢 Thông báo', '🧾 Chốt sổ'];
function isCommandText(text) {
  const t = String(text || '').trim();
  return t.startsWith('/') || MENU_LABELS.includes(t);  // exact match
}
function allowQuickTransaction(text) {
  return /^[+-]\s*\d/.test(String(text || '').trim());
}
function isClearPaymentRequest(text, parsed) {
  if (!String(text || '').trim() || !parsed) return false;
  if (isCommandText(text)) return false;
  return !!parsed.account && /^\d{6,19}$/.test(String(parsed.account)) && !!(parsed.bank || parsed.amount);
}
// SessionMap TTL = 10 minutes
```

sessions init: `sessions = new routing.SessionMap()` (10 min TTL on get/has).

## handleUpdate (server.js:803)

```js
async function handleUpdate(update){
  if(update.my_chat_member){await registerGroupChat(...);return;}
  if(update.callback_query)return handleCallback(update.callback_query);
  if(update.message)return handleMessage(update.message);
}
```
Poll `allowed_updates`: `message`, `callback_query`, `my_chat_member` only.
→ **edited_message / channel_post / captions-as-edits are NOT handled** (no hole there).

## Path map (what can still treat free text as action in groups)

### A) BEFORE silence gate (always reachable in groups)
1. **Photos/documents** (HM_START): `handleImage` / broadcast image — no slash required.
2. **stkinfo** (server.js:562): only `/bank|/stkqr|/thongtin_stk` — slash-only, OK.
3. **pendingNv** (3-min window after staff inline buttons): next free-text message is consumed as staff target (admin only). Can look like “bot reacted to normal chat”.
4. **access==='none'**: silent return (OK).

### B) Silence gate BYPASSES (the real bugs)
Gate returns early only when ALL of: non-private AND NOT slash AND NOT isControl AND NO session.

So these still process in groups:

1. **MENU_LABELS as commands (PRIMARY HOLE)**  
   Exact strings `💰 Tiền vào`, `💸 Tiền ra`, `📊 Tổng`, `🏦 Tạo QR`, `⚙️ Quản lý`, `📢 Thông báo`, `🧾 Chốt sổ` set `isControl=true` → gate does NOT return → handlers at server.js:721+ run (open tx wizard, QR flow, etc.).  
   Prior silence commit message even admits this: “not /commands, **not menu labels**, and not inside an active session”.  
   Matching is `MENU_LABELS.includes(t)` (exact after trim) — not substring — but reply-keyboard taps and anyone pasting the exact label still fire.

2. **Open sessions (SECONDARY HOLE)**  
   Any `sessions.has(chat:user)` (payment, complete_payment, tx, preset_*, setup_*, edit_payment, imgpay, broadcast, staff_*) lets later free text through for up to **10 minutes**. Wizard then “swallows” chat. TTL helps but user can still see mistaken prompts.

3. **Slash commands** (`text.startsWith('/')`) — intended; prefer Telegram `bot_command` entity later.

### C) AFTER gate (only if A/B let traffic through)
- `isClearPaymentRequest` + `parsePaymentSafely(..., {ai:false})` (591+) — requires account 6–19 digits + bank/amount; also requires `!isControl && !session`, so in groups this path is mostly dead after gate (reachable mainly from private).
- Menu handlers 721–735 (`💰 Tiền vào` / `💸 Tiền ra` / `🏦 Tạo QR` …).
- `allowQuickTransaction` → `parseQuickTransaction` (781) — only `+digits`/`-digits`; needs gate bypass.
- AI analyze (784): `AI_MESSAGE_ANALYZE==='1'` — **OFF live**.
- `looksLikePaymentRequest` inside payment session (709).

### D) Callbacks
`handleCallback` — legitimate; keep for groups.

## Why “configured many times” still fails

Env toggles (`AI_MESSAGE_ANALYZE=0`) only disable the AI block. The silence patch **intentionally still treats reply-keyboard labels as commands in groups**. Users tapping or typing those labels (or leaving an open session) still get bot “command” behavior. `AI_MESSAGE_ANALYZE_GROUPS` is a red herring — unused.

## Recommended HARD RULE (non-private)

```js
function isGroupCommand(message) {
  const text = String(message.text || '').trim();
  const ents = message.entities || [];
  const hasBotCommand = ents.some(e => e.type === 'bot_command' && e.offset === 0);
  return hasBotCommand || text.startsWith('/'); // fallback if entities missing
}
// In handleMessage, for chat.type !== 'private':
//   - Allow: callback_query (separate), isGroupCommand, optional force_reply continuation ONLY when message.reply_to_message matches bot prompt
//   - Deny: MENU_LABELS, payment free-text, quick tx, AI analyze, bare session without reply_to
```

Private chats: keep MENU_LABELS + wizard sessions.
Super-admin: only slash-prefixed admin commands (no plain-text bypass).

## Patch plan (files + tests) — do not deploy yet

1. **`routing.js`**
   - Add `isGroupAllowedText(message)` / split `isCommandText` into `isSlashCommand` vs `isMenuLabel`.
   - Export helpers; keep `MENU_LABELS` for private keyboard only.

2. **`server.js` `handleMessage`**
   - Replace gate with hard rule above.
   - Move photo/OCR behind: private OR slash-triggered session OR explicit callback.
   - Restrict `pendingNv` consumption to reply_to / slash cancel.
   - In groups, do not send `mainKeyboard()` reply keyboard (prevents label taps); use slash commands + inline buttons only.
   - Session continuation in groups: require `message.reply_to_message` to bot force_reply, else clear session and ignore.

3. **`stkinfo.js`** — already slash-only; OK.

4. **Tests** (`test/routing_payment.test.js` + new `test/group_silence.test.js`):
   - Group + plain “hello” → no handler / early return.
   - Group + exact `🏦 Tạo QR` → **ignore** (new expected).
   - Group + `/qr` or bot_command entity → allow.
   - Group + open session without reply_to → ignore / clear.
   - Group + callback_query → allow.
   - Private + menu label → still allow.
   - `AI_MESSAGE_ANALYZE=0/1` matrix for private only.
   - Account+bank free text in group → ignore.

5. **Ops**
   - Can delete unused `AI_MESSAGE_ANALYZE_GROUPS` or wire it; currently dead.
   - After patch: deploy tip; leave flags at 0.

## Restore note
Diagnostic startCommand must be restored to `node --require ./preload.js server.js` after this report (same tip 4433ab8).
