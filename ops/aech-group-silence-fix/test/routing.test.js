'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { isCommandText, isSlashCommand, isGroupAllowedMessage, allowQuickTransaction, SessionMap, SESSION_TTL_MS } = require('../routing');

test('slash messages are commands', () => {
  assert.equal(isCommandText('/start'), true);
  assert.equal(isCommandText('/bank'), true);
  assert.equal(isCommandText('  /huy  '), true);
});

test('exact menu labels are commands', () => {
  for (const label of ['💰 Tiền vào', '💸 Tiền ra', '📊 Tổng', '🏦 Tạo QR', '⚙️ Quản lý', '📢 Thông báo', '🧾 Chốt sổ']) {
    assert.equal(isCommandText(label), true, label);
  }
});

test('ordinary chat is never a command, even with numbers or keywords', () => {
  for (const t of ['nhận 2 cái', 'thu 3 đơn', 'tổng cộng 500k', '2+3', '12*4', 'stk 123456789', 'Tiền vào hôm nay', 'hello']) {
    assert.equal(isCommandText(t), false, t);
  }
});

test('quick transaction only with explicit leading sign', () => {
  assert.equal(allowQuickTransaction('+500k'), true);
  assert.equal(allowQuickTransaction('- 200k'), true);
  assert.equal(allowQuickTransaction('nhận 2 cái'), false);
  assert.equal(allowQuickTransaction('thu 3 đơn'), false);
  assert.equal(allowQuickTransaction('chi 100k'), false);
  assert.equal(allowQuickTransaction('2+3'), false);
  assert.equal(allowQuickTransaction(''), false);
});

test('sessions are readable while fresh', () => {
  const s = new SessionMap();
  s.set('k', { mode: 'tx', type: 'in' });
  assert.equal(s.get('k').mode, 'tx');
  assert.equal(s.has('k'), true);
});

test('sessions expire after TTL and are removed', () => {
  const s = new SessionMap();
  s.set('k', { mode: 'payment' });
  const realNow = Date.now;
  try {
    Date.now = () => realNow() + SESSION_TTL_MS + 1;
    assert.equal(s.get('k'), undefined);
    assert.equal(s.has('k'), false);
    assert.equal(s.size, 0);
  } finally {
    Date.now = realNow;
  }
});

test('in-place mutation of a stored session persists', () => {
  const s = new SessionMap();
  s.set('k', { mode: 'x', n: 1 });
  s.get('k').n = 2;
  assert.equal(s.get('k').n, 2);
});


test('isSlashCommand trims and accepts /cmd@bot', () => {
  assert.equal(isSlashCommand('/bank'), true);
  assert.equal(isSlashCommand(' /bank@MyBot'), true);
  assert.equal(isSlashCommand('🏦 Tạo QR'), false);
  assert.equal(isSlashCommand('tiền vào 100k'), false);
});

test('isGroupAllowedMessage is slash-only outside private', () => {
  assert.equal(isGroupAllowedMessage({ text: '/qr', chatType: 'group' }), true);
  assert.equal(isGroupAllowedMessage({ text: '🏦 Tạo QR', chatType: 'group' }), false);
  assert.equal(isGroupAllowedMessage({ text: '🏦 Tạo QR', chatType: 'private' }), true);
});
