// 1단계: 프로젝트가 쓰는 기존 러너로 원본 테스트를 그대로 실행한다. assertion·종료 상태를 보존한다.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExecStatus, RunnerInfo } from '../model.ts';
import { runProc } from './candidate.ts';

const REPORTER = path.join(path.dirname(fileURLToPath(import.meta.url)), 'reporter.mjs');

export interface Stage1Test {
  name: string;
  line?: number;
  column?: number;
  status: 'pass' | 'fail' | 'skip' | 'todo';
  durationMs?: number;
  error?: { message: string; code?: string; operator?: string; expected?: unknown; actual?: unknown; failureType?: string };
}

export interface Stage1Result {
  status: ExecStatus;
  reason: string;
  command: string;
  exitCode: number | null;
  tests: Stage1Test[];
  summary?: unknown;
  output: string;
}

function importsNodeTest(file: string): boolean {
  try { return /from\s+['"](?:node:)?test['"]|require\(\s*['"](?:node:)?test['"]\s*\)|import\s+['"]node:test['"]/.test(fs.readFileSync(file, 'utf8')); } catch { return false; }
}

export async function runStage1(opts: { projectRoot: string; testFile: string; runner?: RunnerInfo; outDir: string; signal: AbortSignal; timeoutMs: number; extraNodeArgs?: string[]; extraEnv?: Record<string, string>; eventsName?: string }): Promise<Stage1Result> {
  let { runner } = opts;
  // scripts.test가 래퍼(예: 워크스페이스 위임)라 인식되지 않아도, 테스트 파일이 node:test를 직접 import하면 node --test로 단독 실행한다.
  if ((!runner || runner.kind !== 'node-test') && importsNodeTest(opts.testFile)) {
    runner = { kind: 'node-test', flags: [], script: runner?.script, evidence: `${runner?.evidence ?? '러너 정보 없음'} → 테스트 파일이 node:test를 직접 import하므로 node --test로 단독 실행` };
  }
  if (!runner || runner.kind !== 'node-test') {
    return { status: 'failed', reason: `사용 가능한 러너 인식기 없음: ${runner?.evidence ?? '러너 정보 없음'} — 1단계를 실행하지 않았으며 통과로 처리하지 않음`, command: '', exitCode: null, tests: [], output: '' };
  }
  fs.mkdirSync(opts.outDir, { recursive: true });
  const events = path.join(opts.outDir, opts.eventsName ?? 'stage1-events.ndjson');
  const rel = path.relative(opts.projectRoot, opts.testFile);
  const args = [...(opts.extraNodeArgs ?? []), ...runner.flags, '--test', `--test-reporter=${REPORTER}`, `--test-reporter-destination=${events}`, '--test-reporter=spec', '--test-reporter-destination=stdout', rel];
  const command = `node ${args.join(' ')}`;
  // 상위 프로세스가 node --test 아래에서 돌 때 상속되는 NODE_TEST_CONTEXT를 제거해야 원본 러너가 독립 실행된다.
  const env = { ...process.env, ...(opts.extraEnv ?? {}) };
  delete env.NODE_TEST_CONTEXT;
  const r = await runProc(process.execPath, args, { cwd: opts.projectRoot, env, signal: opts.signal, timeoutMs: opts.timeoutMs });
  const output = (r.stdout + (r.stderr ? `\n[stderr]\n${r.stderr}` : '')).slice(-20000);
  if (r.killed) return { status: opts.signal.aborted ? 'cancelled' : 'timeout', reason: opts.signal.aborted ? '사용자 취소' : `시간 제한 ${opts.timeoutMs}ms 초과`, command, exitCode: r.code, tests: [], output };
  const tests: Stage1Test[] = [];
  let summary: unknown;
  const lines = fs.existsSync(events) ? fs.readFileSync(events, 'utf8').split('\n').filter(Boolean) : [];
  for (const line of lines) {
    const e = JSON.parse(line);
    if ((e.type === 'test:pass' || e.type === 'test:fail') && e.testType === 'test') {
      tests.push({
        name: e.name, line: e.line, column: e.column, durationMs: e.durationMs,
        status: e.skip !== undefined ? 'skip' : e.todo !== undefined ? 'todo' : e.type === 'test:pass' ? 'pass' : 'fail',
        error: e.type === 'test:fail' ? e.error : undefined,
      });
    }
    if (e.type === 'test:summary' && e.nesting === undefined) summary = e.counts;
    if (e.type === 'test:summary') summary = e.counts ?? summary;
  }
  const fail = tests.filter((t) => t.status === 'fail').length;
  const skipped = tests.filter((t) => t.status === 'skip' || t.status === 'todo').length;
  let status: ExecStatus = 'passed';
  let reason = `러너 종료 코드 ${r.code}, 테스트 ${tests.length}개 통과`;
  if (tests.length === 0) { status = 'failed'; reason = `실행된 테스트 0개(종료 코드 ${r.code}) — 통과로 처리하지 않음`; }
  else if (fail > 0 || r.code !== 0) { status = 'failed'; reason = `실패 ${fail}개, 종료 코드 ${r.code}`; }
  else if (skipped > 0) { status = 'failed'; reason = `skip/todo ${skipped}개 — 필수 항목 미실행을 통과로 처리하지 않음`; }
  return { status, reason, command, exitCode: r.code, tests, summary, output };
}
