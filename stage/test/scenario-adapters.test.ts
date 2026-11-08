import { it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { connectedScenarios } from '../src/exec/connected-scenarios.ts';
import { executeConnectedScenario } from '../src/exec/scenario-runtime.js';
import { ScenarioTargets } from '../src/exec/scenario-targets.ts';

it('Hook 호출을 하나의 실제 root에 mount·rerender하고 원본 assertion을 유지한다', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hook-adapter-'));
  try {
    const file = path.join(root, 'test.mjs');
    fs.writeFileSync(path.join(root, 'view.js'), `import {useEffect} from 'react'; export function useView(props) { useEffect(() => {}, [props]); }`);
    fs.writeFileSync(file, `import {test,mock} from 'node:test';
import {useView} from './view.js';
function installReact() { return {useEffect:mock.fn(),useRef:mock.fn()}; }
test('두 번 렌더링',()=>{const react=installReact();useView({route:'/a'});useView({route:'/b'});assert.equal(react.useEffect.mock.callCount(),2);});`);
    const scenario = connectedScenarios(file, root).scenarios[0];
    assert.equal(scenario.connectionRoles.react, 'react');
    assert.match(scenario.code, /await mountHook\(props => useView\(props\), \{route:'\/a'\}\)/);
    assert.match(scenario.code, /await __hook.rerender\(\{route:'\/b'\}\)/);
    assert.match(scenario.code, /assert.equal\(react.useEffect.observed.callCount\(\),2\)/);
    assert.doesNotMatch(scenario.code, /mock\./);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

it('실제 난수 반환값을 기대식에 연결하며 전역 메서드를 복구한다', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'random-adapter-'));
  const original = Math.random;
  try {
    const file = path.join(root, 'test.mjs');
    fs.writeFileSync(file, `import {test,mock} from 'node:test';import {randomValue} from './random.js';
test('반환값 전달',()=>{const random=mock.method(Math,'random',()=>0.5);const result=randomValue();assert.equal(result,0.5);assert.equal(random.mock.callCount(),1);});`);
    const definition = connectedScenarios(file, root);
    const scenario = definition.scenarios[0];
    const result = await executeConnectedScenario({ code: scenario.code, connections: { Math: 'Math' }, values: {}, seed: {} }, [{ randomValue: () => Math.random() }], definition.symbols);
    assert.equal(result.status, 'passed', result.reason);
    assert.equal(result.checks[0].actual, result.checks[0].expected);
    assert.equal(Math.random, original);
    assert.match(scenario.adaptations.join('\n'), /실제 호출에서 관찰한 반환값/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

it('SSE 직접 이벤트 호출을 실제 서버 수신 대기로 바꾸고 원본 payload를 보존한다', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sse-adapter-'));
  try {
    const file = path.join(root, 'test.mjs');
    fs.writeFileSync(file, `import{test,mock}from'node:test';import{createSseClient}from'./sse.js';const STREAM_URL='https://example.test/stream';
function install(){const C=mock.fn();globalThis.window={EventSource:C};return C;}
test('수신',()=>{const EventSourceMock=install();const client=createSseClient({url:STREAM_URL});client.connect();const source=EventSourceMock.mock.calls[0].result;source.listeners.message({data:'not-json'});assert.equal(client.getStatus(),'open');});`);
    const scenario = connectedScenarios(file, root).scenarios[0];
    assert.equal(scenario.network?.kind, 'sse');
    assert.match(scenario.code, /observeEventSource\(await connect\("eventSource"\)\)/);
    assert.match(scenario.code, /await receiveSse\(source, \(\{data:'not-json'\}\).data\)/);
    assert.doesNotMatch(scenario.code, /source.listeners|mock\./);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

it('로컬 HTTP/SSE 서버는 실제 소켓으로 응답·이벤트를 보내고 정리된다', async () => {
  const targets = new ScenarioTargets();
  try {
    const http = await targets.create('run', { kind: 'http', valueKey: 'BASE_URL', response: { items: [1, 2] }, envelope: ['Individual', 'OutData'], method: 'GET', path: '/products' }, 'http://localhost:4400');
    assert.deepEqual(await (await fetch(http.url + '/products')).json(), { Individual: { OutData: { items: [1, 2] } } });
    assert.deepEqual(targets.close('run', http.id).requests.map(r => [r.method, r.path]), [['GET', '/products']]);
    const failure = await targets.create('run', { kind: 'http', valueKey: 'BASE_URL', failure: true }, 'http://localhost:4400');
    await assert.rejects(fetch(failure.url));
    targets.close('run', failure.id);
    const sse = await targets.create('run', { kind: 'sse', valueKey: 'STREAM_URL' }, 'http://localhost:4400');
    const response = await fetch(sse.url);
    assert.equal(response.headers.get('content-type'), 'text/event-stream');
    assert.equal(response.headers.get('access-control-allow-origin'), 'http://localhost:4400');
    const reader = response.body!.getReader();
    await reader.read();
    targets.emit('run', sse.id, '{"type":"order","payload":{"id":7}}');
    assert.equal(new TextDecoder().decode((await reader.read()).value), 'data: {"type":"order","payload":{"id":7}}\n\n');
    assert.deepEqual(targets.close('run', sse.id).events, ['{"type":"order","payload":{"id":7}}']);
    await reader.cancel();
    assert.throws(() => targets.emit('run', sse.id, 'late'), /수신자/);
  } finally { targets.dispose(); }
});
