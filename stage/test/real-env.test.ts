// 실환경 검증: mock 테스트의 SUT 호출을 실제 Chrome(진짜 sessionStorage)에서 기준 dist와 배포 후보에 실행해 비교한다.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describeUserAgent, extractScenarios, findBrowsers, runRealEnv } from '../src/exec/real-env.ts';

const w = (root: string, rel: string, body: string) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), body); };
const SAVE = (key: string) => `export function save(r, ns) { if (typeof window === 'undefined') return; window.sessionStorage.setItem('${key}' + (ns ? ':' + ns : ''), JSON.stringify(r)); }\n`;

function fixture(candidateKey = 'k') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-realenv-'));
  w(root, 'dist/save.js', SAVE('k'));
  w(root, 'pkg/save.js', SAVE(candidateKey));
  w(root, 'tests/save.test.mjs', `import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
const { save } = await import('../dist/save.js');
const KEY = 'k';
test('브라우저: 응답을 저장한다', () => {
  const storage = { setItem: mock.fn() };
  globalThis.window = { sessionStorage: storage };
  const response = { a: 1 };
  save(response, 'ns');
  assert.equal(storage.setItem.mock.callCount(), 1);
});
test('서버: window가 없으면 건드리지 않는다', () => {
  globalThis.window = undefined;
  assert.doesNotThrow(() => save({ a: 2 }));
});
test('인자를 정할 수 없으면 건너뛴다', () => {
  const x = mock.fn();
  save(x);
});
`);
  return root;
}

describe('실환경 검증', () => {
  it('테스트에서 SUT 호출·환경·리터럴 인자를 추출한다', () => {
    const root = fixture();
    const ex = extractScenarios(path.join(root, 'tests/save.test.mjs'), path.join(root, 'dist'));
    assert.equal(ex.browserDependent, true);
    assert.deepEqual(ex.scenarios.map((s) => [s.env, s.exportName, s.args.join('|')]), [['browser', 'save', "response|'ns'"], ['server', 'save', '{ a: 2 }']]);
    assert.equal(ex.skipped.length, 1);
    assert.match(ex.skipped[0].reason, /리터럴/);
    fs.rmSync(root, { recursive: true, force: true });
  });

  const chrome = findBrowsers().find((b) => b.kind === 'chromium')?.executable;
  const run = (root: string, env: NodeJS.ProcessEnv = { STAGE_BROWSERS: chrome ?? '' }) => runRealEnv({ testFile: path.join(root, 'tests/save.test.mjs'), fromDir: path.join(root, 'dist'), packageDir: path.join(root, 'pkg'), projectRoot: root, outDir: fs.mkdtempSync(path.join(os.tmpdir(), 'stage-realenv-out-')), signal: new AbortController().signal, timeoutMs: 90_000, env });

  it('실제 브라우저에서 배포 후보가 기준과 같으면 통과하고 실제 저장소 상태를 기록한다', { skip: !chrome }, async () => {
    const root = fixture();
    const r = await run(root);
    assert.equal(r.status, 'passed', r.reason);
    const b = r.scenarios.find((s) => s.env === 'browser')!;
    assert.deepEqual((b.runs[0].cand!.storage as any).sessionStorage, { 'k:ns': '{"a":1}' });
    assert.equal(r.scenarios.find((s) => s.env === 'server')!.verdict, 'pass');
    assert.match(r.reason, /단일 브라우저/);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('여러 브라우저를 각각 실행해 커버리지를 기록하고, 필요한 수에 못 미치면 실패한다', { skip: !chrome }, async () => {
    const root = fixture();
    const two = await run(root, { STAGE_BROWSERS: `${chrome},${chrome}` });
    assert.equal(two.status, 'passed', two.reason);
    assert.equal(two.browsers.length, 2);
    assert.equal(two.scenarios.find((s) => s.env === 'browser')!.runs.length, 2);
    assert.doesNotMatch(two.reason, /단일 브라우저/);
    const need = await run(root, { STAGE_BROWSERS: chrome!, STAGE_MIN_BROWSERS: '2' });
    assert.equal(need.status, 'failed');
    assert.match(need.reason, /STAGE_MIN_BROWSERS/);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('실행할 수 없는 브라우저가 섞이면 실패로 드러낸다', { skip: !chrome }, async () => {
    const root = fixture();
    const bogus = path.join(root, 'fake-browser');
    fs.writeFileSync(bogus, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const r = await run(root, { STAGE_BROWSERS: `${chrome},${bogus}` });
    assert.equal(r.status, 'failed');
    assert.match(r.reason, /fake-browser.*실행 실패/);
    assert.equal(r.browsers.filter((b) => b.ok).length, 1);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('브라우저 탐색·표기: 명시 지정이 자동 탐지를 대체하고 UA에서 이름·버전을 읽는다', () => {
    assert.deepEqual(findBrowsers({ STAGE_BROWSERS: 'manual' }).map((b) => b.kind), ['manual']);
    assert.deepEqual(findBrowsers({ STAGE_BROWSERS: '/no/such/browser' }), []);
    assert.equal(describeUserAgent('Mozilla/5.0 AppleWebKit/537.36 Chrome/156.0.0.0 Safari/537.36 Edg/156.0.1', 'x'), 'Edge 156');
    assert.equal(describeUserAgent('Mozilla/5.0 Gecko/20100101 Firefox/130.0', 'x'), 'Firefox 130');
    assert.equal(describeUserAgent('Mozilla/5.0 AppleWebKit/605.1.15 Version/18.1 Safari/605.1.15', 'x'), 'Safari 18');
  });

  it('배포 후보의 실제 저장 결과가 기준과 다르면 실패한다(mock으로는 드러나지 않는 차이)', { skip: !chrome }, async () => {
    const root = fixture('other-key');
    const r = await run(root);
    assert.equal(r.status, 'failed');
    assert.match(r.reason, /미통과/);
    assert.equal(r.scenarios.find((s) => s.env === 'browser')!.verdict, 'fail');
    fs.rmSync(root, { recursive: true, force: true });
  });
});
