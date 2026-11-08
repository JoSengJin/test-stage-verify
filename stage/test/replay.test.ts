// 배포 후보 재실행: 조작 화면으로 옮길 수 없는 런던파 스타일 테스트를 원본 그대로 배포본 파일로 다시 실행한다.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RunManager } from '../src/exec/runs.ts';
import { Store } from '../src/store.ts';
import { analyzeTestFile } from '../src/analysis/analyze.ts';
import { runConnectedNode } from '../src/exec/connected-scenarios.ts';

const SANDBOX = path.join(os.tmpdir(), 'stage-framework-test-candidates');

function fixture(opts: { distFiles?: string[]; extraDist?: Record<string, string> } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-replay-'));
  const w = (rel: string, body: string) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), body); };
  w('package.json', JSON.stringify({ name: 'replay-fixture-src', version: '1.0.0', private: true }));
  w('dist/package.json', JSON.stringify({ name: 'replay-fixture', version: '1.0.0', type: 'module', exports: { '.': './index.js' }, ...(opts.distFiles ? { files: opts.distFiles } : {}) }));
  w('dist/index.js', "export const greet = (log, name) => log(`hello ${name}`);\n");
  for (const [k, v] of Object.entries(opts.extraDist ?? {})) w(`dist/${k}`, v);
  w('tests/greet.test.mjs', `import assert from 'node:assert/strict';
import { test, mock } from 'node:test';
${opts.extraDist ? "const { extra } = await import('../dist/extra.js');" : ''}
const { greet } = await import('../dist/index.js');
test('협력자 log가 인사말로 호출된다', () => {
  const log = mock.fn();
  greet(log, 'x');
  assert.equal(log.mock.calls[0].arguments[0], 'hello x');
});
`);
  return root;
}

async function execute(root: string) {
  const rm = new RunManager({ store: new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'stage-store-'))), sandboxRoot: SANDBOX, env: {} });
  const a = analyzeTestFile({ testFile: path.join(root, 'tests/greet.test.mjs'), projectRoot: root });
  rm.addAnalysis(a);
  const r = rm.createRun(a.id);
  await rm.idle();
  return { rm, run: rm.runs.get(r.id)!, a };
}

describe('배포 후보 재실행', () => {
  it('원본 테스트를 배포 후보 파일로 재실행하고 로드된 모듈을 기록한다', async () => {
    const root = fixture();
    const { rm, run, a } = await execute(root);
    assert.equal(rm.replayEligible(a), true);
    assert.equal(run.replayMode, true);
    assert.deepEqual(run.stages.map((s) => s.status), ['passed', 'passed', 'running']);
    assert.deepEqual(run.replay!.redirected, ['index.js']);
    assert.equal(run.replay!.run.tests.length, 1);
    assert.match(run.replay!.packageDir, /node_modules\/replay-fixture$/);
    assert.throws(() => rm.completeStage3(run.id), /실제 협력자 기대 결과 미검증/);
    const configured = run.connected!;
    const input = { code: configured.definition.scenarios[0].code, connections: { log: 'console.log.bind(console)' }, values: {}, environment: 'node', seed: {} };
    const result = await runConnectedNode({ dir: run.realEnv!.live!.dir, console: run.realEnv!.live!.console!, scenario: configured.definition, input, signal: new AbortController().signal });
    assert.equal(result.status, 'passed', result.reason);
    const data = { jobId: configured.jobId, scenarioId: '0', sequence: 1, type: 'result', input, result };
    rm.recordConnected(run.id, data);
    rm.recordConnected(run.id, { ...data, type: 'invalidate', sequence: 2 });
    rm.recordConnected(run.id, data); // An older response cannot restore an invalidated pass.
    assert.throws(() => rm.completeStage3(run.id), /미검증/);
    rm.recordConnected(run.id, { ...data, sequence: 3 });
    assert.throws(() => rm.recordConnected(run.id, { ...data, jobId: 'old-job', sequence: 4 }), /유효한/);
    rm.completeStage3(run.id);
    assert.equal(run.stages[2].status, 'passed');
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('프로젝트 dist에는 있으나 배포물에 없는 파일을 import하면 실패한다', async () => {
    const root = fixture({ distFiles: ['index.js'], extraDist: { 'extra.js': 'export const extra = 1;\n' } });
    const { rm, run } = await execute(root);
    assert.deepEqual(run.replay!.missing, ['extra.js']);
    rm.completeStage3(run.id);
    assert.equal(run.stages[2].status, 'failed');
    assert.match(run.stages[2].reason, /미통과/);
    fs.rmSync(root, { recursive: true, force: true });
  });
});
