// 실행 관리: 큐·단계 의존성·동시 실행 제한·시간 제한·취소·정리·결과 수집. 실행 상태의 원본은 서버(이 모듈)다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type {
  AnalysisResult, CheckResult, ConnectionMode, ExecOutcome, ExecStatus, ExportsCheck, Scenario, ScriptRunResult, Step, Value,
} from '../model.ts';
import { RULES_VERSION, FRAMEWORK_VERSION } from '../model.ts';
import { checkCandidateContract, prepareCandidate, type CandidateContract, type CandidateInfo } from './candidate.ts';
import { runStage1, type Stage1Result } from './stage1.ts';
import { runScriptSandbox } from './script-run.ts';
import { verifyExports } from './exports-verify.ts';
import type { ChildJob, MockRoute } from './child.ts';
import { newId, redactText, sha256 } from '../util.ts';
import type { Store } from '../store.ts';

const CHILD = path.join(path.dirname(fileURLToPath(import.meta.url)), 'child.ts');

export type JobKind = 'stage1' | 'candidate' | 'contract' | 'scenario' | 'variant' | 'interaction' | 'script' | 'exports';

export interface Job {
  id: string;
  runId: string;
  stage: 1 | 2 | 3;
  kind: JobKind;
  label: string;
  scenarioId?: string;
  mode?: ConnectionMode;
  status: ExecStatus;
  reason?: string;
  queuedAt: string;
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
  timeoutMs: number;
  attempt?: number;
  input?: InteractionInput;
  outcome?: ExecOutcome;
  stage1?: Stage1Result;
  logs: string[];
}

export interface InteractionInput {
  scenarioId: string;
  stepId: string;
  method: string;
  /** 원본 테스트 입력 */
  originalArgs: Value[];
  /** 사용자가 화면에서 보낸 입력 */
  userArgs: Value[];
  /** 프레임워크가 덧붙인 값(실행 식별 멱등성 키 등) */
  frameworkArgs: { path: string; value: Value; reason: string }[];
  changed: boolean;
  routes?: MockRoute[];
  connection: { mode: ConnectionMode; target: string };
}

export interface StageState {
  stage: 1 | 2 | 3;
  title: string;
  status: ExecStatus;
  reason: string;
  startedAt?: string;
  endedAt?: string;
}

export interface ManualCheck {
  id: string;
  at: string;
  target: string;
  verdict: 'confirmed' | 'issue' | 'note';
  note: string;
}

export interface Run {
  id: string;
  createdAt: string;
  rerunOf?: string;
  analysisId: string;
  analysisSha: string;
  rulesVersion: string;
  frameworkVersion: string;
  project: { root: string; name?: string; version?: string; git?: unknown };
  testFile: { path: string; sha256: string };
  environment: { node: string; platform: string; stageTarget?: string; stageConfigSha?: string; sandbox: string };
  candidate?: CandidateInfo;
  contract?: CandidateContract;
  /** 스크립트 SUT: 샌드박스 실행 결과와 exports 런타임 import 검증 결과 */
  script?: ScriptRunResult;
  exportsCheck?: ExportsCheck;
  stages: StageState[];
  jobs: Job[];
  manual: ManualCheck[];
  cancelled?: { at: string; reason: string };
}

interface Pending { job: Job; exec: (signal: AbortSignal) => Promise<void>; resolve: () => void }

export interface RunManagerOptions {
  store: Store;
  concurrency?: number;
  timeouts?: Partial<Record<JobKind, number>>;
  sandboxRoot?: string;
  env?: NodeJS.ProcessEnv;
  onChange?: (run: Run) => void;
}

const DEFAULT_TIMEOUTS: Record<JobKind, number> = { stage1: 60_000, candidate: 240_000, contract: 60_000, scenario: 15_000, variant: 15_000, interaction: 20_000, script: 120_000, exports: 240_000 };

export class RunManager {
  runs = new Map<string, Run>();
  analyses = new Map<string, AnalysisResult>();
  queue: Pending[] = [];
  running = new Map<string, AbortController>();
  store: Store;
  concurrency: number;
  timeouts: Record<JobKind, number>;
  sandboxRoot: string;
  env: NodeJS.ProcessEnv;
  onChange: (run: Run) => void;

  constructor(o: RunManagerOptions) {
    this.store = o.store;
    this.concurrency = o.concurrency ?? 2;
    this.timeouts = { ...DEFAULT_TIMEOUTS, ...(o.timeouts ?? {}) };
    this.sandboxRoot = o.sandboxRoot ?? path.join(os.tmpdir(), 'stage-framework-candidates');
    this.env = o.env ?? process.env;
    this.onChange = o.onChange ?? (() => {});
    for (const run of this.store.loadRuns()) {
      // 이전 서버 프로세스에서 끝나지 않은 작업은 결과를 알 수 없으므로 취소로 기록한다(자동 재실행하지 않음).
      let touched = false;
      for (const j of run.jobs) if (['queued', 'preparing', 'running'].includes(j.status)) { j.status = 'cancelled'; j.reason = '서버 재시작으로 중단됨'; touched = true; }
      for (const s of run.stages) {
        // 3단계 'running'은 사용자 조작 대기 상태일 수 있다. 중단된 작업이 있었던 단계만 취소로 기록한다.
        const interrupted = run.jobs.some((j) => j.stage === s.stage && j.reason === '서버 재시작으로 중단됨');
        if (s.status === 'queued' || (s.status === 'running' && (s.stage !== 3 || interrupted))) { s.status = 'cancelled'; s.reason = '서버 재시작으로 중단됨'; touched = true; }
      }
      if (run.stages.some((s) => s.status === 'cancelled') && run.stages[2].status === 'queued') run.stages[2].status = 'not-run';
      if (touched) this.store.saveRun(run);
      this.runs.set(run.id, run);
    }
    for (const a of this.store.loadAnalyses()) this.analyses.set(a.id, a);
  }

