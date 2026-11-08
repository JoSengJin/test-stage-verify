// 비대화형 게이트: 화면 없이 한 테스트 파일을 1·2·3단계로 검증하고 종료 코드로 배포 가능 여부를 알린다.
// 실행: node stage/src/ci.ts --project <패키지 경로> --test <테스트 파일> [--out <보고서.json>] [--data <저장 경로>] [--allow-conditional]
// 종료 코드: 0 검증 범위 내 통과 · 1 실패/보류 · 10 조건부(미검증 범위 있음, --allow-conditional이면 0) · 3 사람의 확인이 필요해 자동 판정 불가 · 2 사용 오류
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { analyzeTestFile } from './analysis/analyze.ts';
import { RunManager, type Run } from './exec/runs.ts';
import { Store } from './store.ts';
import { buildReport, reportHtml } from './report.ts';

export const EXIT = { pass: 0, fail: 1, usage: 2, humanNeeded: 3, conditional: 10 } as const;

export interface CiOptions { project: string; test: string; out?: string; data?: string; allowConditional?: boolean; env?: NodeJS.ProcessEnv; sandboxRoot?: string; log?: (m: string) => void }
export interface CiResult { exitCode: number; message: string; run?: Run; analysis?: ReturnType<typeof analyzeTestFile>; report?: ReturnType<typeof buildReport> }

export async function runCi(o: CiOptions): Promise<CiResult> {
  const log = o.log ?? (() => {});
  const projectRoot = path.resolve(o.project);
  const testFile = path.resolve(projectRoot, o.test);
  if (!fs.existsSync(testFile)) return { exitCode: EXIT.usage, message: `테스트 파일 없음: ${testFile}` };
  const rm = new RunManager({ store: new Store(o.data ? path.resolve(o.data) : fs.mkdtempSync(path.join(os.tmpdir(), 'stage-ci-'))), env: o.env ?? process.env, sandboxRoot: o.sandboxRoot });
  const analysis = analyzeTestFile({ testFile, projectRoot, fileName: path.basename(testFile), linked: true, linkEvidence: 'CI에서 경로로 직접 지정' });
  rm.addAnalysis(analysis);
  let run: Run;
  try { run = rm.createRun(analysis.id); } catch (e: any) { return { exitCode: EXIT.usage, message: `실행 시작 불가: ${e.message}` }; }
  log(`실행 ${run.id} 시작: ${run.testFile.path}`);
  await rm.idle();
  // 파이프라인은 비동기로 이어진다(예: 재실행 모드의 3단계). 단계가 멈출 때까지 기다린다.
  for (let i = 0; i < 3000; i++) {
    const s3 = run.stages[2];
    if (['passed', 'failed', 'timeout', 'cancelled', 'not-run'].includes(s3.status) || ['failed', 'timeout', 'cancelled'].includes(run.stages[0].status) || ['failed', 'timeout', 'cancelled'].includes(run.stages[1].status)) break;
    if ((s3.status === 'preparing' || s3.status === 'running') && !rm.queue.length && !rm.running.size) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const s3 = run.stages[2];
  let humanNeeded = '';
  if (s3.status === 'preparing' || s3.status === 'running') {
    try {
      if (run.script && !run.exportsCheck) { await rm.checkExports(run.id); await rm.idle(); }
      rm.completeStage3(run.id, { by: 'ci', userAgent: 'stage-ci' });
    } catch (e: any) {
      // 사람이 화면에서 실제 협력자를 연결·확인해야 하는 단계는 자동 통과시키지 않는다.
      humanNeeded = `3단계에 사람의 확인이 필요합니다: ${e.message}`;
    }
  }
  const report = buildReport(run, analysis);
  if (o.out) {
    fs.mkdirSync(path.dirname(path.resolve(o.out)), { recursive: true });
    fs.writeFileSync(path.resolve(o.out), JSON.stringify(report, null, 2));
    fs.writeFileSync(path.resolve(o.out).replace(/\.json$/, '') + '.html', reportHtml(report));
  }
  const summary = `${report.decision.label}\n${report.decision.reasons.map((x) => `  - ${x}`).join('\n')}`;
  if (report.decision.code === 'hold-failure') return { exitCode: EXIT.fail, message: summary, run, analysis, report };
  if (humanNeeded) return { exitCode: EXIT.humanNeeded, message: `${humanNeeded}\n${summary}`, run, analysis, report };
  if (report.decision.code === 'within-scope-pass') return { exitCode: EXIT.pass, message: summary, run, analysis, report };
  if (report.decision.code === 'conditional') return { exitCode: o.allowConditional ? EXIT.pass : EXIT.conditional, message: summary, run, analysis, report };
  return { exitCode: EXIT.humanNeeded, message: summary, run, analysis, report };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  const args = process.argv.slice(2);
  const opt = (name: string) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const project = opt('--project'); const test = opt('--test');
  if (!project || !test) { console.error('사용법: node stage/src/ci.ts --project <패키지 경로> --test <테스트 파일> [--out 보고서.json] [--data 경로] [--allow-conditional]'); process.exit(EXIT.usage); }
  const r = await runCi({ project, test, out: opt('--out'), data: opt('--data'), allowConditional: args.includes('--allow-conditional'), log: (m) => console.log(m) });
  console.log(r.message);
  process.exit(r.exitCode);
}
