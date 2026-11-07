'use strict';

// Formatter for the group "xem STK" command (/bank, /stkqr, /thongtin_stk).
// Pure functions only: no I/O, so they can be unit-tested directly.

const MAX_STK_PER_COMMAND = 5;
const NO_NOTE = '(không có)';
const NO_NAME = '(chưa có tên)';

const STK_INFO_RE = /^\/(bank|stkqr|thongtin_stk)(?:@\w+)?$/i;

function clean(value) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
}

// Caption for one receiving account. Fields in fixed order; missing note/name get placeholders.
function stkCaption(account) {
  const bankName = clean(account.bankName) || clean(account.bankBin) || '(ngân hàng)';
  const accountNo = clean(account.accountNo);
  const accountName = clean(account.accountName) || NO_NAME;
  const note = clean(account.label) || NO_NOTE;
  return [
    `🏦 ${bankName}`,
    `💳 STK: ${accountNo}`,
    `👤 ${accountName}`,
    `📝 Lưu ý: ${note}`,
  ].join('\n');
}

// Split the account list into the ones to send now and a count of hidden ones.
function splitForCommand(accounts, max = MAX_STK_PER_COMMAND) {
  const list = Array.isArray(accounts) ? accounts : [];
  return { shown: list.slice(0, max), hidden: Math.max(0, list.length - max) };
}

function isStkInfoCommand(text) {
  return STK_INFO_RE.test(String(text || '').trim());
}

module.exports = { stkCaption, splitForCommand, isStkInfoCommand, MAX_STK_PER_COMMAND, NO_NOTE, NO_NAME };

