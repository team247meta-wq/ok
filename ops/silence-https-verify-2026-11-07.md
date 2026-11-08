# aech-bot silence + https + autofill verification 2026-11-07

## Method
Temporary startCommand grepped live `server.js` / `mini/bank.html` on tip `4433ab8`, then restored `node --require ./preload.js server.js`.

## Results (deploy `84eb13f4-e751-4c33-8258-7b18c1cd33f4`)
- HAS_SILENCE: **yes** — `if(chat.type!=='private'&&!isSlash&&!isControl&&!sessions.has(sessionKey(chat.id,from.id)))return;`
- HAS_HTTPS_FORCE: **yes** — `WEBAPP_URL` IIFE: empty → https default; `v.replace(/^http:\/\//i, 'https://')`
- HAS_AUTOFILL: **yes** — live `mini/bank.html` has `fillFromParsedQr`

## Live after restore
- Branch: `sandbox/3e2c0ddd-7474-4f47-810d--ki7q`
- Commit: `4433ab8`
- No merge/redeploy of combined tip needed (already complete)
- main: not updated (aech GitHub private to this token; Railway agent usage limit)
