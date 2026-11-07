import { it } from 'node:test';
import assert from 'node:assert/strict';

function add(a: number, b: number) { return a + b; }

it('only exercises a local helper', () => {
  assert.equal(add(1, 2), 3);
});