  stageConfig(root: string): any {
    const f = path.join(root, 'stage.config.json');
    return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : undefined;
  }

  addAnalysis(a: AnalysisResult) { this.analyses.set(a.id, a); this.store.saveAnalysis(a); }

  touch(run: Run) { this.store.saveRun(run); this.onChange(run); }

  createRun(analysisId: string, rerunOf?: string): Run {
    const a = this.analyses.get(analysisId);
    if (!a) throw new HttpError(404, '분석 결과 없음');
    if (!a.project || a.input.linkStatus !== 'linked' || !a.input.linkedPath) throw new HttpError(409, '프로젝트에 연결되지 않은 파일은 실행할 수 없음(분석 결과의 연결 필요 항목 참고)');
    const root = a.project.root;
    const testPath = path.join(root, a.input.linkedPath);
    const currentSha = sha256(fs.readFileSync(testPath));
    if (currentSha !== a.input.sha256) throw new HttpError(409, '분석 이후 테스트 파일이 바뀜 — 다시 드롭해 분석하세요');
    const cfg = this.stageConfig(root);
    const run: Run = {
      id: newId('run'),
      createdAt: new Date().toISOString(),
      rerunOf,
      analysisId,
      analysisSha: sha256(JSON.stringify(a.scenarios)),
      rulesVersion: RULES_VERSION,
      frameworkVersion: FRAMEWORK_VERSION,
      project: { root, name: a.project.name, version: a.project.version, git: a.project.git },
      testFile: { path: a.input.linkedPath, sha256: a.input.sha256 },
      environment: { node: process.version, platform: `${process.platform}-${process.arch}`, stageTarget: this.stageTarget(cfg), stageConfigSha: a.stageConfig?.sha256, sandbox: this.sandboxRoot },
      stages: [
        { stage: 1, title: '1단계 단위 테스트(소스·원본 테스트)', status: 'queued', reason: '대기' },
        { stage: 2, title: '2단계 배포 후보 공개 API·대상 런타임', status: 'queued', reason: '1단계 대기' },
        { stage: 3, title: '3단계 사용자 조작·Stage 연계', status: 'queued', reason: '2단계 대기' },
      ],
      jobs: [],
      manual: [],
    };
    this.runs.set(run.id, run);
    this.touch(run);
    void this.pipeline(run, a);
    return run;
  }

  /** Stage 대상 주소: 설정에서 참조하는 환경 변수 중 baseUrl의 origin만 표시한다(인증값은 표시하지 않음). */
  stageTarget(cfg: any): string | undefined {
    const ref = cfg?.consumer?.setup?.args?.[0]?.baseUrl;
    if (ref && typeof ref === 'object' && ref.$env) {
      const v = this.env[ref.$env];
      if (!v) return `미설정(${ref.$env})`;
      try { return new URL(v).origin; } catch { return `잘못된 주소(${ref.$env})`; }
    }
    return undefined;
  }

  // ---- 큐 ----
  enqueue(run: Run, partial: Omit<Job, 'id' | 'runId' | 'status' | 'queuedAt' | 'logs' | 'timeoutMs'> & { timeoutMs?: number }, exec: (job: Job, signal: AbortSignal) => Promise<void>): Promise<Job> {
    const job: Job = { id: newId('job'), runId: run.id, status: 'queued', queuedAt: new Date().toISOString(), logs: [], timeoutMs: partial.timeoutMs ?? this.timeouts[partial.kind], ...partial };
    run.jobs.push(job);
    this.touch(run);
    return new Promise((resolve) => {
      this.queue.push({ job, exec: (s) => exec(job, s), resolve: () => resolve(job) });
      this.pump();
    });
  }

  pump() {
    while (this.running.size < this.concurrency && this.queue.length) {
      const p = this.queue.shift()!;
      const run = this.runs.get(p.job.runId)!;
      if (p.job.status === 'cancelled') { p.resolve(); continue; }
      const ac = new AbortController();
      this.running.set(p.job.id, ac);
      p.job.status = 'running';
      p.job.startedAt = new Date().toISOString();
      this.touch(run);
      const t0 = performance.now();
      const timer = setTimeout(() => { if (!ac.signal.aborted) ac.abort(new TimeoutSignal()); }, p.job.timeoutMs);
      p.exec(ac.signal)
        .catch((e) => {
          if (ac.signal.aborted) {
            const timeout = ac.signal.reason instanceof TimeoutSignal;
            p.job.status = timeout ? 'timeout' : 'cancelled';
            p.job.reason = timeout ? `시간 제한 ${p.job.timeoutMs}ms 초과 — 프로세스 종료` : '사용자 취소 — 프로세스 종료';
          } else {
            p.job.status = 'failed';
            p.job.reason = redactText(String(e?.message ?? e), this.secretValues());
          }
        })
        .finally(() => {
          clearTimeout(timer);
          if (ac.signal.aborted && (p.job.status === 'running' || p.job.status === 'passed' || p.job.status === 'failed')) {
            const timeout = ac.signal.reason instanceof TimeoutSignal;
            p.job.status = timeout ? 'timeout' : 'cancelled';
            p.job.reason = timeout ? `시간 제한 ${p.job.timeoutMs}ms 초과 — 프로세스 종료` : '사용자 취소 — 프로세스 종료';
          }
          p.job.endedAt = new Date().toISOString();
          p.job.durationMs = Math.round(performance.now() - t0);
          this.running.delete(p.job.id);
          this.touch(run);
          p.resolve();
          this.pump();
        });
    }
  }

