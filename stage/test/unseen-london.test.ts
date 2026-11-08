import { it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { connectedScenarios, runConnectedNode } from '../src/exec/connected-scenarios.ts';
import { collaboratorChoices } from '../src/exec/connected-console.js';
import { executeConnectedScenario } from '../src/exec/scenario-runtime.js';
import * as stockroom from './fixtures/unseen-london/dist/index.js';
import { analyzeTestFile } from '../src/analysis/analyze.ts';
import { RunManager } from '../src/exec/runs.ts';
import { Store } from '../src/store.ts';

const root = fileURLToPath(new URL('./fixtures/unseen-london/', import.meta.url));

it('새 파일의 정상 파이프라인은 배포 후보를 설치하고 실제 협력자 4개 결과로 3단계를 완료한다', async t => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'unseen-london-pipeline-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const manager = new RunManager({ store: new Store(path.join(work, 'records')), sandboxRoot: path.join(work, 'candidates'), env: {} });
  const analysis = analyzeTestFile({ testFile: path.join(root, 'test/stockroom-allocation-london.test.mjs'), projectRoot: root });
  manager.addAnalysis(analysis);
  const created = manager.createRun(analysis.id);
  await manager.idle();
  const run = manager.runs.get(created.id)!;
  assert.deepEqual(run.stages.map(stage => stage.status), ['passed', 'passed', 'running']);
  assert.equal(run.connected?.definition.scenarios.length, 4);
  assert.equal(run.replay?.missing.length, 0);
  assert.throws(() => manager.completeStage3(run.id), /미검증/);
  const connected = run.connected!;
  for (const scenario of connected.definition.scenarios) {
    const warehouse = collaboratorChoices(stockroom, scenario, 'warehouse').find(choice => choice.label === '배포 객체 생성 · openStockroom');
    const notify = collaboratorChoices(stockroom, scenario, 'notify')[0];
    const input = { code: scenario.code, environment: 'node', connections: { warehouse: warehouse.expression, notify: notify.expression }, values: {}, seed: {} };
    const result = await runConnectedNode({ dir: run.realEnv!.live!.dir, console: run.realEnv!.live!.console!, scenario: connected.definition, input, signal: new AbortController().signal });
    assert.equal(result.status, 'passed', `${scenario.name}: ${result.reason}`);
    manager.recordConnected(run.id, { jobId: connected.jobId, scenarioId: scenario.id, sequence: 1, type: 'result', input, result });
  }
  manager.completeStage3(run.id);
  assert.deepEqual(run.stages.map(stage => stage.status), ['passed', 'passed', 'passed']);
});

it('기존 7개와 무관한 재고 예약 파일도 실제 객체·콜백 선택지로 원본 기대 결과를 검증한다', async () => {
  const definition = connectedScenarios(path.join(root, 'test/stockroom-allocation-london.test.mjs'), path.join(root, 'dist'));
  assert.equal(definition.scenarios.length, 4);
  for (const scenario of definition.scenarios) {
    assert.deepEqual(scenario.connections, ['warehouse', 'notify']);
    assert.doesNotMatch(scenario.code, /\bmock\./);
    const warehouse = collaboratorChoices(stockroom, scenario, 'warehouse').find(choice => choice.label === '배포 객체 생성 · openStockroom');
    const notify = collaboratorChoices(stockroom, scenario, 'notify')[0];
    assert.ok(warehouse, '실제 배포 객체 생성 선택지가 있어야 한다');
    const result = await executeConnectedScenario({ code: scenario.code, connections: { warehouse: warehouse.expression, notify: notify.expression }, values: {}, seed: {} }, [stockroom], definition.symbols);
    assert.equal(result.status, 'passed', `${scenario.name}: ${result.reason}`);
    assert.ok(result.checks.length >= 4);
    assert.ok(result.checks.every(check => check.passed));
  }
});

it('새 파일의 기대값을 틀리게 바꾸면 실제 협력자의 결과와 불일치해 실패한다', async () => {
  const definition = connectedScenarios(path.join(root, 'test/stockroom-allocation-london.test.mjs'), path.join(root, 'dist'));
  const scenario = definition.scenarios[0];
  const warehouse = collaboratorChoices(stockroom, scenario, 'warehouse').find(choice => choice.label === '배포 객체 생성 · openStockroom');
  const notify = collaboratorChoices(stockroom, scenario, 'notify')[0];
  const code = scenario.code.replace("assert.deepEqual(result, { status: 'reserved', remaining: 3 })", "assert.deepEqual(result, { status: 'reserved', remaining: 999 })");
  assert.notEqual(code, scenario.code);
  const result = await executeConnectedScenario({ code, connections: { warehouse: warehouse.expression, notify: notify.expression }, values: {}, seed: {} }, [stockroom], definition.symbols);
  assert.equal(result.status, 'failed');
  assert.equal(result.checks.at(-1).actual.remaining, 3);
  assert.equal(result.checks.at(-1).expected.remaining, 999);
});
