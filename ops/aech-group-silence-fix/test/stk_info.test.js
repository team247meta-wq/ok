'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { stkCaption, splitForCommand, isStkInfoCommand, MAX_STK_PER_COMMAND } = require('../stkinfo');

const full = { id: '1', bankName: 'Vietcombank', bankBin: '970436', accountNo: '0011001234567', accountName: 'NGUYEN VAN A', label: 'Ghi mã đơn khi chuyển' };

test('caption has bank, STK, holder and note lines in order', () => {
  assert.equal(
    stkCaption(full),
    '🏦 Vietcombank\n💳 STK: 0011001234567\n👤 NGUYEN VAN A\n📝 Lưu ý: Ghi mã đơn khi chuyển'
  );
});

test('empty note shows (không có)', () => {
  const c = stkCaption({ ...full, label: '' });
  assert.match(c, /📝 Lưu ý: \(không có\)$/);
});

test('missing bank name falls back to BIN, missing holder to placeholder', () => {
  const c = stkCaption({ bankName: '', bankBin: '970415', accountNo: '123', accountName: '', label: '' });
  assert.match(c, /^🏦 970415\n💳 STK: 123\n👤 \(chưa có tên\)\n/);
});

test('whitespace in fields is collapsed and trimmed', () => {
  const c = stkCaption({ ...full, accountName: '  NGUYEN   VAN  A ', label: ' a\n  b ' });
  assert.match(c, /👤 NGUYEN VAN A\n/);
  assert.match(c, /📝 Lưu ý: a b$/);
});

test('splitForCommand caps at 5 and reports the rest', () => {
  const list = Array.from({ length: 8 }, (_, i) => ({ id: String(i) }));
  const { shown, hidden } = splitForCommand(list);
  assert.equal(shown.length, MAX_STK_PER_COMMAND);
  assert.equal(hidden, 3);
});

test('splitForCommand with few accounts hides nothing', () => {
  assert.deepEqual(splitForCommand([{}, {}]).hidden, 0);
  assert.deepEqual(splitForCommand([]), { shown: [], hidden: 0 });
});

test('command matcher accepts aliases and @bot suffix, rejects others', () => {
  assert.equal(isStkInfoCommand('/bank'), true);
  assert.equal(isStkInfoCommand('/stkqr'), true);
  assert.equal(isStkInfoCommand('/thongtin_stk'), true);
  assert.equal(isStkInfoCommand('/bank@AechBot'), true);
  assert.equal(isStkInfoCommand(' /BANK '), true);
  assert.equal(isStkInfoCommand('/bank 5'), false);
  assert.equal(isStkInfoCommand('bank'), false);
  assert.equal(isStkInfoCommand('/gan_bank'), false);
});