  cancel(runId: string, reason = '사용자 취소') {
    const run = this.runs.get(runId);
    if (!run) throw new HttpError(404, '실행 없음');
    run.cancelled = { at: new Date().toISOString(), reason };
    for (const p of this.queue) if (p.job.runId === runId) { p.job.status = 'cancelled'; p.job.reason = reason; }
    for (const j of run.jobs) { const ac = this.running.get(j.id); if (ac) ac.abort(new Error('cancel')); }
    for (const s of run.stages) if (s.status === 'queued' || s.status === 'running' || s.status === 'preparing') { s.status = s.status === 'queued' ? 'not-run' : 'cancelled'; s.reason = `${reason}${s.status === 'not-run' ? ' — 선행 단계 미완료로 미실행' : ''}`; s.endedAt = new Date().toISOString(); }
    this.touch(run);
    return run;
  }

  secretValues(): string[] {
    const names = new Set<string>();
    for (const run of this.runs.values()) {
      const cfg = this.stageConfig(run.project.root);
      collectSecretEnv(cfg?.consumer?.setup?.args, names);
    }
    return [...names].map((n) => this.env[n] ?? '').filter(Boolean);
  }

  // ---- 단계 파이프라인 ----
  async pipeline(run: Run, a: AnalysisResult) {
    const [s1, s2, s3] = run.stages;
    const startStage = (s: StageState, reason: string) => { s.status = 'running'; s.reason = reason; s.startedAt = new Date().toISOString(); this.touch(run); };
    const endStage = (s: StageState, status: ExecStatus, reason: string) => { s.status = status; s.reason = reason; s.endedAt = new Date().toISOString(); this.touch(run); };
    const skipRest = (from: StageState[], why: string) => { for (const s of from) { s.status = 'not-run'; s.reason = why; } this.touch(run); };
    const root = run.project.root;
    const outDir = this.store.runDir(run.id);

    // 1단계
    startStage(s1, '원본 테스트 실행 중');
    const j1 = await this.enqueue(run, { stage: 1, kind: 'stage1', label: `원본 테스트 실행: ${run.testFile.path}` }, async (job, signal) => {
      const r = await runStage1({ projectRoot: root, testFile: path.join(root, run.testFile.path), runner: a.project?.runner, outDir, signal, timeoutMs: job.timeoutMs + 1000 });
      job.stage1 = r;
      job.status = r.status;
      job.reason = r.reason;
      if (signal.aborted) throw new Error('aborted');
    });
    if (run.cancelled) return;
    if (j1.status !== 'passed') { endStage(s1, j1.status, j1.reason ?? '실패'); skipRest([s2, s3], '1단계가 성공하지 않아 미실행'); return; }
    endStage(s1, 'passed', j1.reason!);

    // 스크립트 SUT(빌드 스크립트 등)는 공개 API 시나리오가 아니라 샌드박스 실행 → 배포 exports 런타임 import 검증 경로를 탄다.
    if (a.script) return this.scriptPipeline(run, a, { startStage, endStage, skipRest });

    // 2단계 (STAGE_SKIP_STAGE2=1이면 건너뛰고 프로젝트의 공개 진입 파일을 직접 import해 3단계로 간다)
    const cfg = this.stageConfig(root);
    if (this.env.STAGE_SKIP_STAGE2 === '1') {
      const entry = a.project?.publicEntries.find((e) => e.distFile && fs.existsSync(e.distFile)) ?? a.project?.publicEntries.find((e) => e.sourceFile && fs.existsSync(e.sourceFile));
      const target = entry && (entry.distFile && fs.existsSync(entry.distFile) ? entry.distFile : entry.sourceFile);
      if (!entry || !target) {
        const why = '2단계 건너뜀 설정(STAGE_SKIP_STAGE2=1)이지만 import할 공개 진입 파일(dist/소스)을 찾지 못함';
        endStage(s2, 'not-run', why); skipRest([s3], why); return;
      }
      const entryFile = path.join(outDir, 'stage-entry.mjs');
      fs.mkdirSync(outDir, { recursive: true });
      fs.writeFileSync(entryFile, `import * as api from ${JSON.stringify(pathToFileURL(target).href)};\nexport default api;\n`);
      run.candidate = { id: 'source-entry', packageName: a.project!.name ?? '', version: a.project!.version ?? '', tarball: '', tarballSha256: '', files: [], consumerDir: root, entryFile, installedAt: new Date().toISOString(), boundary: { ok: false, notes: [`2단계 건너뜀: 배포 tarball이 아니라 ${path.relative(root, target)}를 직접 import함 — 배포물 검증 아님`] }, source: true };
      endStage(s2, 'not-run', `사용자 요청으로 건너뜀(STAGE_SKIP_STAGE2=1) — 배포 후보 미검증, 3단계는 ${path.relative(root, target)}를 직접 사용`);
      s3.status = 'preparing';
      s3.reason = '사용자 조작 대기(2단계 건너뜀) — 생성된 화면에서 입력을 조작하고 Stage/Mock으로 실행';
      this.touch(run);
      return;
    }
    startStage(s2, '배포 후보 준비');
    const jc = await this.enqueue(run, { stage: 2, kind: 'candidate', label: '배포 후보 생성(npm pack)·컨슈머 샌드박스 설치' }, async (job, signal) => {
      run.candidate = await prepareCandidate(root, this.sandboxRoot, (m) => { job.logs.push(m); this.touch(run); }, signal);
      job.logs.push(`배포 후보: ${run.candidate.id}, sha256=${run.candidate.tarballSha256}`);
      job.status = 'passed';
      job.reason = `${run.candidate.id} 설치 완료`;
    });
    if (run.cancelled) return;
    if (jc.status !== 'passed' || !run.candidate) { endStage(s2, jc.status === 'passed' ? 'failed' : jc.status, `배포 후보 준비 실패: ${jc.reason}`); skipRest([s3], '2단계가 성공하지 않아 미실행'); return; }
    const jt = await this.enqueue(run, { stage: 2, kind: 'contract', label: '배포 후보 타입 선언(.d.ts) 공개 계약 대조' }, async (job) => {
      run.contract = checkCandidateContract(run.candidate!, a.scenarios, cfg?.consumer?.setup?.export);
      const mm = run.contract.findings.filter((f) => f.level === 'mismatch');
      job.logs.push(`타입 선언: ${run.contract.typesFile ?? '없음'}`, ...run.contract.findings.map((f) => `${f.level}: ${f.message}`));
      job.status = mm.length ? 'failed' : 'passed';
      job.reason = mm.length ? `계약 불일치 ${mm.length}건` : `공개 계약 대조 통과(${run.contract.typesFile ?? '타입 없음'})`;
    });
    if (run.cancelled) return;

    const entryUrl = pathToFileURL(run.candidate.entryFile).href;
    const auto = a.scenarios.filter((s) => s.support.status === 'auto');
    const scenarioJobs = auto.map((sc) => this.enqueue(run, { stage: 2, kind: 'scenario', scenarioId: sc.id, mode: 'doubles', label: `배포 후보 공개 API로 시나리오 실행: ${sc.title}` }, async (job, signal) => {
      const out = await this.child({ type: 'scenario', entryUrl, scenario: sc, mode: 'doubles' }, run.candidate!.consumerDir, signal);
      job.outcome = out;
      job.status = out.status;
      job.reason = summarize(out);
    }));
    const variants: any[] = cfg?.mock?.variants ?? [];
    const setup = cfg?.consumer?.setup;
    const variantJobs = setup ? variants.map((v) => this.enqueue(run, { stage: 2, kind: 'variant', mode: 'mock', label: `Mock 연결 변형: ${v.name} (${v.operation})` }, async (job, signal) => {
      const routes = mergeRoutes(cfg.mock.routes ?? [], v.routes ?? []);
      const setupArgs = this.resolveSetup(setup.args, 'mock', v.setupOverrides);
      const ret = run.contract?.consumerReturns[v.operation];
      const out = await this.child({
        type: 'consumer', entryUrl, mode: 'mock', routes, setup: { export: setup.export, args: setupArgs },
        operation: { method: v.operation, args: v.args ?? [], mutation: !!cfg.operations?.[v.operation]?.mutation, returns: v.expect?.rejects ? undefined : ret?.schema, returnsText: ret?.text },
        originalErrorChecks: [], expect: v.expect,
      }, run.candidate!.consumerDir, signal);
      job.outcome = out;
      job.status = out.status;
      job.reason = summarize(out);
    })) : [];
    const done = await Promise.all([...scenarioJobs, ...variantJobs]);
    if (run.cancelled) return;
    const notRun = a.scenarios.filter((s) => s.support.status !== 'auto');
    const failed = [jt, ...done].filter((j) => j.status !== 'passed');
    const executed = done.filter((j) => j.kind === 'scenario').length;
    if (executed === 0) { endStage(s2, 'failed', '배포 후보에서 실행한 시나리오 0개 — 통과로 처리하지 않음'); skipRest([s3], '2단계가 성공하지 않아 미실행'); return; }
    if (failed.length) { endStage(s2, 'failed', `실패 ${failed.length}건: ${failed.map((j) => j.label).join(' / ')}`); skipRest([s3], '2단계가 성공하지 않아 미실행'); return; }
    endStage(s2, 'passed', `시나리오 ${executed}개·Mock 변형 ${variantJobs.length}개 통과${notRun.length ? `, 미실행 ${notRun.length}개(${notRun.map((s) => `${s.title}: ${s.support.status}`).join(', ')})` : ''}`);
    s3.status = 'preparing';
    s3.reason = '사용자 조작 대기 — 생성된 화면에서 입력을 조작하고 Stage/Mock으로 실행';
    this.touch(run);
  }

