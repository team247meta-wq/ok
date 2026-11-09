# VietQR Mini App autofill (2026-11-07)

## Deploy
- Project: pleasing-happiness (`2c55a4c3-cee7-4a73-9b83-a490bf39089e`)
- Service: aech-bot (`e03ec415-b0c6-4d06-a8ba-a7f79eeef6dd`)
- Branch: `sandbox/3e2c0ddd-7474-4f47-810d--ki7q`
- Commit: `4433ab8`
- Deploy: `bce4204f-97ae-40da-8a36-2a5e5e8311c4` SUCCESS
- Railway agent thread: `3e2c0ddd-7474-4f47-810d-24a495d3beb4`

## Flags
- KEYS_OK: yes (`VIETQR_API_KEY`, `VIETQR_CLIENT_ID` present)
- LOOKUP_FLAG: `VIETQR_LOOKUP=1` (`VIETQR_LOGO=0`)
- npm test: 84/84

## Root cause (live mini/bank.html before fix)
1. `autoFillFromQr` sent empty `chat_id` → `Thiếu chat_id`
2. No client `/api/lookup` fallback when `account_name` was null
3. Group change did not re-run autofill after a QR was selected

## Files changed (aech)
- `mini/bank.html` — require chat_id; `fillFromParsedQr` + `/api/lookup`; re-autofill on group change
- Server already called `vietqr.lookupAccount` in `POST /api/parse-qr-image` when lookup enabled (no server change)
