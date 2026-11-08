export function openStockroom() {
  const stock = new Map([['BOOK-42', 5], ['PEN-9', 1]]);
  return {
    available(sku) { return stock.get(sku) ?? 0; },
    reserve(sku, quantity) {
      const remaining = (stock.get(sku) ?? 0) - quantity;
      if (remaining < 0) throw new RangeError('재고 부족');
      stock.set(sku, remaining);
      return remaining;
    },
  };
}

export function allocate(warehouse, notify, sku, quantity) {
  if (warehouse.available(sku) < quantity) return { status: 'unavailable' };
  const remaining = warehouse.reserve(sku, quantity);
  notify({ sku, quantity, remaining });
  return { status: 'reserved', remaining };
}
