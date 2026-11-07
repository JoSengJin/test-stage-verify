// 실행 관리·배포 후보·연결 모드 통합 검증. 실제 npm pack·설치·자식 프로세스·로컬 Stage 대역 서버를 사용한다.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { RunManager, type Run } from '../src/exec/runs.ts';
import { Store } from '../src/store.ts';
import { buildReport } from '../src/report.ts';
import { checkCandidateContract } from '../src/exec/candidate.ts';
import { analyzeTestFile } from '../src/analysis/analyze.ts';
import { REPO, SAMPLE, SAMPLE_TEST } from './helpers.ts';

const TOKEN = `test-token-${Math.random().toString(36).slice(2)}`;
const SANDBOX = path.join(os.tmpdir(), 'stage-framework-test-candidates');
const procs: ChildProcess[] = [];

function startStandin(extraEnv: Record<string, string> = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, [path.join(REPO, 'examples/order-stage-server/server.mjs')], { env: { ...process.env, ORDER_API_TOKEN: TOKEN, STAGE_SERVER_PORT: '0', ...extraEnv } });
    procs.push(p);
    p.stdout!.on('data', (d) => { const m = /http:\/\/127\.0\.0\.1:(\d+)/.exec(String(d)); if (m) resolve(`http://127.0.0.1:${m[1]}`); });
    p.on('exit', (c) => reject(new Error(`stand-in exited ${c}`)));
  });
}

function manager(env: Record<string, string>, extra: Partial<ConstructorParameters<typeof RunManager>[0]> = {}) {
  const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), 'stage-store-')));
  return new RunManager({ store, sandboxRoot: SANDBOX, env, ...extra });
}

function analyze(rm: RunManager, testFile = SAMPLE_TEST, root = SAMPLE) {
  const a = analyzeTestFile({ testFile, projectRoot: root });
  rm.addAnalysis(a);
  return a;
}

let stageUrl: string;
let slowUrl: string;
before(async () => { [stageUrl, slowUrl] = await Promise.all([startStandin(), startStandin({ STAGE_SERVER_DELAY_MS: '2500' })]); });
after(() => { for (const p of procs) p.kill(); });