  /** 스크립트 SUT: 2단계 = 샌드박스에서 스크립트 실행 + 산출물 pack·소비자 샌드박스 설치, 3단계 = exports 런타임 import 검증. */
  private async scriptPipeline(run: Run, a: AnalysisResult, h: { startStage: (s: StageState, r: string) => void; endStage: (s: StageState, st: ExecStatus, r: string) => void; skipRest: (from: StageState[], why: string) => void }) {
    const [, s2, s3] = run.stages;
    const root = run.project.root;
    const target = a.script!;
    h.startStage(s2, '스크립트를 샌드박스에서 실행');
    const js = await this.enqueue(run, { stage: 2, kind: 'script', label: `스크립트 실행(샌드박스 복사본): ${target.file}` }, async (job, signal) => {
      const { sandboxProject: _sb, ...res } = await runScriptSandbox({ projectRoot: root, scriptRel: target.file, sandboxRoot: this.sandboxRoot, log: (m) => { job.logs.push(m); this.touch(run); }, signal, timeoutMs: job.timeoutMs - 5000 });
      run.script = res;
      const ok = res.exitCode === 0 && !!res.distDir;
      job.status = ok ? 'passed' : 'failed';
      job.reason = ok ? `스크립트 정상 종료 — 변경 연산 ${res.mutations.length}개, 산출물 변화 ${res.diff.total}개` : `스크립트 실패(종료 코드 ${res.exitCode}): ${res.error ?? '산출물(dist)이 만들어지지 않음'}`;
    });
    if (run.cancelled) return;
    if (js.status !== 'passed' || !run.script?.distDir) { h.endStage(s2, js.status === 'passed' ? 'failed' : js.status, js.reason ?? '스크립트 실행 실패'); h.skipRest([s3], '2단계가 성공하지 않아 미실행'); return; }
    const distDir = run.script.distDir;
    const jc = await this.enqueue(run, { stage: 2, kind: 'candidate', label: '산출물 pack·소비자 샌드박스 설치(peer 의존성 포함)' }, async (job, signal) => {
      const peers = this.peerVersions(root, distDir);
      job.logs.push(`소비자가 이미 가진 peer 의존성: ${Object.entries(peers).map(([n, v]) => `${n}@${v}`).join(', ') || '없음'}`);
      run.candidate = await prepareCandidate(distDir, this.sandboxRoot, (m) => { job.logs.push(m); this.touch(run); }, signal, { extraDependencies: peers });
      job.status = 'passed';
      job.reason = `${run.candidate.id} 설치 완료`;
    });
    if (run.cancelled) return;
    if (jc.status !== 'passed' || !run.candidate) { h.endStage(s2, jc.status === 'passed' ? 'failed' : jc.status, `산출물 설치 실패: ${jc.reason}`); h.skipRest([s3], '2단계가 성공하지 않아 미실행'); return; }
    h.endStage(s2, 'passed', `스크립트 실행·산출물 설치 완료 (${run.candidate.id})`);
    s3.status = 'preparing';
    s3.reason = '사용자 확인 대기 — 배포 exports 런타임 import 검증을 실행하세요';
    this.touch(run);
  }

