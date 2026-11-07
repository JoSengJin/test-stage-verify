// 실물 연결 구성 추출과 연결 프로필 검증.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { extractWiring } from '../src/analysis/wiring.ts';
import { checkTarget, defaultProfileDoc, normalizeProfileDoc } from '../src/profiles.ts';
import type { ImportInfo } from '../src/model.ts';

const SPEC = 'base-framework/lib/http/react';
const SOURCE = `
import { afterEach, describe, mock, test } from 'node:test';
const { useApiManualCall, useGetApiCall } = await import('${SPEC}');
function createRecorder() { const log = []; const fn = (name, impl) => mock.fn(async (...a) => { log.push(name); return impl?.(...a); }); return { log, fn }; }
function createClientMock(rec, o = {}) { return { get: rec.fn('get'), post: rec.fn('post'), put: rec.fn('put'), ...o }; }
function createCallbackMocks(rec) { return { onBefore: rec.fn('onBefore'), onSuccess: rec.fn('onSuccess') }; }
describe('수명주기', () => {
  test('성공', async () => {
    const rec = createRecorder();
    const client = createClientMock(rec);
    const callbacks = createCallbackMocks(rec);
    renderHook(() => useApiManualCall('/orders', { client, method: 'POST', ...callbacks }));
  });
  test('전후 거래와 전역 alert', async () => {
    const client = { post: mock.fn() };
    globalThis.alert = mock.fn();
    renderHook(() => useApiManualCall('/orders', { client, method: 'POST', errorHandling: false, beforeTransaction: { path: '/pre', method: 'GET' }, onFailure: () => {} }));
  });
});
test('자동 전송', () => {
  const client = createClientMock(createRecorder());
  renderHook(() => useGetApiCall('/orders', { client, params: { page: 1 }, enabled: false }));
});
`;

const imports: ImportInfo[] = [
  { specifier: 'node:test', kind: 'static', role: 'test-tool', names: ['test'], loc: { file: 't', line: 1, column: 1 }, evidence: '' },
  { specifier: SPEC, kind: 'dynamic', role: 'public-package', names: [], loc: { file: 't', line: 2, column: 1 }, evidence: '' },
];

describe('실물 연결 구성 추출', () => {
  const sf = ts.createSourceFile('x.test.mjs', SOURCE, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const w = extractWiring(sf, imports, (f) => f)!;

  it('동적 import로 받은 공개 API를 SUT로 인식한다', () => {
    assert.deepEqual(w.sut.map((s) => s.name).sort(), ['useApiManualCall', 'useGetApiCall']);
    assert.equal(w.tests.length, 3);
  });

  it('보조 함수가 만든 client·콜백 대체 객체를 협력자로 분류한다', () => {
    const c = w.tests[0].calls[0];
    assert.equal(c.path, '/orders');
    const byOption = Object.fromEntries(c.collaborators.map((k) => [k.option, k]));
    assert.equal(byOption.client.role, 'http-client');
    assert.deepEqual(byOption.client.methods, ['get', 'post', 'put']);
    assert.equal(byOption.onBefore.role, 'observer');
    assert.equal(byOption.onSuccess.role, 'observer');
    assert.deepEqual(c.options.find((o) => o.key === 'method'), { key: 'method', kind: 'literal', value: 'POST', source: "'POST'" });
  });

  it('고정 옵션·인라인 함수·전역 대체를 구분한다', () => {
    const t = w.tests[1];
    const c = t.calls[0];
    assert.equal(c.collaborators.length, 1);
    assert.equal(c.collaborators[0].option, 'client');
    assert.deepEqual(c.options.find((o) => o.key === 'beforeTransaction')?.value, { path: '/pre', method: 'GET' });
    assert.equal(c.options.find((o) => o.key === 'errorHandling')?.value, false);
    assert.equal(c.options.find((o) => o.key === 'onFailure')?.kind, 'function');
    assert.deepEqual(t.globals, ['alert']);
  });

  it('describe 밖의 테스트와 파일 수준 보조 함수도 처리한다', () => {
    const c = w.tests[2].calls[0];
    assert.equal(c.sut, 'useGetApiCall');
    assert.equal(c.collaborators[0].role, 'http-client');
    assert.equal(w.needsHttpClient, true);
  });

  it('공개 API import가 없으면 구성을 만들지 않는다', () => {
    assert.equal(extractWiring(sf, [imports[0]], (f) => f), undefined);
  });
});

describe('연결 프로필', () => {
  const stage = (over: object = {}) => normalizeProfileDoc({ ...defaultProfileDoc(), active: 'stage', profiles: [{ name: 'stage', mode: 'stage', baseUrl: 'https://stage.example.com/api/', allowedHosts: ['Stage.Example.com'], ...over }] });

  it('기본 문서는 mock·stage 프로필을 갖고 stage는 허용 호스트가 없어 전송이 차단된다', () => {
    const d = normalizeProfileDoc(defaultProfileDoc());
    assert.deepEqual(d.profiles.map((p) => p.name), ['mock', 'stage']);
    const s = d.profiles[1];
    assert.equal(checkTarget(s).ok, false);
    assert.equal(checkTarget(d.profiles[0]).ok, true);
  });

  it('허용 호스트에 있는 Stage 대상만 통과시키고 baseUrl 끝 슬래시를 정리한다', () => {
    const p = stage().profiles[0];
    assert.equal(p.baseUrl, 'https://stage.example.com/api');
    assert.deepEqual(checkTarget(p), { ok: true, host: 'stage.example.com' });
    const other = stage({ baseUrl: 'https://api.prod.example.com' }).profiles[0];
    assert.equal(checkTarget(other).ok, false);
  });

  it('비밀 값 직접 저장, 계정 정보가 든 URL, 잘못된 모드를 거부한다', () => {
    assert.throws(() => stage({ headers: { Authorization: { value: 'Bearer abc' } } }), /비밀 값/);
    assert.doesNotThrow(() => stage({ headers: { Authorization: { env: 'STAGE_TOKEN' }, 'X-Client': { value: 'stage' } } }));
    assert.throws(() => stage({ baseUrl: 'https://user:pw@stage.example.com' }), /계정 정보/);
    assert.throws(() => stage({ mode: 'prod' }), /mode/);
    assert.throws(() => stage({ allowedHosts: ['bad host'] }), /형식/);
  });

  it('바인딩 값과 활성 프로필을 정규화한다', () => {
    const d = normalizeProfileDoc({ ...defaultProfileDoc(), active: '없는이름', bindings: { 'wt1.c1.client': 'real' } });
    assert.equal(d.active, 'mock');
    assert.throws(() => normalizeProfileDoc({ ...defaultProfileDoc(), bindings: { x: 'maybe' } }), /real 또는 double/);
  });
});
