'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  MENU_LABELS,
  isSlashCommand,
  isCommandText,
  isMenuLabel,
  isGroupAllowedMessage,
  SessionMap,
} = require('../routing');

test('group text "🏦 Tạo QR" is ignored (menu label not allowed)', () => {
  assert.equal(isMenuLabel('🏦 Tạo QR'), true);
  assert.equal(isCommandText('🏦 Tạo QR'), true); // still true for private helpers
  assert.equal(
    isGroupAllowedMessage({ text: '🏦 Tạo QR', chatType: 'group' }),
    false,
  );
  assert.equal(
    isGroupAllowedMessage({ text: '🏦 Tạo QR', chatType: 'supergroup' }),
    false,
  );
});

test('group free text chatter and +/- are ignored', () => {
  for (const t of ['tiền vào 100k', 'tiền ra 50k', 'nhận 2 cái', '+100k', '-200k', 'hello']) {
    assert.equal(isGroupAllowedMessage({ text: t, chatType: 'group' }), false, t);
    assert.equal(isSlashCommand(t), false, t);
  }
});

test('group clear CK text is allowed when parsed has STK + bank/amount', () => {
  const { isClearPaymentRequest } = require('../routing');
  const t = 'MB 0123456789 500k nd COC PHONG';
  const parsed = { bank: 'MB', account: '0123456789', amount: 500000n };
  assert.equal(isClearPaymentRequest(t, parsed), true);
  assert.equal(isGroupAllowedMessage({ text: t, chatType: 'group', parsed }), true);
  assert.equal(isGroupAllowedMessage({ text: t, chatType: 'supergroup', parsed }), true);
  assert.equal(isGroupAllowedMessage({ text: t, chatType: 'group' }), false); // no parse → still silent
});

test('group slash /bank is allowed', () => {
  assert.equal(isSlashCommand('/bank'), true);
  assert.equal(isGroupAllowedMessage({ text: '/bank', chatType: 'group' }), true);
  assert.equal(isGroupAllowedMessage({ text: '/gan_bank', chatType: 'supergroup' }), true);
  assert.equal(isGroupAllowedMessage({ text: '/them_nv', chatType: 'group' }), true);
});

test('group text " /bank@bot" (leading space) is allowed', () => {
  assert.equal(isSlashCommand(' /bank@bot'), true);
  assert.equal(
    isGroupAllowedMessage({ text: ' /bank@bot', chatType: 'group' }),
    true,
  );
});

test('bot_command entity at offset 0 allows group message', () => {
  const entities = [{ type: 'bot_command', offset: 0, length: 5 }];
  assert.equal(isSlashCommand('/bank', entities), true);
  assert.equal(
    isGroupAllowedMessage({ text: '/bank', entities, chatType: 'group' }),
    true,
  );
});

test('private menu label is still allowed', () => {
  for (const label of MENU_LABELS) {
    assert.equal(isCommandText(label), true, label);
    assert.equal(isMenuLabel(label), true, label);
    assert.equal(
      isGroupAllowedMessage({ text: label, chatType: 'private' }),
      true,
      label,
    );
  }
});

test('group free text with leftover session is still NOT allowed by gate helper', () => {
  // Session bypass must not live in routing helper — groups only get slash.
  const sessions = new SessionMap();
  sessions.set('-100:1', { mode: 'payment' });
  assert.equal(sessions.has('-100:1'), true);
  assert.equal(
    isGroupAllowedMessage({ text: '500k', chatType: 'group' }),
    false,
  );
  assert.equal(
    isGroupAllowedMessage({ text: '🏦 Tạo QR', chatType: 'group' }),
    false,
  );
});

test('channel and group chat types reject free text', () => {
  assert.equal(isGroupAllowedMessage({ text: 'hello', chatType: 'channel' }), false);
  assert.equal(isGroupAllowedMessage({ text: 'hello', chatType: 'group' }), false);
  assert.equal(isGroupAllowedMessage({ text: 'hello', chatType: 'private' }), true);
});