describe('파이프라인: 1→2단계와 3단계 조작', { concurrency: false }, () => {
  let rm: RunManager;
  let run: Run;

  before(async () => {
    rm = manager({ ORDER_API_URL: stageUrl, ORDER_API_TOKEN: TOKEN });
    const a = analyze(rm);
    run = rm.createRun(a.id);
    await rm.idle();
  });

  it('1단계는 프로젝트 러너로 원본 테스트 4개를 실행해 통과한다', () => {
    const j = run.jobs.find((x) => x.kind === 'stage1')!;
    assert.equal(run.stages[0].status, 'passed');
    assert.equal(j.stage1!.exitCode, 0);
    assert.equal(j.stage1!.tests.length, 4);
    assert.match(j.stage1!.command, /--test /);
  });

  it('2단계는 npm pack 산출물을 설치해 공개 API로 시나리오를 실행한다', () => {
    assert.equal(run.stages[1].status, 'passed', run.stages[1].reason);
    const c = run.candidate!;
    assert.match(c.tarballSha256, /^[0-9a-f]{64}$/);
    assert.ok(c.files.every((f) => f === 'package.json' || f.startsWith('dist/')), c.files.join(','));
    assert.equal(c.boundary.ok, true);
    assert.ok(fs.existsSync(path.join(c.consumerDir, 'node_modules', '@sample', 'order-client', 'dist', 'index.js')));
    assert.ok(!c.consumerDir.startsWith(REPO), '샌드박스는 저장소 밖에 있어야 함');
    const scen = run.jobs.filter((x) => x.kind === 'scenario');
    assert.equal(scen.length, 4);
    for (const j of scen) {
      assert.equal(j.status, 'passed', j.reason);
      assert.ok(j.outcome!.checks.length > 0);
      assert.equal(j.outcome!.network.length, 0, '대체 객체 모드에서는 통신이 없어야 함');
      assert.ok(j.outcome!.events.some((e) => e.kind === 'action'));
    }
    const variants = run.jobs.filter((x) => x.kind === 'variant');
    assert.equal(variants.length, 4);
    for (const v of variants) assert.equal(v.status, 'passed', `${v.label}: ${v.reason}`);
    assert.equal(run.stages[2].status, 'preparing');
  });

  it('Stage 모드: 가로채기 없이 실제 서버와 통신하고 후속 조회로 검증한다', async () => {
    const j = await rm.interact(run.id, { scenarioId: 'sc1', mode: 'stage', args: [{ sku: 'SKU-7', quantity: 3 }, { idempotencyKey: 'key-1' }] });
    const o = j.outcome!;
    assert.equal(o.linkVerdict, 'pass', o.verdictReason);
    assert.ok(o.network.length >= 2 && o.network.every((n) => !n.intercepted && n.status !== undefined));
    assert.equal(o.network[0].requestHeaders.authorization, '[REDACTED]');
    assert.ok(o.checks.some((c) => c.id === 'followup:sku' && c.status === 'pass'));
    assert.equal(j.input!.changed, true);
    assert.ok(o.checks.filter((c) => c.origin === 'original-test').every((c) => c.status === 'invalidated'), '입력 변경 시 원본 기대 조건은 무효');
    // 실행별 멱등성 키가 실제 요청 헤더에 들어갔는지
    assert.match(o.network[0].requestHeaders['idempotency-key'], new RegExp(`^stage-${run.id}-sc1-`));
  });

  it('Mock 모드: 같은 공개 API 호출을 유지하고 요청은 가로채어 외부로 나가지 않는다', async () => {
    const j = await rm.interact(run.id, { scenarioId: 'sc1', mode: 'mock', args: [{ sku: 'SKU-1', quantity: 2 }, { idempotencyKey: 'key-1' }] });
    const o = j.outcome!;
    assert.equal(o.status, 'passed', JSON.stringify(o.checks));
    assert.ok(o.network.length > 0 && o.network.every((n) => n.intercepted));
    assert.equal(o.linkVerdict, undefined, 'Mock 결과는 실제 연계 판정을 만들지 않음');
    const res = await fetch(`${stageUrl}/orders/mock-ord-1`, { headers: { authorization: `Bearer ${TOKEN}` } });
    assert.equal(res.status, 404, 'mock 응답의 주문이 실제 서버에 생기면 안 됨');
  });

  it('원본 입력 + 협력 객체 미호출 경로는 원본 오류 검증을 실제 연결에서도 유지한다', async () => {
    const j = await rm.interact(run.id, { scenarioId: 'sc2', mode: 'stage', args: [{ sku: 'SKU-1', quantity: 0 }] });
    assert.equal(j.outcome!.linkVerdict, 'pass');
    assert.equal(j.outcome!.network.length, 0);
    assert.ok(j.outcome!.checks.some((c) => c.origin === 'original-test' && c.status === 'pass' && c.label.includes('assert.rejects')));
  });

  it('입력을 바꿔 적용 가능한 검증이 없으면 자동 통과시키지 않는다', async () => {
    const j = await rm.interact(run.id, { scenarioId: 'sc2', mode: 'stage', args: [{ sku: 'SKU-1', quantity: -5 }] });
    assert.notEqual(j.outcome!.linkVerdict, 'pass');
    assert.equal(j.status, 'failed');
  });

  it('재실행·재조작은 별도 기록으로 남는다', () => {
    const sc2 = run.jobs.filter((x) => x.kind === 'interaction' && x.scenarioId === 'sc2');
    assert.deepEqual(sc2.map((x) => x.attempt), [1, 2]);
  });

  it('저장된 실행 기록·보고서에 인증값이 노출되지 않는다', () => {
    const raw = fs.readFileSync(path.join(rm.store.dir, 'runs', `${run.id}.json`), 'utf8');
    assert.ok(!raw.includes(TOKEN));
    const report = buildReport(run, rm.analyses.get(run.analysisId)!);
    assert.ok(!JSON.stringify(report).includes(TOKEN));
  });

  it('3단계 확정과 보고서: 미검증 범위를 숨기지 않는다', async () => {
    for (const sc of ['sc3', 'sc4']) await rm.interact(run.id, { scenarioId: sc, mode: 'stage', args: sc === 'sc4' ? ['ord-1001'] : [{ sku: 'SKU-1', quantity: 1 }] });
    rm.completeStage3(run.id);
    // sc2의 최신 Stage 조작(입력 변경, 판정 없음) 때문에 3단계는 실패여야 한다.
    assert.equal(run.stages[2].status, 'failed', run.stages[2].reason);
    const r = buildReport(run, rm.analyses.get(run.analysisId)!);
    assert.equal(r.decision.code, 'hold-failure');
  });

  it('수동 확인은 자동 판정을 덮어쓰지 않는다', () => {
    rm.addManual(run.id, { target: 'sc2', verdict: 'confirmed', note: '화면에서 확인' });
    assert.equal(run.stages[2].status, 'failed');
    assert.equal(buildReport(run, rm.analyses.get(run.analysisId)!).decision.code, 'hold-failure');
  });
});

