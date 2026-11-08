import { it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { connectedScenarios, connectedConsoleHtml, runConnectedNode } from '../src/exec/connected-scenarios.ts';
import { executeConnectedScenario } from '../src/exec/scenario-runtime.js';
import { createStageServer } from '../src/server.ts';
import { collaboratorChoices } from '../src/exec/connected-console.js';

it('schema 연결은 실제 파싱값 0과 호출 횟수를 검증하고 메서드를 복구한다', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'connected-schema-'));
  try {
    fs.mkdirSync(path.join(root, 'dist'));
    const file = path.join(root, 'test.mjs');
    fs.writeFileSync(file, `import {test, mock} from 'node:test';
const {parseOrDefault} = await import('./dist/index.js');
test('성공한 0', () => {
  const defaultValue = 99;
  const schema = { safeParse: mock.fn(() => ({success: true, data: 0})) };
  const result = parseOrDefault(schema, '0', defaultValue);
  assert.equal(schema.safeParse.mock.callCount(), 1);
  assert.equal(result, 0);
});`);
    const definition = connectedScenarios(file, path.join(root, 'dist'));
    const s = definition.scenarios[0];
    assert.deepEqual(s.presentation.parsing, { functionName: 'parseOrDefault', connection: 'schema', input: '0', fallback: 99 });
    assert.deepEqual(s.presentation.checks, [{ label: '검증 함수 호출 횟수', expected: 1 }, { label: '반환값', expected: 0 }]);
    assert.deepEqual(s.connections, ['schema']);
    assert.doesNotMatch(s.code, /mock\./);
    const schema = { safeParse(data: string) { return { success: true, data: JSON.parse(data) }; } };
    const original = schema.safeParse;
    const m = { schema, parseOrDefault: (s: typeof schema, input: string, fallback: unknown) => { const result = s.safeParse(input); return result.success ? result.data : fallback; } };
    const input = { code: s.code, connections: { schema: 'm.schema' }, values: {}, seed: {} };
    const result = await executeConnectedScenario(input, [m], definition.symbols);
    assert.equal(result.status, 'passed', result.reason);
    assert.equal(result.checks.length, 2);
    assert.equal(schema.safeParse, original);
    const lazy = { get safeParse() { return original; } };
    const lazyResult = await executeConnectedScenario(input, [{ ...m, schema: lazy }], definition.symbols);
    assert.equal(lazyResult.status, 'passed', lazyResult.reason);
    assert.ok(Object.getOwnPropertyDescriptor(lazy, 'safeParse')?.get);
    const bad = await executeConnectedScenario({ ...input, code: s.code.replace('assert.equal(result, 0)', 'assert.equal(result, 99)') }, [m], definition.symbols);
    assert.equal(bad.status, 'failed');
    assert.equal(bad.checks.at(-1).actual, 0);
    assert.equal(bad.checks.at(-1).expected, 99);
    assert.equal(schema.safeParse, original);
    assert.equal((await executeConnectedScenario({ ...input, connections: {} }, [m], definition.symbols)).status, 'failed');
    assert.equal((await executeConnectedScenario({ ...input, code: 'return 0;' }, [m], definition.symbols)).status, 'failed');
    const html = connectedConsoleHtml({ runId: 'r', jobId: 'j', definition });
    assert.doesNotMatch(html, /return Object.keys\(m\)/);
    assert.doesNotThrow(() => new Function([...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].at(-1)![1]));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

it('HTTP mock.method는 실제 전송을 관찰하고 원본 응답 assertion을 실행한다', async () => {
  const received: string[] = [];
  const server = http.createServer((req, res) => { received.push(req.method + ' ' + req.url); res.setHeader('content-type', 'application/json'); res.end('{"items":[1,2]}'); });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'connected-http-'));
  try {
    const port = (server.address() as { port: number }).port;
    fs.mkdirSync(path.join(root, 'dist'));
    fs.writeFileSync(path.join(root, 'dist/index.js'), `export class Client { constructor(url) { this.transport = { request: async ({method, path}) => (await fetch(url + path, {method})).json() }; } get(path) { return this.transport.request({method:'GET', path}); } }`);
    const file = path.join(root, 'test.mjs');
    fs.writeFileSync(file, `import {test,mock} from 'node:test';
const {Client} = await import('./dist/index.js');
const BASE_URL = 'https://api.example.test';
test('GET 실제 응답', async () => {
const client = new Client(BASE_URL);
const request = mock.method(client.transport, 'request', async () => ({items:[1,2]}));
const result = await client.get('/products');
assert.equal(request.mock.callCount(), 1);
assert.deepEqual(result, {items:[1,2]});
});`);
    const definition = connectedScenarios(file, path.join(root, 'dist'));
    assert.equal(definition.scenarios[0].values.BASE_URL, '');
    const input = { code: definition.scenarios[0].code, values: { BASE_URL: `http://127.0.0.1:${port}` }, connections: { transport: '@actual' }, seed: {} };
    const result = await runConnectedNode({ dir: root, console: { modules: ['index.js'], symbols: [], packageDir: path.join(root, 'dist'), projectRoot: root }, scenario: definition, input, signal: new AbortController().signal });
    assert.equal(result.status, 'passed', result.reason);
    assert.deepEqual(received, ['GET /products']);
    assert.equal(result.checks.length, 2);
    const app = createStageServer({ projects: [], dataDir: path.join(root, 'data'), port: 0 });
    const run = { id: 'connected-run', project: { root }, testFile: { path: 'test.mjs' }, replayMode: true, replay: { run: { tests: [] }, redirected: ['index.js'] }, jobs: [{ id: 'j', kind: 'replay', status: 'passed' }], stages: [{}, {}, { status: 'running' }], connected: { jobId: 'j', definition, sequences: {}, results: {} }, realEnv: { scenarios: [], browsers: [], skipped: [], manual: true, live: { dir: root, scenarios: {}, console: { modules: ['index.js'], symbols: [], packageDir: path.join(root, 'dist'), projectRoot: root } } } } as any;
    app.rm.runs.set(run.id, run);
    await app.listen();
    const base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}/api/runs/${run.id}`;
    const post = async (route: string, data = {}) => { const response = await fetch(base + route, { method: 'POST', body: JSON.stringify(data) }); return { status: response.status, body: await response.json() }; };
    try {
      const html = await (await fetch(base + '/live-console')).text();
      assert.match(html, /실제 협력자 시나리오 검증/);
      assert.doesNotMatch(html, /return Object.keys\(m\)/);
      const sign = { operator: '검증 담당', confirm: true };
      assert.equal((await post('/complete-stage3')).status, 400, '확정자 없이는 판정을 확정할 수 없다');
      assert.equal((await post('/complete-stage3', { operator: '검증 담당' })).status, 400, '확인 없이는 판정을 확정할 수 없다');
      assert.equal((await post('/complete-stage3', sign)).status, 409);
      // 서버가 직접 실행하는 경로는 원본 코드와 안전한 연결식만 받는다.
      assert.equal((await post('/connected-scenario', { type: 'node', jobId: 'j', scenarioId: '0', input: { ...input, code: 'process.exit(1)' } })).status, 403);
      assert.equal((await post('/connected-scenario', { type: 'node', jobId: 'j', scenarioId: '0', input: { ...input, connections: { transport: "m.constructor.constructor('return process')()" } } })).status, 403);
      const response = await post('/connected-scenario', { type: 'node', jobId: 'j', scenarioId: '0', input });
      assert.equal(response.status, 200);
      assert.equal(response.body.result.status, 'passed', response.body.result.reason);
      assert.deepEqual(received, ['GET /products', 'GET /products']);
      const recorded = await post('/connected-scenario', { type: 'result', jobId: 'j', scenarioId: '0', sequence: 1, input, result: response.body.result });
      assert.equal(recorded.status, 200);
      // The client must receive the complete updated state, including sequences, to keep polling from remounting its form.
      assert.equal(recorded.body.connected.sequences['0'], 1);
      assert.deepEqual(recorded.body.connected, (await (await fetch(base)).json()).connected);
      assert.equal(app.store.loadRuns()[0].connected.results['0'].result.status, 'passed');
      // 통과 근거 코드를 바꾼 결과는 기록되더라도 판정 확정 근거가 될 수 없다.
      const forged = await post('/connected-scenario', { type: 'result', jobId: 'j', scenarioId: '0', sequence: 2, input: { ...input, code: 'assert.ok(true)' }, result: { status: 'passed', checks: [{ passed: true }] } });
      assert.equal(forged.status, 200);
      assert.equal(forged.body.connected.results['0'].evidence.modified, true);
      const refused = await post('/complete-stage3', sign);
      assert.equal(refused.status, 409);
      assert.match(refused.body.error, /수정/);
      const again = await post('/connected-scenario', { type: 'result', jobId: 'j', scenarioId: '0', sequence: 3, input, result: response.body.result });
      assert.equal(again.body.connected.results['0'].evidence.modified, false);
      const completed = await post('/complete-stage3', sign);
      assert.equal(completed.status, 200, JSON.stringify(completed.body));
      assert.equal(completed.body.stages[2].status, 'passed');
      assert.equal(completed.body.signoff.by, '검증 담당');
      assert.ok(completed.body.signoff.at);
      // 다른 사이트에서 온 요청과 허용되지 않은 Host(DNS rebinding)는 판정 API를 호출할 수 없다.
      const raw = (headers: Record<string, string>) => new Promise<number>((resolve, reject) => {
        const port = (app.server.address() as { port: number }).port;
        const r = http.request({ host: '127.0.0.1', port, path: `/api/runs/${run.id}/complete-stage3`, method: 'POST', headers }, (res) => { res.resume(); resolve(res.statusCode ?? 0); });
        r.on('error', reject); r.end('{}');
      });
      assert.equal(await raw({ origin: 'https://evil.example', host: `127.0.0.1:1` }), 403);
      assert.equal(await raw({ origin: 'https://evil.example' }), 403);
      assert.equal(await raw({ origin: 'null' }), 403);
      assert.equal(await raw({ host: 'rebind.evil.example' }), 403);
      assert.notEqual(await raw({ origin: 'http://localhost:4400' }), 403);
    } finally { await new Promise<void>((resolve) => app.server.close(() => resolve())); }
  } finally { await new Promise<void>((resolve) => server.close(() => resolve())); fs.rmSync(root, { recursive: true, force: true }); }
});

it('객체 검증 선택지는 입력에서 항목·자료형을 읽으며 선택 전 생성자를 실행하지 않는다', () => {
  const module = {
    buildRules() { throw new Error('선택 전 실행 금지'); },
    numeric() { throw new Error('선택 전 실행 금지'); },
  };
  const scenario = {
    presentation: { parsing: { connection: 'schema', input: { id: 1, name: 'card', enabled: true } } },
    factories: [
      { name: 'buildRules', expression: 'modules[0]["buildRules"]', schema: { kind: 'object' }, fields: { nameKey: 'key', typeKey: 'rule', types: ['number', 'text'] } },
      { name: 'numeric', expression: 'modules[0]["numeric"]', schema: { kind: 'number', coerce: true }, callableWithoutArguments: true },
    ],
  };
  const choices = collaboratorChoices(module, scenario, 'schema');
  assert.deepEqual(choices[0].fields, [{ name: 'id', type: 'number' }, { name: 'name', type: 'text' }, { name: 'enabled', type: '' }]);
  assert.equal(choices[0].expression, '');
  assert.equal(choices[0].fieldContract.nameKey, 'key');
  assert.equal(choices[0].fieldContract.typeKey, 'rule');
  assert.equal(choices[1].label, '숫자 변환 검증 · numeric');
  assert.equal(choices[1].expression, 'modules[0]["numeric"]()');
});
