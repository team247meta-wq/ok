# Production cutover verification 2026-11-07

## Live
- Project: pleasing-happiness
- Service: aech-bot
- Branch: sandbox/3e2c0ddd-7474-4f47-810d--ki7q
- Commit: 4433ab8
- Deploy: 4bb0d210-206c-4793-af9c-b516cc28a187 SUCCESS
- Domain: https://aech-bot-production.up.railway.app

## Main
- Last confirmed tip (via prior Railway agent): 83814fc469009987cc6986ac98c07a1567231faf
- 4433ab8 / ed30be6 NOT on main (PR #22 was ed30be6 → main@83814fc; merge blocked from this agent)
- Production kept on complete sandbox tip 4433ab8

## Config set this turn (values not dumped)
- VIETQR_LOOKUP=1
- VIETQR_LOGO=0
- AI_MESSAGE_ANALYZE=0
- SUPER_ADMIN_ID / SUPER_ADMIN_IDS = 7527677281
- Secrets left intact: TELEGRAM_BOT_TOKEN, VIETQR_API_KEY, VIETQR_CLIENT_ID, DATABASE_URL