describe('실패·차단·시간 제한·취소', { concurrency: false }, () => {
  it('Stage 서버에 닿지 않으면 환경 차단이며 Mock으로 대체하지 않는다', async () => {
    const rm = manager({ ORDER_API_URL: 'http://127.0.0.1:9', ORDER_API_TOKEN: TOKEN });
    const run = rm.createRun(analyze(rm).id);
    await rm.idle();
    const j = await rm.interact(run.id, { scenarioId: 'sc1', mode: 'stage', args: [{ sku: 'SKU-1', quantity: 2 }] });
    assert.equal(j.outcome!.linkVerdict, 'environment-blocked', j.outcome!.verdictReason);
    assert.ok(j.outcome!.network.every((n) => !n.intercepted));
  });

  it('Stage 연결 설정이 없으면 환경 차단으로 기록한다', async () => {
    const rm = manager({});
    const run = rm.createRun(analyze(rm).id);
    await rm.idle();
    const j = await rm.interact(run.id, { scenarioId: 'sc1', mode: 'stage', args: [{ sku: 'SKU-1', quantity: 2 }] });
    assert.equal(j.outcome!.linkVerdict, 'environment-blocked');
    assert.match(j.outcome!.verdictReason!, /ORDER_API_URL/);
  });

  it('변경 요청 시간 초과는 처리 결과 불명이며 재전송하지 않는다', async () => {
    const rm = manager({ ORDER_API_URL: slowUrl, ORDER_API_TOKEN: TOKEN }, { timeouts: { interaction: 1200 } });
    const run = rm.createRun(analyze(rm).id);
    await rm.idle();
    const j = await rm.interact(run.id, { scenarioId: 'sc1', mode: 'stage', args: [{ sku: 'SKU-1', quantity: 2 }] });
    assert.equal(j.status, 'timeout');
    assert.equal(j.outcome!.linkVerdict, 'outcome-unknown');
    assert.equal(run.jobs.filter((x) => x.kind === 'interaction').length, 1, '자동 재전송 없음');
  });

  it('시나리오 시간 제한을 넘으면 프로세스를 종료하고 시간 초과로 기록한다', async () => {
    const rm = manager({}, { timeouts: { scenario: 1 } });
    const run = rm.createRun(analyze(rm).id);
    await rm.idle();
    const scen = run.jobs.filter((x) => x.kind === 'scenario');
    assert.ok(scen.every((x) => x.status === 'timeout'), scen.map((x) => x.status).join(','));
    assert.equal(run.stages[1].status, 'failed');
    assert.equal(run.stages[2].status, 'not-run');
  });

  it('취소하면 진행 중 작업을 종료하고 이후 단계는 미실행으로 남는다', async () => {
    const rm = manager({});
    const run = rm.createRun(analyze(rm).id);
    rm.cancel(run.id);
    await rm.idle();
    assert.equal(run.stages[0].status, 'cancelled');
    assert.deepEqual(run.stages.slice(1).map((s) => s.status), ['not-run', 'not-run']);
    assert.ok(run.jobs.every((j) => j.status === 'cancelled'), run.jobs.map((j) => j.status).join(','));
  });

  describe('1단계 실패·0개·skip은 통과가 아니며 다음 단계는 미실행', () => {
    function copySample(mutate: (dir: string) => void) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-sample-'));
      fs.cpSync(SAMPLE, dir, { recursive: true, filter: (s) => !s.includes('node_modules') && !s.includes(`${path.sep}dist`) });
      mutate(dir);
      return dir;
    }
    const cases: [string, (d: string) => void, RegExp][] = [
      ['소스 결함', (d) => { const f = path.join(d, 'src/internal/order-service.ts'); fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace("'/orders',", "'/order',")); }, /실패 1개/],
      ['테스트 0개', (d) => { fs.writeFileSync(path.join(d, 'test/order-service.test.ts'), "import { describe } from 'node:test';\ndescribe('empty', () => {});\n"); }, /0개/],
      ['skip 포함', (d) => { const f = path.join(d, 'test/order-service.test.ts'); fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace("it('propagates", "it.skip('propagates")); }, /skip/],
    ];
    for (const [name, mutate, reason] of cases) {
      it(name, async () => {
        const dir = copySample(mutate);
        const rm = manager({});
        const a = analyze(rm, path.join(dir, 'test/order-service.test.ts'), dir);
        const run = rm.createRun(a.id);
        await rm.idle();
        assert.equal(run.stages[0].status, 'failed');
        assert.match(run.stages[0].reason, reason);
        assert.deepEqual(run.stages.slice(1).map((s) => s.status), ['not-run', 'not-run']);
        fs.rmSync(dir, { recursive: true, force: true });
      });
    }
  });
});

