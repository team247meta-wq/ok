'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { isClearPaymentRequest } = require('../routing');

const p = (over) => ({ bank: '', account: null, amount: null, ...over });

test('keyword-only chat is NOT a payment request', () => {
  for (const t of ['số tiền bao nhiêu vậy?', 'nội dung cuộc họp hôm nay', 'bank nào tốt?', 'ngân hàng đóng cửa rồi', 'stk của anh đâu']) {
    assert.equal(isClearPaymentRequest(t, p({})), false, t);
  }
});

test('account + bank or amount IS a payment request', () => {
  assert.equal(isClearPaymentRequest('Vietcombank 0123456789 NGUYEN VAN A 500k', p({ bank: 'Vietcombank', account: '0123456789', amount: 500000n })), true);
  assert.equal(isClearPaymentRequest('0123456789 500k', p({ account: '0123456789', amount: 500000n })), true);
  assert.equal(isClearPaymentRequest('STK: 0123456789 | NH: MB | 500000', p({ bank: 'MB', account: '0123456789', amount: 500000n })), true);
});

test('account alone (no bank, no amount) is not enough', () => {
  assert.equal(isClearPaymentRequest('123456789', p({ account: '123456789' })), false);
});

test('commands never count as payment requests', () => {
  assert.equal(isClearPaymentRequest('/qr 0123456789 500k', p({ account: '0123456789', amount: 500000n })), false);
  assert.equal(isClearPaymentRequest('🏦 Tạo QR', p({ account: '0123456789', bank: 'x' })), false);
});

test('empty or missing parse is not a payment request', () => {
  assert.equal(isClearPaymentRequest('', null), false);
  assert.equal(isClearPaymentRequest('hello', null), false);
});

