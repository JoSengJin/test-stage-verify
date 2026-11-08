// 3단계 가상 화면: 생성 코드, 실제 호출 프록시(허용 호스트·변경 요청 차단·헤더 주입·기록), 번들.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createStageServer } from '../src/server.ts';
import { generateHookSource, isPlayable } from '../src/playground/source.ts';
import { defaultProfileDoc } from '../src/profiles.ts';
import type { WiringCall } from '../src/model.ts';
import { SAMPLE } from './helpers.ts';

const loc = { file: 't', line: 1, column: 1 };
const call: WiringCall = {
  id: 'wt1.c1', sut: 'useApiManualCall', specifier: 'base-framework/lib/http/react', path: '/orders', loc,
  hook: true, clientFactory: {specifier:'custom-sdk/transport',exportName:'buildClient'},
  options: [
    { key: 'client', kind: 'double', source: 'client' },
    { key: 'method', kind: 'literal', value: 'POST', source: "'POST'" },
    { key: 'beforeTransaction', kind: 'literal', value: { path: '/pre', method: 'GET' }, source: '{...}' },
    { key: 'errorHandling', kind: 'literal', value: false, source: 'false' },
    { key: 'onSuccess', kind: 'double', source: 'onSuccess: mock.fn()' },
    { key: 'mapRequest', kind: 'double', source: 'mapRequest: mock.fn(r => r)' },
    { key: 'onFailure', kind: 'function', source: '() => {}' },
    { key: '...callbacks', kind: 'other', source: '...callbacks' },
  ],
  collaborators: [],
};