  /** 배포 패키지가 선언한 peer 의존성 중 프로젝트(개발 환경)가 쓰는 정확한 버전을 소비자 샌드박스에도 설치한다. */
  peerVersions(root: string, distDir: string): Record<string, string> {
    const readJson = (f: string) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return {}; } };
    const peers = Object.keys(readJson(path.join(distDir, 'package.json')).peerDependencies ?? {});
    const proj = readJson(path.join(root, 'package.json'));
    const have = { ...(proj.devDependencies ?? {}), ...(proj.dependencies ?? {}) } as Record<string, string>;
    return Object.fromEntries(peers.filter((n) => have[n]).map((n) => [n, have[n]]));
  }

  /** 3단계(스크립트 SUT): 설치된 배포 패키지의 exports를 런타임으로 import해 본다. */
  async checkExports(runId: string): Promise<Job> {
    const run = this.runs.get(runId);
    if (!run) throw new HttpError(404, '실행 없음');
    if (run.cancelled) throw new HttpError(409, '취소된 실행');
    const s3 = run.stages[2];
    if (s3.status !== 'preparing' && s3.status !== 'running') throw new HttpError(409, `3단계를 진행할 수 없음: ${s3.reason}`);
    if (!run.script || !run.candidate) throw new HttpError(409, '이 실행은 스크립트 SUT가 아님');
    const cand = run.candidate;
    if (s3.status === 'preparing') { s3.status = 'running'; s3.reason = 'exports 런타임 import 검증 진행 중'; s3.startedAt = new Date().toISOString(); }
    return this.enqueue(run, { stage: 3, kind: 'exports', label: `배포 exports 런타임 import 검증: ${cand.packageName}` }, async (job, signal) => {
      const r = await verifyExports({ consumerDir: cand.consumerDir, pkgName: cand.packageName, signal, log: (m) => { job.logs.push(m); this.touch(run); } });
      run.exportsCheck = r;
      job.status = r.counts.fail ? 'failed' : 'passed';
      job.reason = `exports ${r.total}개: 통과 ${r.counts.pass}, 확인 필요 ${r.counts['needs-review']}, 실패 ${r.counts.fail}`;
      if (run.stages[2].status === 'running') run.stages[2].reason = `검증 완료(${job.reason}) — 결과를 확인하고 3단계 판정을 확정하세요`;
    });
  }

  resolveSetup(args: Value[], mode: 'mock' | 'stage', overrides?: Record<string, Value>): Value[] {
    const missing: string[] = [];
    const resolve = (v: any): any => {
      if (Array.isArray(v)) return v.map(resolve);
      if (v && typeof v === 'object') {
        if (typeof v.$env === 'string') {
          const val = this.env[v.$env];
          if (val === undefined || val === '') {
            if (mode === 'mock') return v.$env.endsWith('URL') ? 'http://mock.invalid' : 'mock-placeholder';
            missing.push(v.$env);
            return undefined;
          }
          return val;
        }
        const o: any = {};
        for (const [k, x] of Object.entries(v)) o[k] = resolve(x);
        return o;
      }
      return v;
    };
    const out = resolve(args);
    if (overrides && out[0] && typeof out[0] === 'object') Object.assign(out[0], overrides);
    if (missing.length) throw new EnvBlocked(`Stage 연결 설정 없음: 환경 변수 ${missing.join(', ')} 미설정(.env.stage 참고)`);
    return out;
  }

  child(payload: ChildJob, cwd: string, signal: AbortSignal): Promise<ExecOutcome> {
    return new Promise((resolve, reject) => {
      const secrets = this.secretValues();
      const c = fork(CHILD, [], {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        env: { PATH: process.env.PATH ?? '', NODE_ENV: 'production', STAGE_SECRET_VALUES: secrets.join('\u0000') },
      });
      let out = ''; let settled = false;
      c.stdout!.on('data', (d) => { out += d; });
      c.stderr!.on('data', (d) => { out += d; });
      const kill = () => { c.kill('SIGKILL'); };
      signal.addEventListener('abort', kill, { once: true });
      c.on('message', (m: any) => { if (m?.type === 'result') { settled = true; const o: ExecOutcome = m.outcome; if (out.trim()) o.logs.push(redactText(`[프로세스 출력] ${out.trim().slice(-4000)}`, secrets)); resolve(o); } });
      c.on('exit', (code, sig) => {
        signal.removeEventListener('abort', kill);
        if (!settled) reject(new Error(signal.aborted ? 'aborted' : `실행 프로세스 비정상 종료(code=${code}, signal=${sig}): ${redactText(out.slice(-2000), secrets)}`));
      });
      c.send(payload);
    });
  }

  // ---- 3단계 사용자 조작 ----
  async interact(runId: string, req: { scenarioId: string; stepId?: string; mode: 'mock' | 'stage'; args: Value[]; routes?: MockRoute[] }): Promise<Job> {
    const run = this.runs.get(runId);
    if (!run) throw new HttpError(404, '실행 없음');
    const s3 = run.stages[2];
    if (run.cancelled) throw new HttpError(409, '취소된 실행');
    if (s3.status !== 'preparing' && s3.status !== 'running') throw new HttpError(409, `3단계를 진행할 수 없음: ${s3.reason}`);
    const a = this.analyses.get(run.analysisId)!;
    const sc = a.scenarios.find((s) => s.id === req.scenarioId);
    if (!sc) throw new HttpError(404, '시나리오 없음');
    if (sc.consumerLink?.status !== 'linked') throw new HttpError(409, `컨슈머 초기화 경로와 연결되지 않은 시나리오: ${sc.consumerLink?.evidence ?? '연결 정보 없음'}`);
    const step = sc.steps.find((s): s is Extract<Step, { kind: 'call' }> => s.kind === 'call' && !!s.method && (!req.stepId || s.id === req.stepId));
    if (!step) throw new HttpError(404, '조작 가능한 호출 단계 없음');
    const cfg = this.stageConfig(run.project.root);
    const opCfg = cfg?.operations?.[step.method!] ?? {};
    const originalArgs = step.args.map((x) => (x.kind === 'value' ? x.value : { $stage: 'double', id: (x as any).id }));
    const userArgs = structuredClone(req.args);
    const changed = JSON.stringify(normalize(userArgs)) !== JSON.stringify(normalize(originalArgs.slice(0, userArgs.length))) || userArgs.length < originalArgs.filter((v: any) => !(v && v.$stage === 'undefined')).length;
    const callArgs: any[] = structuredClone(userArgs);
    const frameworkArgs: InteractionInput['frameworkArgs'] = [];
    const attempt = run.jobs.filter((j) => j.kind === 'interaction' && j.scenarioId === sc.id).length + 1;
    if (opCfg.mutation && opCfg.idempotency && req.mode === 'stage') {
      const { argIndex, field } = opCfg.idempotency;
      const userSet = callArgs[argIndex]?.[field];
      const origSet = (originalArgs[argIndex] as any)?.[field];
      if (userSet === undefined || userSet === origSet) {
        while (callArgs.length <= argIndex) callArgs.push({ $stage: 'undefined' });
        if (!callArgs[argIndex] || typeof callArgs[argIndex] !== 'object' || callArgs[argIndex].$stage === 'undefined') callArgs[argIndex] = {};
        const key = `stage-${run.id}-${sc.id}-${attempt}`;
        callArgs[argIndex][field] = key;
        frameworkArgs.push({ path: `[${argIndex}].${field}`, value: key, reason: origSet !== undefined ? `원본 테스트 값 ${JSON.stringify(origSet)} 대신 실행별 멱등성 키 사용(실제 서버 데이터 식별·중복 방지)` : '실행별 멱등성 키(실행 식별·중복 방지)' });
      }
    }
    const stage2 = run.jobs.find((j) => j.kind === 'scenario' && j.scenarioId === sc.id && j.status === 'passed');
    const collaboratorCalls = stage2?.outcome?.events.filter((e) => e.kind === 'double-call').length;
    const keepErrorChecks = !changed && collaboratorCalls === 0;
    const parentChecks: CheckResult[] = [];
    const originalErrorChecks: any[] = [];
    for (const st of sc.steps) {
      if (st.kind !== 'check') continue;
      const c = st.check;
      if (c.kind === 'error' && c.step === step.id && keepErrorChecks) {
        const m = c.matcher;
        const exportName = m?.kind === 'ctor' ? sc.targets.find((t) => t.id === m.target)?.publicApi.exportName : undefined;
        originalErrorChecks.push({ id: c.id, op: c.op, module: c.module, matcher: m?.kind === 'ctor' ? { kind: 'ctor', exportName } : m, source: c.source, loc: c.loc });
        continue;
      }
      parentChecks.push({
        id: c.id, label: c.source, loc: c.loc, origin: 'original-test',
        status: changed ? 'invalidated' : 'not-applicable',
        reason: changed
          ? '사용자가 입력을 바꿔 원본 기대 조건이 무효 — 자동 통과시키지 않음'
          : collaboratorCalls === undefined
            ? '2단계 관찰 결과 없음 — 원본 기대값과 비교하지 않음'
            : `원본 기대값은 테스트 대체 객체 응답에 의존(2단계에서 협력 객체 호출 ${collaboratorCalls}회 관찰) — 실제 연결 결과와 고정값 비교하지 않음`,
      });
    }
    const setup = cfg.consumer.setup;
    const routes = req.routes ?? cfg?.mock?.routes ?? [];
    const target = req.mode === 'stage' ? run.environment.stageTarget ?? '미설정' : 'mock(fetch 가로채기)';
    const input: InteractionInput = { scenarioId: sc.id, stepId: step.id, method: step.method!, originalArgs, userArgs, frameworkArgs, changed, routes: req.mode === 'mock' ? routes : undefined, connection: { mode: req.mode, target } };
    if (s3.status === 'preparing') { s3.status = 'running'; s3.reason = '사용자 조작 진행 중'; s3.startedAt = new Date().toISOString(); }
    const ret = run.contract?.consumerReturns[step.method!];
    return this.enqueue(run, { stage: 3, kind: 'interaction', scenarioId: sc.id, mode: req.mode, attempt, input, label: `${req.mode === 'stage' ? 'Stage' : 'Mock'} 조작 #${attempt}: ${sc.title} → ${step.method}` }, async (job, signal) => {
      let setupArgs: Value[];
      try { setupArgs = this.resolveSetup(setup.args, req.mode); } catch (e) {
        if (e instanceof EnvBlocked) { job.outcome = { status: 'failed', checks: parentChecks, events: [], network: [], logs: [e.message], linkVerdict: 'environment-blocked', verdictReason: e.message }; job.status = 'failed'; job.reason = e.message; return; }
        throw e;
      }
      const followUp = opCfg.mutation && opCfg.followUp ? opCfg.followUp : undefined;
      const out = await this.child({
        type: 'consumer', entryUrl: pathToFileURL(run.candidate!.entryFile).href, mode: req.mode, routes, setup: { export: setup.export, args: setupArgs },
        operation: { method: step.method!, args: callArgs, mutation: !!opCfg.mutation, returns: ret?.schema, returnsText: ret?.text },
        originalErrorChecks, followUp,
      }, run.candidate!.consumerDir, signal).catch((e) => {
        if (signal.aborted && signal.reason instanceof TimeoutSignal && opCfg.mutation && req.mode === 'stage') {
          // 변경 요청이 처리됐는지 알 수 없다. 자동 재전송하지 않는다.
          job.outcome = { status: 'timeout', checks: parentChecks, events: [], network: [], logs: ['시간 제한으로 실행 프로세스 종료'], linkVerdict: 'outcome-unknown', verdictReason: '변경 요청 중 시간 제한 — 서버 처리 여부 불명, 재전송하지 않음(후속 조회로 확인 필요)' };
        }
        throw e;
      });
      out.checks = [...out.checks, ...parentChecks];
      job.outcome = out;
      job.status = out.status;
      job.reason = req.mode === 'stage' ? `${out.linkVerdict ?? '판정 없음'}: ${out.verdictReason}` : summarize(out);
    });
  }

  /** 3단계 판정 확정: Stage 모드 조작의 시나리오별 최신 결과로만 판단한다. Mock 조작은 별도로 보고한다. */
  completeStage3(runId: string) {
    const run = this.runs.get(runId);
    if (!run) throw new HttpError(404, '실행 없음');
    const s3 = run.stages[2];
    if (s3.status !== 'running' && s3.status !== 'preparing') throw new HttpError(409, `3단계 상태가 ${s3.status}`);
    if (this.queue.some((p) => p.job.runId === runId) || run.jobs.some((j) => this.running.has(j.id))) throw new HttpError(409, '진행 중인 작업이 있음');
    if (run.script) {
      const ec = run.exportsCheck;
      s3.endedAt = new Date().toISOString();
      const left = run.script.leftovers.length;
      if (!ec) { s3.status = 'failed'; s3.reason = 'exports 런타임 import 검증 0건 — 배포 exports 연결을 증명하지 않음'; }
      else if (ec.counts.fail) { const bad = ec.items.filter((i) => i.verdict === 'fail').map((i) => i.key); s3.status = 'failed'; s3.reason = `exports ${ec.counts.fail}개 import 실패: ${bad.slice(0, 5).join(', ')}${bad.length > 5 ? ' 외' : ''}`; }
      else if (left) { s3.status = 'failed'; s3.reason = `하위 패키지 이름이 치환되지 않고 남은 파일 ${left}개`; }
      else { s3.status = 'passed'; s3.reason = `exports ${ec.total}개 번들러 해석·평가 통과${ec.counts['needs-review'] ? `, 확인 필요 ${ec.counts['needs-review']}개(사람이 확인)` : ''}`; }
      this.touch(run);
      return run;
    }
    const a = this.analyses.get(run.analysisId)!;
    const linked = a.scenarios.filter((s) => s.support.status === 'auto' && s.consumerLink?.status === 'linked');
    const latest = linked.map((sc) => ({ sc, job: [...run.jobs].reverse().find((j) => j.kind === 'interaction' && j.scenarioId === sc.id && j.mode === 'stage') }));
    const done = latest.filter((x) => x.job);
    const notDone = latest.filter((x) => !x.job);
    const bad = done.filter((x) => x.job!.outcome?.linkVerdict !== 'pass');
    s3.endedAt = new Date().toISOString();
    if (done.length === 0) { s3.status = 'failed'; s3.reason = 'Stage 모드 조작 0건 — 실제 연계를 검증하지 않음'; }
    else if (bad.length) { s3.status = 'failed'; s3.reason = `Stage 연계 미통과: ${bad.map((x) => `${x.sc.title}(${x.job!.outcome?.linkVerdict ?? x.job!.status})`).join(', ')}`; }
    else { s3.status = 'passed'; s3.reason = `Stage 연계 통과 ${done.length}개 시나리오${notDone.length ? `, 미실행 ${notDone.length}개(${notDone.map((x) => x.sc.title).join(', ')})` : ''}`; }
    this.touch(run);
    return run;
  }

  addManual(runId: string, m: { target: string; verdict: ManualCheck['verdict']; note: string }) {
    const run = this.runs.get(runId);
    if (!run) throw new HttpError(404, '실행 없음');
    if (!['confirmed', 'issue', 'note'].includes(m.verdict)) throw new HttpError(400, 'verdict는 confirmed/issue/note');
    run.manual.push({ id: newId('man'), at: new Date().toISOString(), target: String(m.target).slice(0, 200), verdict: m.verdict, note: redactText(String(m.note).slice(0, 2000), this.secretValues()) });
    this.touch(run);
    return run;
  }

  rerun(runId: string) {
    const run = this.runs.get(runId);
    if (!run) throw new HttpError(404, '실행 없음');
    return this.createRun(run.analysisId, run.id);
  }

  async idle() {
    while (this.queue.length || this.running.size) await new Promise((r) => setTimeout(r, 20));
  }
}

