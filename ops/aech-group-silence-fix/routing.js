'use strict';

// Message routing rules. Pure helpers so the rules can be unit-tested without the bot runtime.

// Exact menu-button labels (reply keyboard). Private chats only — never treated as commands in groups.
const MENU_LABELS = ['💰 Tiền vào', '💸 Tiền ra', '📊 Tổng', '🏦 Tạo QR', '⚙️ Quản lý', '📢 Thông báo', '🧾 Chốt sổ'];

function isMenuLabel(text) {
  return MENU_LABELS.includes(String(text || '').trim());
}

// Slash command: prefer Telegram bot_command entity at offset 0; fallback to trimmed text starting with "/".
// Examples: "/bank", " /bank@bot", entities marking /gan_bank.
function isSlashCommand(text, entities) {
  const raw = String(text || '');
  const t = raw.trim();
  if (!t) return false;
  if (Array.isArray(entities) && entities.some((e) => e && e.type === 'bot_command' && Number(e.offset) === 0)) {
    return true;
  }
  return t.startsWith('/');
}

// Private: slash OR exact menu label. Groups must NOT use this to bypass silence.
function isCommandText(text) {
  const t = String(text || '').trim();
  return t.startsWith('/') || MENU_LABELS.includes(t);
}

// Non-private chats: only slash-prefixed text is allowed through the early gate.
// Private chats: always allowed (menus/sessions/wizards keep working).
function isGroupAllowedMessage({ text, entities, chatType } = {}) {
  if (!chatType || chatType === 'private') return true;
  return isSlashCommand(text, entities);
}

// Free text may create a quick transaction only with an explicit leading sign: "+500k" or "-200k".
// Words such as "nhận 2 cái" or "thu 3 đơn" in ordinary chat must not record money.
function allowQuickTransaction(text) {
  return /^[+-]\s*\d/.test(String(text || '').trim());
}

// Free text is a payment request only when it clearly contains a bank account number (6-19 digits)
// together with a bank name or an amount. Keywords alone ("số tiền", "nội dung", "bank") are not enough,
// so ordinary chat never reaches payment extraction. `parsed` is the output of parsePaymentText(text).
function isClearPaymentRequest(text, parsed) {
  if (!String(text || '').trim() || !parsed) return false;
  if (isCommandText(text)) return false;
  return !!parsed.account && /^\d{6,19}$/.test(String(parsed.account)) && !!(parsed.bank || parsed.amount);
}

// Pending multi-step sessions (mode/state set by buttons or prompts) expire so stale state
// cannot swallow a later normal message.
const SESSION_TTL_MS = 10 * 60 * 1000;

class SessionMap extends Map {
  set(key, value) {
    return super.set(key, { ...value, ts: Date.now() });
  }
  get(key) {
    const v = super.get(key);
    if (v && Date.now() - (v.ts || 0) > SESSION_TTL_MS) {
      super.delete(key);
      return undefined;
    }
    return v;
  }
  has(key) {
    return this.get(key) !== undefined;
  }
}

module.exports = {
  MENU_LABELS,
  isMenuLabel,
  isSlashCommand,
  isCommandText,
  isGroupAllowedMessage,
  allowQuickTransaction,
  isClearPaymentRequest,
  SessionMap,
  SESSION_TTL_MS,
};
