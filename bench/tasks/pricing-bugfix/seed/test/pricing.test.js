import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lineTotal, subtotal, applyDiscount, total } from '../src/pricing.js';

const items = [
  { sku: 'mug', price: 12.5, qty: 2 },
  { sku: 'tea', price: 4.25, qty: 4 },
];

test('line total is price times quantity', () => {
  assert.equal(lineTotal({ sku: 'mug', price: 12.5, qty: 2 }), 25);
});

test('subtotal adds up every line', () => {
  assert.equal(subtotal(items), 42);
  assert.equal(subtotal([]), 0);
});

test('a percent discount takes that percentage off', () => {
  assert.equal(applyDiscount(200, { type: 'percent', value: 10 }), 180);
});

test('a fixed discount takes that amount off', () => {
  assert.equal(applyDiscount(50, { type: 'fixed', value: 15 }), 35);
});

test('tax is charged on the discounted amount', () => {
  assert.equal(total({ items, discount: { type: 'percent', value: 50 } }, { taxRate: 0.2 }), 25.2);
});
