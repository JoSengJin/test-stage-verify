// 비대화형 게이트와 보고서 판정 회귀: 사람의 확인이 필요한 실행은 자동 통과하지 않고, 사람이 남긴 문제는 보류로 이어진다.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCi, EXIT } from '../src/ci.ts';
import { buildReport, reportHtml } from '../src/report.ts';

const SANDBOX = path.join(os.tmpdir(), 'stage-framework-test-candidates');

function fixture(testBody: string) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-ci-fixture-'));
  const w = (rel: string, body: string) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), body); };
  w('package.json', JSON.stringify({ name: 'ci-fixture-src', version: '1.0.0', private: true }));
  w('dist/package.json', JSON.stringify({ name: 'ci-fixture', version: '1.0.0', type: 'module', exports: { '.': './index.js' } }));
  w('dist/index.js', "export const greet = (log, name) => log(`hello ${name}`);\nexport const add = (a, b) => a + b;\n");
  w('tests/t.test.mjs', testBody);
  return root;
}

describe('비대화형 게이트(ci)', () => {
  it('협력자 mock 테스트는 사람이 실제 협력자를 확인해야 하므로 자동 통과하지 않는다(종료 코드 3)', async () => {
    const root = fixture(`import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
const { greet } = await import('../dist/index.js');
test('협력자 log가 호출된다', () => { const log = mock.fn(); greet(log, 'x'); assert.equal(log.mock.calls[0].arguments[0], 'hello x'); });
`);
    try {
      const r = await runCi({ project: root, test: 'tests/t.test.mjs', sandboxRoot: SANDBOX, env: {} });
      assert.equal(r.exitCode, EXIT.humanNeeded, r.message);
      assert.notEqual(r.run!.stages[2].status, 'passed');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });

  it('존재하지 않는 테스트 파일은 사용 오류(2)로 끝난다', async () => {
    const r = await runCi({ project: os.tmpdir(), test: 'nope.test.mjs', env: {} });
    assert.equal(r.exitCode, EXIT.usage);
  });

  it('실패하는 원본 테스트는 보류(1)이고 보고서에 사유가 남는다', async () => {
    const root = fixture(`import assert from 'node:assert/strict';
import { test } from 'node:test';
const { add } = await import('../dist/index.js');
test('덧셈', () => { assert.equal(add(1, 2), 4); });
`);
    try {
      const out = path.join(root, 'out', 'report.json');
      const r = await runCi({ project: root, test: 'tests/t.test.mjs', sandboxRoot: SANDBOX, env: {}, out });
      assert.equal(r.exitCode, EXIT.fail, r.message);
      assert.equal(r.report!.decision.code, 'hold-failure');
      assert.ok(fs.existsSync(out) && fs.existsSync(out.replace(/\.json$/, '.html')));
      assert.match(reportHtml(r.report!), /한눈에 보기/);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});

describe('보고서 판정', () => {
  it('사람이 문제를 기록하면 자동 단계가 통과여도 보류이고, 한눈에 보기에 지금 할 일이 나온다', async () => {
    const root = fixture(`import assert from 'node:assert/strict';
import { test } from 'node:test';
const { add } = await import('../dist/index.js');
test('덧셈', () => { assert.equal(add(1, 2), 3); });
`);
    try {
      const r = await runCi({ project: root, test: 'tests/t.test.mjs', sandboxRoot: SANDBOX, env: {}, allowConditional: true });
      const run = r.run!;
      assert.equal(run.stages[2].status, 'passed', r.message);
      assert.equal(run.signoff?.by, 'ci', '판정 확정자가 기록되어야 한다');
      assert.equal(run.signoff?.candidateSha256, run.candidate?.tarballSha256, '확정은 검증한 배포 후보 해시에 묶여야 한다');
      const before = buildReport(run, r.analysis!);
      assert.notEqual(before.decision.code, 'hold-failure');
      assert.ok(before.summary.nextAction.length > 0 && before.summary.verified.length > 0);
      run.manual.push({ id: 'm1', at: new Date().toISOString(), target: '주문 화면', verdict: 'issue', note: '금액이 다르게 보임' });
      const after = buildReport(run, r.analysis!);
      assert.equal(after.decision.code, 'hold-failure');
      assert.match(after.decision.reasons.join(' '), /금액이 다르게 보임/);
      assert.match(after.summary.nextAction, /배포하지 마세요/);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
});
