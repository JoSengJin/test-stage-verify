// 실환경 검증: mock 테스트의 SUT 호출을 실제 Chrome(진짜 sessionStorage)에서 기준 dist와 배포 후보에 실행해 비교한다.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import vm from 'node:vm';
import { describeUserAgent, extractScenarios, findBrowsers, liveConsoleHtml, liveFrameHtml, maskVolatile, runRealEnv } from '../src/exec/real-env.ts';

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
    // 직접 실행: 브라우저 시나리오만 노출하고, 번들 파일이 실제로 있으며, 프레임 HTML의 스크립트가 문법상 유효하다.
    const live = r.live!;
    assert.deepEqual(Object.keys(live.scenarios), [b.id]);
    assert.ok(fs.existsSync(path.join(live.dir, `C${live.scenarios[b.id].mods[0]}.js`)));
    const html = await liveFrameHtml({ runId: 'r1', sc: live.scenarios[b.id], argsText: "response, 'x'", seedText: '{"old":"1"}' });
    assert.match(html, /live-file\/C0\.js/);
    const inline = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].pop()![1];
    assert.doesNotThrow(() => new Function(inline));
    assert.match(await liveFrameHtml({ runId: 'r1', sc: live.scenarios[b.id], argsText: 'x</script><b>' }), /&lt;\/script&gt;|x&lt;\/script/);
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

  describe('mock 협력자를 실제 협력자로 치환', () => {
    const fx = () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-realenv2-'));
      w(root, 'dist/lib.js', `export const util = { echo(v) { return { v, t: new Date(Date.now()).toISOString() }; } };
export function createLogger(o) { return { info(m) { console.info('[info] ' + m, { lvl: o.lvl }); return m; } }; }
export class Client { constructor(base) { this.base = base; this.transport = { request: async () => ({ data: 1 }) }; } async get(p) { return (await this.transport.request({ url: this.base + p })).data; } }
export function parseOrNull(schema, v) { const r = schema.safeParse(v); return r.success ? r.data : null; }
export const okSchema = { safeParse: (v) => (typeof v === 'string' ? { success: true, data: v } : { success: false }) };
export function makeId() { return 'id-' + Date.now(); }
`);
      w(root, 'tests/a.test.mjs', `import { test, mock } from 'node:test';
const { util, createLogger, Client, parseOrNull, makeId } = await import('../dist/lib.js');
const LVL = 'dev';
test('객체 메서드', () => { util.echo('x'); });
test('팩토리 인스턴스', () => { const logger = createLogger({ lvl: LVL }); const info = mock.method(console, 'info', () => {}); logger.info('hi'); });
test('가짜 스키마', () => { const schema = { safeParse: mock.fn(() => ({ success: true, data: 1 })) }; parseOrNull(schema, 'abc'); });
test('인스턴스를 mock', async () => { const c = new Client('http://x'); mock.method(c.transport, 'request', async () => ({ data: 2 })); await c.get('/p'); });
test('결과값 변수', () => { const id = makeId(); });
`);
      return root;
    };
    it('메서드 호출·인스턴스·가짜 스키마를 추출하고, 인스턴스 mock은 직접 호출로 넘긴다', () => {
      const root = fx();
      const ex = extractScenarios(path.join(root, 'tests/a.test.mjs'), path.join(root, 'dist'));
      const sig = ex.scenarios.map((s) => `${s.testName}:${s.env}:${s.exportName}(${s.args.join(',')})${s.setup ? '+' + s.setup.map((t) => t.kind + ':' + t.exportName).join('|') : ''}`);
      assert.deepEqual(sig, [
        "객체 메서드:server:util.echo('x')",
        "팩토리 인스턴스:server:logger.info('hi')+call:createLogger",
        "가짜 스키마:server:parseOrNull(__REAL_SCHEMA__,'abc')",
        '결과값 변수:server:makeId()',
      ]);
      assert.equal(ex.skipped.length, 1);
      assert.match(ex.skipped[0].reason, /직접 호출/);
      assert.deepEqual(ex.modules, ['lib.js']);
      fs.rmSync(root, { recursive: true, force: true });
    });
    it('실제 협력자로 실행해 console 호출·실제 스키마 결과를 관찰하고, 시각 같은 변동 값은 가려 비교한다', async () => {
      const root = fx();
      const r = await runRealEnv({ testFile: path.join(root, 'tests/a.test.mjs'), fromDir: path.join(root, 'dist'), packageDir: path.join(root, 'dist'), projectRoot: root, outDir: fs.mkdtempSync(path.join(os.tmpdir(), 'stage-realenv-out-')), signal: new AbortController().signal, timeoutMs: 60_000, env: {} });
      assert.equal(r.status, 'passed', r.reason);
      assert.equal(r.manual, true);
      const by = (name: string) => r.scenarios.find((x) => x.testName === name)!;
      assert.deepEqual(by('팩토리 인스턴스').runs[0].cand!.calls, [['console', 'info', '[info] hi', { lvl: 'dev' }]]);
      assert.deepEqual(Object.keys(by('가짜 스키마').runs[0].cand!.variants!), ['okSchema']);
      assert.equal(by('객체 메서드').verdict, 'pass');
      fs.rmSync(root, { recursive: true, force: true });
    });
    it('배포 후보가 실제 협력자 기준 결과와 다르면 실패한다', async () => {
      const root = fx();
      w(root, 'pkg/lib.js', fs.readFileSync(path.join(root, 'dist/lib.js'), 'utf8').replace("'[info] '", "'[INFO] '"));
      const r = await runRealEnv({ testFile: path.join(root, 'tests/a.test.mjs'), fromDir: path.join(root, 'dist'), packageDir: path.join(root, 'pkg'), projectRoot: root, outDir: fs.mkdtempSync(path.join(os.tmpdir(), 'stage-realenv-out-')), signal: new AbortController().signal, timeoutMs: 60_000, env: {} });
      assert.equal(r.status, 'failed');
      assert.equal(r.scenarios.find((x) => x.testName === '팩토리 인스턴스')!.verdict, 'fail');
      fs.rmSync(root, { recursive: true, force: true });
    });
    it('자동 재현할 호출이 하나도 없으면 실패가 아니라 직접 호출 모드가 된다', async () => {
      const root = fx();
      w(root, 'tests/b.test.mjs', `import { test, mock } from 'node:test';
const { Client } = await import('../dist/lib.js');
test('x', async () => { const c = new Client('http://x'); mock.method(c.transport, 'request', async () => ({})); await c.get('/p'); });
`);
      const r = await runRealEnv({ testFile: path.join(root, 'tests/b.test.mjs'), fromDir: path.join(root, 'dist'), packageDir: path.join(root, 'dist'), projectRoot: root, outDir: fs.mkdtempSync(path.join(os.tmpdir(), 'stage-realenv-out-')), signal: new AbortController().signal, timeoutMs: 60_000, env: {} });
      assert.equal(r.status, 'passed');
      assert.equal(r.manual, true);
      assert.equal(r.scenarios.length, 0);
      assert.deepEqual(r.live!.console!.modules, ['lib.js']);
      const html = liveConsoleHtml({ runId: 'r1', symbols: r.live!.console!.symbols });
      assert.match(html, /live-console\.js/);
      assert.match(html, /m\.Client/);
      assert.doesNotThrow(() => new Function([...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].pop()![1]));
      fs.rmSync(root, { recursive: true, force: true });
    });
    it('직접 호출에서 export 조회와 실제 HTTP 응답·실패를 구분한다', async () => {
      const received: string[] = [];
      const server = http.createServer((req, res) => {
        received.push(req.method + ' ' + req.url);
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end('{"data":{"items":[1,2]}}');
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address() as { port: number };
      const url = `http://127.0.0.1:${address.port}/products`;
      const elements = { out: { textContent: '' }, st: { textContent: '' }, code: { value: 'return Object.keys(m);', addEventListener() {} }, run: { disabled: false, onclick: null as any } };
      const window = { addEventListener() {}, fetch, __stageM: { Client: class {} } };
      const html = liveConsoleHtml({ runId: 'r1', symbols: [] });
      const script = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].pop()![1];
      const context = vm.createContext({ window, console: { ...console }, sessionStorage: {}, document: { getElementById: (id: string) => elements[id] } });
      try {
        vm.runInContext(script, context);
        await elements.run.onclick();
        assert.match(elements.out.textContent, /관찰된 HTTP 요청 0건/);
        assert.deepEqual(received, []);
        elements.code.value = `return (await window.fetch(${JSON.stringify(url)}, { method: 'POST' })).json();`;
        await elements.run.onclick();
        assert.deepEqual(received, ['POST /products']);
        assert.match(elements.out.textContent, /"상태": 201/);
        assert.match(elements.out.textContent, /"메서드": "POST"/);
        assert.match(elements.out.textContent, /products/);
        elements.code.value = 'await window.fetch("http://127.0.0.1:1/unreachable");';
        await elements.run.onclick();
        assert.match(elements.out.textContent, /전송 실패/);
        assert.equal(elements.run.disabled, false);
        elements.code.value = 'return Object.keys(m);';
        await elements.run.onclick();
        assert.match(elements.out.textContent, /관찰된 HTTP 요청 0건/);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    });
    it('시각·UUID·난수 문자열을 가린다', () => {
      assert.equal(maskVolatile('{"t":"2026-11-07T14:15:04.757Z","u":"aea9e02e-c62c-44b3-845c-e3e0c8247cea","c":"corr-lo9x-ab12","e":1700000000000}'), '{"t":"<ts>","u":"<uuid>","c":"corr-<t>-<r>","e":<epoch>}');
    });
  });
});
