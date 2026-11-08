import { it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { connectedScenarios } from '../src/exec/connected-scenarios.ts';
import { executeConnectedScenario } from '../src/exec/scenario-runtime.js';

it('Storage 헬퍼의 반환 객체와 구조 분해 별칭을 보존하고 실제 호출을 관찰한다', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'storage-helper-'));
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  try {
    const file = path.join(root, 'test.mjs');
    fs.writeFileSync(file, `import {test,mock} from 'node:test'; import {save} from './storage.js';
function install() {
  const storage = {getItem:mock.fn(),setItem:mock.fn(),removeItem:mock.fn()};
  globalThis.window = {sessionStorage:storage};
  return {store:storage};
}
test('구조 분해', async () => {
  const {store: actualStorage} = install();
  await save('key','value');
  assert.equal(actualStorage.setItem.mock.callCount(),1);
  assert.deepEqual(actualStorage.setItem.mock.calls[0].arguments,['key','value']);
});
test('객체 반환', async () => {
  const installed = install();
  await save('other','value');
  assert.equal(installed.store.setItem.mock.callCount(),1);
});`);
    const definition = connectedScenarios(file, root);
    const storage = { getItem() { return null; }, setItem(_key: string, _value: string) {}, removeItem() {} };
    const original = storage.setItem;
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { sessionStorage: storage } });
    for (const scenario of definition.scenarios) {
      const result = await executeConnectedScenario({ code: scenario.code, connections: { [scenario.connections[0]]: 'window.sessionStorage' }, values: {}, seed: {} }, [{ save: (key: string, value: string) => storage.setItem(key, value) }], definition.symbols);
      assert.equal(result.status, 'passed', result.reason);
      assert.equal(storage.setItem, original, '실행 후 메서드를 복구해야 한다');
    }
  } finally {
    if (previous) Object.defineProperty(globalThis, 'window', previous); else delete (globalThis as any).window;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it('일반 계산 헬퍼를 객체 연결로 바꾸지 않고 원래 입력으로 실행한다', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'calculation-helper-'));
  try {
    const file = path.join(root, 'test.mjs');
    fs.writeFileSync(file, `import {test} from 'node:test';
const expected = value => 'prefix:' + value;
test('계산', () => {const value = expected('input'); assert.equal(value,'prefix:input');});`);
    const definition = connectedScenarios(file, root);
    const scenario = definition.scenarios[0];
    assert.deepEqual(scenario.connections, []);
    const result = await executeConnectedScenario({ code: scenario.code, connections: {}, values: {}, seed: {} }, [], definition.symbols);
    assert.equal(result.status, 'passed', result.reason);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

it('SHA-256 namespace와 Storage 구조 분해를 함께 변환해 원본 assertion을 검증한다', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'namespace-helper-'));
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
  try {
    const file = path.join(root, 'test.mjs');
    fs.writeFileSync(file, `import {test,mock} from 'node:test';
import {createHash as hash} from 'node:crypto';
import {save} from './storage.js';
function expectedNamespace(clientId) { return \`sha256-\${hash('sha256').update(clientId, 'utf8').digest('hex')}\`; }
function install() {
  const storage = {getItem:mock.fn(),setItem:mock.fn(),removeItem:mock.fn()};
  globalThis.window = {sessionStorage:storage};
  return {storage};
}
test('namespace 저장', async () => {
  const {storage} = install();
  const namespace = expectedNamespace('데모-client');
  await save('데모-client', {access_token:'at-1',refresh_token:'rt-1'});
  assert.equal(storage.setItem.mock.callCount(),2);
  assert.deepEqual(storage.setItem.mock.calls[0].arguments,[\`response:\${namespace}\`,JSON.stringify({access_token:'at-1',refresh_token:'rt-1'})]);
  assert.deepEqual(storage.setItem.mock.calls[1].arguments,[\`token:\${expectedNamespace('데모-client')}\`,'at-1']);
  assert.equal(storage.removeItem.mock.callCount(),0);
});`);
    const definition = connectedScenarios(file, root);
    const scenario = definition.scenarios[0];
    assert.equal(scenario.connections.length, 1);
    assert.ok(!scenario.connections.includes('namespace'));
    const entries = new Map<string, string>();
    const storage = { getItem(key: string) { return entries.get(key) ?? null; }, setItem(key: string, value: string) { entries.set(key, value); }, removeItem(key: string) { entries.delete(key); } };
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { sessionStorage: storage } });
    const modules = [{ async save(id: string, response: {access_token: string}) {
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(id));
      const namespace = 'sha256-' + Buffer.from(digest).toString('hex');
      storage.setItem('response:' + namespace, JSON.stringify(response));
      storage.setItem('token:' + namespace, response.access_token);
    } }];
    const input = { code: scenario.code, connections: { [scenario.connections[0]]: 'window.sessionStorage' }, values: {}, seed: {} };
    const result = await executeConnectedScenario(input, modules, definition.symbols);
    assert.equal(result.status, 'passed', result.reason);
    assert.equal(result.checks.length, 4);
    assert.equal(entries.get('token:sha256-' + createHash('sha256').update('데모-client').digest('hex')), 'at-1');
    const broken = await executeConnectedScenario(input, [{ save() { storage.setItem('wrong-key', 'at-1'); storage.setItem('wrong-key-2', 'at-1'); } }], definition.symbols);
    assert.equal(broken.status, 'failed', '잘못된 저장 키를 통과시키면 안 된다');
    assert.equal(broken.checks[1].passed, false);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'window', previous); else delete (globalThis as any).window;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
