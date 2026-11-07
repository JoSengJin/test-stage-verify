// 스크립트 SUT 실행: 프로젝트를 임시 폴더로 복사한 샌드박스에서 스크립트를 실제로 실행하고(원본 저장소는 건드리지 않는다),
// fs 연산 순서·산출물 변화·하위 패키지 이름 치환 잔여를 수집한다.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FsTraceEvent, ScriptRunResult, TreeDiff } from '../model.ts';
import { runProc } from './candidate.ts';

const CHILD = path.join(path.dirname(fileURLToPath(import.meta.url)), 'script-child.mjs');
const SKIP_DIRS = new Set(['node_modules', '.git', '.idea', '.next', 'coverage', '.stage-data']);
const TEXT_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.mts', '.map', '.json']);
const LIST_CAP = 300;

/** 스크립트가 쓰는 파일은 복사하고, node_modules는 링크로 연결한다. 루트의 dist는 스크립트가 새로 만들므로 복사하지 않는다. */
export function copyProject(projectRoot: string, dest: string) {
  const root = path.resolve(projectRoot);
  fs.cpSync(root, dest, {
    recursive: true,
    filter: (p) => !SKIP_DIRS.has(path.basename(p)) && !(path.dirname(p) === root && path.basename(p) === 'dist'),
  });
  const nm = path.join(root, 'node_modules');
  if (fs.existsSync(nm)) fs.symlinkSync(nm, path.join(dest, 'node_modules'));
}

export function snapshotTree(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!fs.existsSync(dir)) return out;
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) out.set(path.relative(dir, p), crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'));
    }
  };
  walk(dir);
  return out;
}

export function diffTrees(before: Map<string, string>, after: Map<string, string>): TreeDiff {
  const added: string[] = [], removed: string[] = [], changed: string[] = [];
  for (const [f, h] of after) { if (!before.has(f)) added.push(f); else if (before.get(f) !== h) changed.push(f); }
  for (const f of before.keys()) if (!after.has(f)) removed.push(f);
  const total = added.length + removed.length + changed.length;
  return { baselineExists: before.size > 0, added: added.sort().slice(0, LIST_CAP), removed: removed.sort().slice(0, LIST_CAP), changed: changed.sort().slice(0, LIST_CAP), total };
}

/** 하위 패키지(packages/<name>) 이름. 배포본에는 이 이름이 남아 있으면 안 된다(배포 패키지 경로로 치환되어야 함). */
function internalNames(projectRoot: string): string[] {
  const pkgsDir = path.join(projectRoot, 'packages');
  if (!fs.existsSync(pkgsDir)) return [];
  let listed: string[] | undefined;
  try { listed = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8')).files; } catch { /* 없음 */ }
  const dirs = (Array.isArray(listed) ? listed : fs.readdirSync(pkgsDir)).filter((d) => fs.existsSync(path.join(pkgsDir, d, 'package.json')));
  return dirs.flatMap((d) => { try { return [JSON.parse(fs.readFileSync(path.join(pkgsDir, d, 'package.json'), 'utf8')).name as string]; } catch { return []; } }).filter(Boolean);
}

export function findLeftovers(distDir: string, names: string[]): ScriptRunResult['leftovers'] {
  const out: ScriptRunResult['leftovers'] = [];
  if (!names.length || !fs.existsSync(distDir)) return out;
  const walk = (d: string) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!TEXT_EXT.has(path.extname(e.name)) || e.name === 'package.json' || fs.statSync(p).size > 2_000_000) continue;
      const text = fs.readFileSync(p, 'utf8');
      for (const name of names) {
        const count = text.split(name).length - 1;
        if (count && out.length < LIST_CAP) out.push({ file: path.relative(distDir, p), name, count });
      }
    }
  };
  walk(distDir);
  return out;
}

export interface ScriptSandboxOptions {
  projectRoot: string;
  /** 프로젝트 루트 기준 스크립트 경로 */
  scriptRel: string;
  sandboxRoot: string;
  log: (m: string) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export async function runScriptSandbox(o: ScriptSandboxOptions): Promise<ScriptRunResult & { sandboxProject: string }> {
  const t0 = performance.now();
  fs.mkdirSync(o.sandboxRoot, { recursive: true });
  const work = fs.mkdtempSync(path.join(o.sandboxRoot, 'script-'));
  const proj = path.join(work, 'project');
  o.log(`프로젝트를 샌드박스로 복사 (node_modules는 링크, 원본 저장소는 변경하지 않음): ${proj}`);
  copyProject(o.projectRoot, proj);
  const baseline = snapshotTree(path.join(o.projectRoot, 'dist'));
  const traceOut = path.join(work, 'trace.json');
  o.log(`스크립트 실행: node ${o.scriptRel} (node:fs 호출을 실제로 수행하며 기록)`);
  const r = await runProc(process.execPath, [CHILD, path.join(proj, o.scriptRel), traceOut], { cwd: proj, signal: o.signal, timeoutMs: o.timeoutMs ?? 120_000 });
  if (r.killed) throw new Error('스크립트 실행 취소/시간 초과');
  let trace: { mutations: FsTraceEvent[]; readCounts: Record<string, number>; truncated: boolean; error?: string } = { mutations: [], readCounts: {}, truncated: false };
  try { trace = JSON.parse(fs.readFileSync(traceOut, 'utf8')); } catch { /* 기록 전에 종료 */ }
  const distDir = path.join(proj, 'dist');
  const after = snapshotTree(distDir);
  const error = trace.error ?? (r.code !== 0 ? (r.stderr || r.stdout).trim().split('\n').slice(-6).join('\n') : undefined);
  return {
    scriptFile: o.scriptRel, exitCode: r.code, error,
    mutations: trace.mutations, readCounts: trace.readCounts, truncated: trace.truncated,
    diff: diffTrees(baseline, after),
    leftovers: findLeftovers(distDir, internalNames(proj)),
    distDir: fs.existsSync(distDir) ? distDir : undefined,
    durationMs: Math.round(performance.now() - t0),
    sandboxProject: proj,
  };
}