class TimeoutSignal extends Error { constructor() { super('timeout'); } }
class EnvBlocked extends Error {}
export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}

function summarize(o: ExecOutcome): string {
  const p = o.checks.filter((c) => c.status === 'pass').length;
  const f = o.checks.filter((c) => c.status === 'fail').length;
  const n = o.checks.filter((c) => c.status !== 'pass' && c.status !== 'fail').length;
  const err = o.error && (o.error as any).message ? ` / 오류: ${(o.error as any).message}` : '';
  return `검증 통과 ${p}, 실패 ${f}${n ? `, 비교 제외 ${n}` : ''}${err}`;
}

function mergeRoutes(base: MockRoute[], overrides: MockRoute[]): MockRoute[] {
  const key = (r: MockRoute) => `${r.method} ${r.path ?? ''}${r.pathPrefix ? r.pathPrefix + '*' : ''}`;
  const o = new Map(overrides.map((r) => [key(r), r]));
  return [...overrides, ...base.filter((r) => !o.has(key(r)))];
}

function normalize(v: any): any {
  if (Array.isArray(v)) { const a = v.map(normalize); while (a.length && a[a.length - 1] === '__undef__') a.pop(); return a; }
  if (v && typeof v === 'object') {
    if (v.$stage === 'undefined') return '__undef__';
    const o: any = {};
    for (const k of Object.keys(v).sort()) { const x = normalize(v[k]); if (x !== '__undef__') o[k] = x; }
    return o;
  }
  return v;
}

function collectSecretEnv(v: any, out: Set<string>) {
  if (Array.isArray(v)) v.forEach((x) => collectSecretEnv(x, out));
  else if (v && typeof v === 'object') {
    if (typeof v.$env === 'string' && v.secret) out.add(v.$env);
    else Object.values(v).forEach((x) => collectSecretEnv(x, out));
  }
}
