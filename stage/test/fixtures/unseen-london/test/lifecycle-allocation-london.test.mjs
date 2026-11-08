import assert from 'node:assert/strict';
import { beforeEach, describe, test, mock } from 'node:test';
import { allocate } from '../dist/index.js';

describe('beforeEach에서 협력자를 구성하는 새 런던파 테스트', () => {
  let warehouse;
  let notify;
  beforeEach(() => {
    warehouse = { available: mock.fn(() => 5), reserve: mock.fn(() => 3) };
    notify = mock.fn();
  });
  test('공통 준비에서 주입한 재고 협력자를 호출한다', () => {
    const result = allocate(warehouse, notify, 'BOOK-42', 2);
    assert.equal(warehouse.reserve.mock.callCount(), 1);
    assert.equal(notify.mock.callCount(), 1);
    assert.deepEqual(result, { status: 'reserved', remaining: 3 });
  });
});
