import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
import { allocate } from '../dist/index.js';

test('예약 성공은 재고를 차감하고 예약 내역을 한 번 통지한다', () => {
  const warehouse = { available: mock.fn(() => 5), reserve: mock.fn(() => 3) };
  const notify = mock.fn();
  const result = allocate(warehouse, notify, 'BOOK-42', 2);
  assert.equal(warehouse.available.mock.callCount(), 1);
  assert.deepEqual(warehouse.available.mock.calls[0].arguments, ['BOOK-42']);
  assert.equal(warehouse.reserve.mock.callCount(), 1);
  assert.deepEqual(warehouse.reserve.mock.calls[0].arguments, ['BOOK-42', 2]);
  assert.equal(notify.mock.callCount(), 1);
  assert.deepEqual(notify.mock.calls[0].arguments[0], { sku: 'BOOK-42', quantity: 2, remaining: 3 });
  assert.deepEqual(result, { status: 'reserved', remaining: 3 });
});

test('재고 부족이면 예약과 통지 협력자를 호출하지 않는다', () => {
  const warehouse = { available: mock.fn(() => 1), reserve: mock.fn() };
  const notify = mock.fn();
  const result = allocate(warehouse, notify, 'PEN-9', 2);
  assert.equal(warehouse.available.mock.callCount(), 1);
  assert.equal(warehouse.reserve.mock.callCount(), 0);
  assert.equal(notify.mock.callCount(), 0);
  assert.deepEqual(result, { status: 'unavailable' });
});

test('같은 협력자로 연속 예약하면 첫 예약에서 줄어든 재고가 다음 예약에 반영된다', () => {
  let stock = 5;
  const warehouse = {
    available: mock.fn(() => stock),
    reserve: mock.fn((sku, quantity) => (stock -= quantity)),
  };
  const notify = mock.fn();
  const first = allocate(warehouse, notify, 'BOOK-42', 3);
  const second = allocate(warehouse, notify, 'BOOK-42', 3);
  assert.equal(warehouse.available.mock.callCount(), 2);
  assert.equal(warehouse.reserve.mock.callCount(), 1);
  assert.equal(notify.mock.callCount(), 1);
  assert.deepEqual(first, { status: 'reserved', remaining: 2 });
  assert.deepEqual(second, { status: 'unavailable' });
});

test('등록되지 않은 상품은 재고 0으로 처리하고 예약하지 않는다', () => {
  const warehouse = { available: mock.fn(() => 0), reserve: mock.fn() };
  const notify = mock.fn();
  const result = allocate(warehouse, notify, 'UNKNOWN', 1);
  assert.deepEqual(warehouse.available.mock.calls[0].arguments, ['UNKNOWN']);
  assert.equal(warehouse.reserve.mock.callCount(), 0);
  assert.equal(notify.mock.callCount(), 0);
  assert.deepEqual(result, { status: 'unavailable' });
});
