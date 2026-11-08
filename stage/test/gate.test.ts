// 운영 게이트 보호 장치 회귀: 출처 검사, 서버 실행 연결식 제한, 판정 우회 차단.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { hostAllowed, isSafeConnectionExpression, originAllowed } from '../src/gate.ts';

describe('Host·Origin 검사', () => {
  it('루프백 Host만 기본 허용하고 외부 이름(DNS rebinding)은 거부한다', () => {
    for (const h of ['localhost:4400', '127.0.0.1:4400', '[::1]:4400', 'LOCALHOST']) assert.equal(hostAllowed(h), true, h);
    for (const h of ['rebind.evil.example', 'evil.example:4400', undefined, '']) assert.equal(hostAllowed(h), false, String(h));
    assert.equal(hostAllowed('stage.corp.example:4400', ['stage.corp.example']), true);
  });
  it('Origin이 없으면(서버·CLI) 허용, null·타 사이트는 거부한다', () => {
    assert.equal(originAllowed(undefined), true);
    assert.equal(originAllowed('http://localhost:4400'), true);
    assert.equal(originAllowed('http://127.0.0.1:4400'), true);
    assert.equal(originAllowed('null'), false);
    assert.equal(originAllowed('https://evil.example'), false);
    assert.equal(originAllowed('not a url'), false);
  });
});

describe('서버에서 실행할 연결식 검사', () => {
  it('배포 모듈·전역 API 참조와 호출은 허용한다', () => {
    for (const e of ['@actual', 'console', 'window.sessionStorage', 'm["schema"]', 'm.createLogger()', 'modules[0]["x"].make({"a":1,"b":[1,2]})', 'globalThis.crypto', 'console.info.bind(console)', 'Date', 'Math']) assert.equal(isSafeConnectionExpression(e), true, e);
  });
  it('임의 코드 실행 경로는 모두 거부한다', () => {
    for (const e of [
      "m.constructor.constructor('return process')()", "m['constructor']", 'process.exit(1)', "require('fs')", 'import("fs")',
      '(() => 1)()', 'function f(){}', 'new Function("x")', 'eval("1")', 'Function("return 1")()', '`${1}`', 'a = 1', 'a; b', 'x ? y : z',
      'globalThis.process', 'm[dynamicKey]', 'm.__proto__', '', '(', 'await x',
    ]) assert.equal(isSafeConnectionExpression(e), false, e);
  });
});