describe('배포 후보 공개 API 계약 불일치 탐지', () => {
  it('배포 후보에 테스트가 쓰는 메서드가 없으면 타입 대조와 실행 모두에서 불일치로 표시한다', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-fake-candidate-'));
    const pkgDir = path.join(dir, 'node_modules', '@sample', 'order-client');
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: '@sample/order-client', version: '9.9.9', type: 'module', exports: { '.': { types: './index.d.ts', default: './index.js' } } }));
    fs.writeFileSync(path.join(pkgDir, 'index.js'), 'export class OrderService { constructor(h) { this.h = h; } async placeOrder() { return { orderId: "x", status: "created" }; } }\nexport class HttpError extends Error {}\n');
    fs.writeFileSync(path.join(pkgDir, 'index.d.ts'), 'export declare class OrderService { constructor(h: unknown); placeOrder(i: unknown): Promise<{ orderId: string; status: "created" }>; }\nexport declare class HttpError extends Error {}\n');
    fs.writeFileSync(path.join(dir, 'package.json'), '{"private":true,"type":"module"}');
    const entryFile = path.join(dir, 'stage-entry.mjs');
    fs.writeFileSync(entryFile, 'import * as api from "@sample/order-client";\nexport default api;\n');
    const a = analyzeTestFile({ testFile: SAMPLE_TEST, projectRoot: SAMPLE });
    const cand = { id: 'fake', packageName: '@sample/order-client', version: '9.9.9', tarball: '', tarballSha256: '', files: [], consumerDir: dir, entryFile, installedAt: '', boundary: { ok: true, notes: [] } };
    const contract = checkCandidateContract(cand, a.scenarios);
    assert.ok(contract.findings.some((f) => f.ruleId === 'candidate/method-missing' && f.message.includes('getOrder')), JSON.stringify(contract.findings));

    const rm = manager({});
    const out = await rm.child({ type: 'scenario', entryUrl: pathToFileURL(entryFile).href, scenario: a.scenarios[3], mode: 'doubles' }, dir, new AbortController().signal);
    assert.equal(out.status, 'failed');
    assert.ok(out.checks.some((c) => c.origin === 'public-contract' && c.status === 'fail' && c.reason.includes('계약 불일치')));
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
