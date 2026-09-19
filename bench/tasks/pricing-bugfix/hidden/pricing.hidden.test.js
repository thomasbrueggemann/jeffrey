import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lineTotal, subtotal, applyDiscount, total } from '../src/pricing.js';

const items = [
  { sku: 'mug', price: 12.5, qty: 2 },
  { sku: 'tea', price: 4.25, qty: 4 },
];

test('percent discounts are a percentage of the amount', () => {
  assert.equal(applyDiscount(80, { type: 'percent', value: 25 }), 60);
  assert.equal(applyDiscount(80, { type: 'percent', value: 100 }), 0);
});

test('a fixed discount larger than the amount clamps to zero', () => {
  assert.equal(applyDiscount(10, { type: 'fixed', value: 15 }), 0);
  assert.equal(total({ items: [{ sku: 'pen', price: 3, qty: 1 }], discount: { type: 'fixed', value: 5 } }, { taxRate: 0.2 }), 0);
});

test('a percent discount never goes negative either', () => {
  assert.equal(applyDiscount(10, { type: 'percent', value: 150 }), 0);
});

test('no discount leaves the amount alone', () => {
  assert.equal(applyDiscount(42, undefined), 42);
  assert.equal(total({ items }, { taxRate: 0 }), 42);
});

test('tax applies after the discount', () => {
  assert.equal(total({ items, discount: { type: 'fixed', value: 2 } }, { taxRate: 0.1 }), 44);
  assert.equal(total({ items, discount: { type: 'percent', value: 10 } }, { taxRate: 0.25 }), 47.25);
});

test('totals are rounded to cents', () => {
  assert.equal(total({ items: [{ sku: 'a', price: 0.1, qty: 1 }, { sku: 'b', price: 0.2, qty: 1 }] }), 0.3);
  assert.equal(total({ items: [{ sku: 'c', price: 9.99, qty: 3 }] }, { taxRate: 0.07 }), 32.07);
});

test('the behaviour that already worked still works', () => {
  assert.equal(lineTotal({ sku: 'x', price: 2, qty: 0 }), 0);
  assert.throws(() => lineTotal({ sku: 'x', price: 2, qty: -1 }), RangeError);
  assert.equal(subtotal([]), 0);
});
