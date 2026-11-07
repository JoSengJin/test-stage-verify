// 배포 후보 재실행: 원본 테스트 파일을 그대로 두고, 프로젝트 dist import만 설치된 배포 후보 파일로 바꿔 같은 러너로 다시 실행한다.
// 런던파(mockist) 테스트처럼 입력→출력으로 일반화하기 어려운 테스트도 협력자 mock·assert를 원본 그대로 재사용해 검증한다.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RunnerInfo } from '../model.ts';
import type { CandidateInfo } from './candidate.ts';
import { runStage1, type Stage1Result } from './stage1.ts';

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), 'redirect-hook.mjs');

export interface ReplayResult {
  /** 배포 후보로 다시 실행한 원본 테스트 결과(1단계와 같은 형식) */
  run: Stage1Result;
  packageDir: string;
  from: string;
  /** 배포 후보 파일로 바뀐 모듈(패키지 기준 상대 경로) */
  redirected: string[];
  /** 프로젝트 dist에는 있으나 배포물에 없어 실패한 파일 */
  missing: string[];
}

export async function runReplay(opts: { projectRoot: string; testFile: string; runner?: RunnerInfo; fromDir: string; candidate: CandidateInfo; outDir: string; signal: AbortSignal; timeoutMs: number }): Promise<ReplayResult> {
  const packageDir = fs.realpathSync(path.join(opts.candidate.consumerDir, 'node_modules', opts.candidate.packageName));
  fs.mkdirSync(opts.outDir, { recursive: true });
  const log = path.join(opts.outDir, 'replay-redirects.ndjson');
  fs.rmSync(log, { force: true });
  const run = await runStage1({
    projectRoot: opts.projectRoot, testFile: opts.testFile, runner: opts.runner, outDir: opts.outDir, signal: opts.signal, timeoutMs: opts.timeoutMs,
    eventsName: 'replay-events.ndjson',
    extraNodeArgs: ['--import', HOOK],
    extraEnv: { STAGE_REDIRECT_FROM: opts.fromDir, STAGE_REDIRECT_TO: packageDir, STAGE_REDIRECT_ROOT: opts.projectRoot, STAGE_REDIRECT_LOG: log },
  });
  const redirected = new Set<string>();
  const missing = new Set<string>();
  if (fs.existsSync(log)) for (const line of fs.readFileSync(log, 'utf8').split('\n').filter(Boolean)) {
    const r = JSON.parse(line);
    if (r.redirected) redirected.add(r.redirected);
    if (r.missing) missing.add(r.missing);
  }
  return { run, packageDir, from: opts.fromDir, redirected: [...redirected].sort(), missing: [...missing].sort() };
}
