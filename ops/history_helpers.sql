-- READ-ONLY helpers for aech-bot ledger. No DELETE/UPDATE/TRUNCATE here.
-- Run with: psql "$DATABASE_PUBLIC_URL" -f history_helpers.sql

SELECT table_name, column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public'
ORDER BY table_name, ordinal_position;

SELECT t.chat_id,
       g.group_name,
       g.timezone,
       COUNT(*) AS tx_count,
       SUM(CASE WHEN t.type='in' THEN t.net_amount ELSE -t.gross_amount END) AS balance,
       MIN(t.created_at) AS first_tx,
       MAX(t.created_at) AS last_tx
FROM transactions t
LEFT JOIN groups g ON g.chat_id = t.chat_id
GROUP BY t.chat_id, g.group_name, g.timezone
ORDER BY last_tx DESC;

SELECT g.chat_id, g.group_name, 'no_transactions' AS flag
FROM groups g WHERE NOT EXISTS (SELECT 1 FROM transactions t WHERE t.chat_id = g.chat_id)
UNION ALL
SELECT DISTINCT t.chat_id, NULL, 'missing_group_row'
FROM transactions t WHERE NOT EXISTS (SELECT 1 FROM groups g WHERE g.chat_id = t.chat_id);

SELECT id, chat_id, type, gross_amount, fee_amount, net_amount, created_at, note
FROM transactions
WHERE created_at >= '2026-10-21 00:00+07'
  AND type='in'
  AND net_amount <> gross_amount - fee_amount;

SELECT source_message_id, COUNT(DISTINCT chat_id) AS chats, array_agg(DISTINCT chat_id) AS chat_ids
FROM transactions
WHERE source_message_id IS NOT NULL
GROUP BY source_message_id
HAVING COUNT(DISTINCT chat_id) > 1;

SELECT r.id AS reversal_id, r.chat_id AS reversal_chat, o.id AS original_id, o.chat_id AS original_chat, r.created_at
FROM transactions r
JOIN transactions o ON o.id = r.reversal_of
WHERE r.chat_id <> o.chat_id;

SELECT chat_id, date_trunc('hour', created_at) AS hour, COUNT(*) AS n
FROM transactions
WHERE created_at >= '2026-10-21 00:00+07'
GROUP BY 1,2
ORDER BY n DESC
LIMIT 50;

SELECT p.id, p.chat_id, p.status, p.created_at, t.id AS tx_id, t.chat_id AS tx_chat
FROM payment_requests p
JOIN transactions t ON t.payment_request_id = p.id
WHERE t.chat_id <> p.chat_id;

SELECT id, chat_id, actor_id, actor_name, event_type, entity_type, entity_id, created_at
FROM audit_logs
WHERE created_at >= '2026-10-21 00:00+07'
ORDER BY id;
