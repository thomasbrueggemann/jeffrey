/**
 * Cart pricing. Amounts are plain numbers in the store currency and are only rounded to cents at
 * the very end, in `total`.
 *
 * @typedef {{ sku: string, price: number, qty: number }} Item
 * @typedef {{ type: 'percent' | 'fixed', value: number }} Discount
 * @typedef {{ items: Item[], discount?: Discount }} Cart
 */

/** Price times quantity. A negative quantity is a caller bug and throws a RangeError. */
export function lineTotal(item) {
  if (item.qty < 0) throw new RangeError(`negative quantity for ${item.sku}`);
  return item.price * item.qty;
}

/** Sum of all line totals. An empty cart is 0. */
export function subtotal(items) {
  return items.reduce((sum, item) => sum + lineTotal(item), 0);
}

/**
 * Apply one discount to an amount. A percent discount takes `value` percent off (10 means 10%);
 * a fixed discount takes `value` off. A discount never makes the amount negative.
 */
export function applyDiscount(amount, discount) {
  if (!discount) return amount;
  const off = discount.type === 'percent' ? (amount * discount.value) / 100 : discount.value;
  return Math.max(0, amount - off);
}

/**
 * What the customer pays: the subtotal, minus the discount, plus tax on the discounted amount,
 * rounded to cents.
 */
export function total(cart, { taxRate = 0 } = {}) {
  const discounted = applyDiscount(subtotal(cart.items), cart.discount);
  return Math.round(discounted * (1 + taxRate) * 100) / 100;
}