describe('가상 화면 코드 생성', () => {
  const src = generateHookSource({ call, testTitle: '성공 시 순서', sessionId: 'abc' });

  it('Hook만 가상 화면 대상이고 클래스는 아니다', () => {
    assert.equal(isPlayable(call), true);
    assert.equal(isPlayable({ hook: false }), false);
  });

  it('실제 클라이언트를 프록시 주소로 만들고 공개 API를 import한다', () => {
    // 실제 클라이언트는 앞이 /인 경로의 baseUrl 경로를 버리므로 세션은 경로가 아니라 헤더로 식별한다.
    assert.match(src, /import \{ buildClient as createStageClient \} from \"custom-sdk\/transport\"/);
    assert.doesNotMatch(src, /base-framework\/lib\/http';/);
    assert.match(src, /baseUrl: window\.__STAGE_ORIGIN__ \|\| location\.origin,/);
    assert.match(src, /defaultHeaders: \{ 'x-stage-session': "abc" \}/);
    assert.match(src, /import \{ useApiManualCall \} from 'base-framework\/lib\/http\/react'/);
    assert.match(src, /useApiManualCall\("\/orders", \{/);
  });

  it('고정 옵션은 그대로, 콜백은 스파이로, 값을 돌려줘야 하는 대체 함수는 주석으로 남긴다', () => {
    assert.match(src, /method: "POST",/);
    assert.match(src, /beforeTransaction: \{ path: "\/pre", method: "GET" \},/);
    assert.match(src, /errorHandling: false,/);
    assert.match(src, /onSuccess: spy\('onSuccess'\),/);
    assert.match(src, /\/\/ mapRequest: 원본 테스트는 대체 객체를 넘겼습니다/);
    assert.match(src, /onFailure: \(\) => \{\},/);
    assert.match(src, /\/\/ \.\.\.callbacks: 해석하지 못한 옵션/);
  });

  it('client 옵션이 없던 호출에도 실제 client를 주입한다', () => {
    const s = generateHookSource({ call: { ...call, options: [{ key: 'method', kind: 'literal', value: 'GET', source: "'GET'" }], collaborators: [] }, testTitle: 't', sessionId: '1' });
    assert.match(s, /\n    client,\n    method: "GET",/);
  });
});

describe('가상 화면 프록시와 번들', () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-pg-'));
  const seen: { method?: string; url?: string; auth?: string; body: string }[] = [];
  const upstream = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body });
    res.writeHead(201, { 'content-type': 'application/json', 'x-up': '1' });
    res.end(JSON.stringify({ ok: true }));
  });
  let upPort = 0;
  let base = '';
  let stage: ReturnType<typeof createStageServer>;

  const j = async (method: string, p: string, b?: unknown) => {
    const r = await fetch(`${base}${p}`, { method, headers: { 'content-type': 'application/json' }, body: b === undefined ? undefined : JSON.stringify(b) });
    return { status: r.status, json: (await r.json().catch(() => null)) as any, headers: r.headers };
  };
  /** 가상 화면의 실제 클라이언트처럼 세션 헤더를 달아 임의 경로로 요청한다. */
  const px = async (method: string, id: string, p: string, b?: unknown) => {
    const r = await fetch(`${base}${p}`, { method, headers: { 'content-type': 'application/json', 'x-stage-session': id }, body: b === undefined ? undefined : JSON.stringify(b) });
    return { status: r.status, json: (await r.json().catch(() => null)) as any, headers: r.headers };
  };
  const saveProfile = (over: object) => j('PUT', '/api/profiles', {
    project: SAMPLE,
    doc: { ...defaultProfileDoc(), active: 'stage', profiles: [
      { name: 'mock', mode: 'mock', allowMutations: true },
      { name: 'stage', mode: 'stage', baseUrl: `http://127.0.0.1:${upPort}/api`, allowedHosts: [`127.0.0.1:${upPort}`], allowMutations: false, headers: { Authorization: { env: 'UP_TOKEN', prefix: 'Bearer ' } }, ...over },
    ] },
  });

  it('서버 준비', async () => {
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', () => r()));
    upPort = (upstream.address() as any).port;
    stage = createStageServer({ projects: [SAMPLE], dataDir, port: 0, env: { ...process.env, UP_TOKEN: 'sekret-token-value' } });
    await stage.listen();
    base = `http://127.0.0.1:${(stage.server.address() as any).port}`;
  });

  it('허용된 Stage 대상의 조회는 보내고 헤더를 서버에서 채우며 비밀은 기록에서 가린다', async () => {
    assert.equal((await saveProfile({})).status, 200);
    const s = (await j('POST', '/api/playground', { project: SAMPLE })).json;
    assert.equal(s.mode, 'stage');
    assert.equal(s.check.ok, true);
    const r = await px('GET', s.id, '/orders/1?x=1');
    assert.equal(r.status, 201);
    assert.equal(r.headers.get('access-control-allow-origin'), '*');
    assert.equal(r.headers.get('x-up'), '1');
    assert.deepEqual(r.json, { ok: true });
    assert.equal(seen.at(-1)?.url, '/api/orders/1?x=1');
    assert.equal(seen.at(-1)?.auth, 'Bearer sekret-token-value');
    const log = (await j('GET', `/api/playground/${s.id}/log`)).json;
    assert.equal(log[0].status, 201);
    assert.equal(log[0].requestHeaders.authorization, undefined);
    assert.equal(JSON.stringify(log).includes('sekret-token-value'), false);
  });

  it('변경 요청 허용이 꺼져 있으면 보내지 않는다', async () => {
    const before = seen.length;
    const s = (await j('POST', '/api/playground', { project: SAMPLE })).json;
    const r = await px('POST', s.id, '/orders', { sku: 'A' });
    assert.equal(r.status, 403);
    assert.match(r.json.message, /허용되지 않음/);
    assert.equal(seen.length, before);
    await saveProfile({ allowMutations: true });
    const s2 = (await j('POST', '/api/playground', { project: SAMPLE })).json;
    assert.equal((await px('POST', s2.id, '/orders', { sku: 'A' })).status, 201);
    assert.equal(seen.at(-1)?.body, '{"sku":"A"}');
  });

  it('허용 호스트에 없으면 보내지 않고, 환경변수가 없으면 보내지 않는다', async () => {
    const before = seen.length;
    await saveProfile({ allowedHosts: ['stage.example.com'] });
    const s = (await j('POST', '/api/playground', { project: SAMPLE })).json;
    assert.equal(s.check.ok, false);
    const r = await px('GET', s.id, '/orders/1');
    assert.equal(r.status, 403);
    assert.match(r.json.message, /허용 호스트/);
    await saveProfile({ headers: { Authorization: { env: 'NOT_SET_ANYWHERE' } } });
    const s2 = (await j('POST', '/api/playground', { project: SAMPLE })).json;
    const r2 = await px('GET', s2.id, '/orders/1');
    assert.equal(r2.status, 412);
    assert.equal(seen.length, before);
  });

  it('테스트 대체 객체로 바인딩하면 stage.config.json의 mock 응답으로 답하고 서버로 나가지 않는다', async () => {
    await saveProfile({});
    const before = seen.length;
    const s = (await j('POST', '/api/playground', { project: SAMPLE, binding: 'double' })).json;
    assert.equal(s.mode, 'mock');
    const r = await px('GET', s.id, '/orders/ord-1');
    assert.equal(r.status, 200);
    assert.equal(r.json.status, 'created');
    assert.equal((await px('GET', s.id, '/nothing')).status, 404);
    assert.equal(seen.length, before);
  });

  it('등록되지 않은 프로젝트·없는 세션을 거부한다', async () => {
    assert.equal((await j('POST', '/api/playground', { project: os.tmpdir() })).status, 404);
    assert.equal((await px('GET', 'nope', '/x')).status, 404);
    // 세션 헤더가 없으면 일반 경로로 처리되고, 있으면 스테이지 자신의 /api 경로와 같은 경로도 프록시가 받는다.
    const s = (await j('POST', '/api/playground', { project: SAMPLE })).json;
    await saveProfile({ allowMutations: true });
    const s2 = (await j('POST', '/api/playground', { project: SAMPLE })).json;
    assert.equal((await px('GET', s2.id, '/api/runs')).status, 201);
    assert.equal(seen.at(-1)?.url, '/api/api/runs');
    assert.ok(Array.isArray((await j('GET', '/api/runs')).json));
    assert.ok(s.id);
  });

  it('CORS 사전 요청(preflight)에 세션 헤더를 허용한다', async () => {
    const r = await fetch(`${base}/orders`, { method: 'OPTIONS', headers: { origin: 'null', 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type,x-stage-session' } });
    assert.equal(r.status, 204);
    assert.equal(r.headers.get('access-control-allow-origin'), '*');
    assert.match(r.headers.get('access-control-allow-headers') ?? '', /x-stage-session/);
  });

  it('번들: 프로젝트 기준으로 빌드하고 문법 오류는 위치와 함께 돌려준다', async () => {
    const s = (await j('POST', '/api/playground', { project: SAMPLE })).json;
    const ok = (await j('POST', `/api/playground/${s.id}/bundle`, { code: 'window.__x = 1;' })).json;
    assert.match(ok.js, /__x = 1/);
    const withReact = (await j('POST', `/api/playground/${s.id}/bundle`, { code: "import React from 'react'; import { createRoot } from 'react-dom/client'; window.__r = [React.version, typeof createRoot];" })).json;
    assert.match(withReact.js, /19\.2\.7/); // 이 도구의 react(19.2.7)로 번들된다
    const bad = (await j('POST', `/api/playground/${s.id}/bundle`, { code: 'const = ;' })).json;
    assert.ok(bad.errors.length > 0);
    assert.equal(bad.errors[0].line, 1);
  });

  it('빌드한 화면을 HTML로 내려주고, 빌드 전에는 404를 돌려준다', async () => {
    const s = (await j('POST', '/api/playground', { project: SAMPLE })).json;
    assert.equal((await fetch(`${base}/api/playground/${s.id}/frame`)).status, 404);
    await j('POST', `/api/playground/${s.id}/bundle`, { code: 'window.__y = "</script>";' });
    const r = await fetch(`${base}/api/playground/${s.id}/frame`);
    assert.equal(r.status, 200);
    const html = await r.text();
    assert.match(html, /<div id="root"><\/div>/);
    assert.match(html, /unhandledrejection/);
    assert.ok(html.includes(`window.__STAGE_ORIGIN__=${JSON.stringify(base)}`));
    assert.equal((html.match(/<\/script>/g) ?? []).length, 2); // 번들 안의 </script>는 이스케이프되어 문서를 깨지 않는다
  });

  it('정리', () => {
    stage.server.close();
    upstream.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
});
