// 배포 exports 런타임 검증. 소비자 샌드박스에 설치된 배포 패키지의 package.json exports 항목(패턴은 펼쳐서)마다
//   1) 일반 Node ESM에서 직접 import
//   2) 소비자 번들러(esbuild, Next 같은 번들러 해석에 해당)로 해석·번들
//   3) 번들 결과를 Node에서 평가(모듈 최상위 코드 실행)
// 를 실제로 수행하고, 결과를 pass / needs-review / fail 로 구분한다. 오류를 숨기거나 자동으로 통과시키지 않는다.
import fs from 'node:fs';
import path from 'node:path';
import type { ExportCheckItem, ExportsCheck, ExportVerdict } from '../model.ts';
import { runProc } from './candidate.ts';

export interface ExportEntry { key: string; specifier: string; pattern?: string; json: boolean }

/** 조건부 exports 값에서 import에 쓰일 문자열 대상을 고른다. */
function pickTarget(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map(pickTarget).find(Boolean);
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    for (const c of ['import', 'node', 'default', 'require']) if (c in o) { const r = pickTarget(o[c]); if (r) return r; }
  }
  return undefined;
}

const specOf = (pkg: string, key: string) => (key === '.' ? pkg : pkg + key.slice(1));

/** exports 키를 모두 모은다. 패턴(./ffw/*)은 설치된 파일 구조에서 실제 항목으로 펼친다. */
export function expandExports(packageDir: string, pkgName: string): ExportEntry[] {
  const manifest = JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8'));
  const exp = manifest.exports;
  if (!exp || typeof exp !== 'object') return [{ key: '.', specifier: pkgName, json: false }];
  const map = new Map<string, ExportEntry>();
  const patterns: [string, string][] = [];
  for (const [key, value] of Object.entries<unknown>(exp)) {
    const target = pickTarget(value);
    if (!key.includes('*')) { map.set(key, { key, specifier: specOf(pkgName, key), json: !!target?.endsWith('.json') }); continue; }
    if (target?.includes('*') && key.indexOf('*') === key.length - 1) patterns.push([key, target]);
  }
  for (const [key, target] of patterns) {
    const [pre, post] = target.split('*') as [string, string];
    const baseDir = path.join(packageDir, pre);
    if (!fs.existsSync(baseDir)) continue;
    for (const e of fs.readdirSync(baseDir, { withFileTypes: true })) {
      let name: string | undefined;
      if (post.startsWith('/')) { if (e.isDirectory() && fs.existsSync(path.join(baseDir, e.name, post))) name = e.name; }
      else if (e.isFile() && e.name.endsWith(post) && post) name = e.name.slice(0, -post.length);
      if (!name) continue;
      const k = key.replace('*', name);
      if (!map.has(k)) map.set(k, { key: k, specifier: specOf(pkgName, k), pattern: key, json: target.endsWith('.json') });
    }
  }
  return [...map.values()].sort((a, b) => a.key.localeCompare(b.key));
}

const ENV_ERROR = /(window|document|self|navigator|localStorage|sessionStorage|location|indexedDB) is not defined|server-only|client-only|react-server|use client/i;

export function firstErrorLine(text: string): string {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  return (lines.find((l) => /^(\w*Error|Error)\b/.test(l) || /Cannot find|is not defined|not supported/.test(l)) ?? lines.at(-1) ?? '알 수 없는 오류').slice(0, 220);
}

/** 단계별 결과를 종합한다(순수 함수). */
export function judge(i: Pick<ExportCheckItem, 'node' | 'bundle' | 'run'> & { json?: boolean }): { verdict: ExportVerdict; reason: string } {
  if (i.json) return i.run.status === 'ok' ? { verdict: 'pass', reason: 'JSON 구성 파일이 존재하고 파싱됨' } : { verdict: 'fail', reason: `JSON을 읽지 못함: ${i.run.detail}` };
  if (i.bundle.status === 'failed') return { verdict: 'fail', reason: `번들러 해석 실패: ${i.bundle.detail}` };
  if (i.run.status === 'failed') {
    return ENV_ERROR.test(i.run.detail ?? '')
      ? { verdict: 'needs-review', reason: `실행 환경 차이로 보임(브라우저·서버 전용 코드일 수 있음): ${i.run.detail}` }
      : { verdict: 'fail', reason: `번들은 되지만 평가 중 오류: ${i.run.detail}` };
  }
  if (i.run.status === 'skipped') return { verdict: 'needs-review', reason: '평가 단계를 실행하지 못함' };
  if (i.node.status === 'ok') return { verdict: 'pass', reason: `Node 직접 import·번들·평가 모두 성공${i.node.names !== undefined ? ` (export ${i.node.names}개)` : ''}` };
  if (i.node.status === 'bundler-required') return { verdict: 'pass', reason: 'Node 단독 import는 불가(확장자 없는 상대 import) — 번들러 해석에서는 정상' };
  return { verdict: 'pass', reason: `Node 직접 import는 실패(${i.node.detail}) — 번들러 해석·평가는 정상` };
}

/** Node 직접 import 결과 분류: 패키지 내부의 확장자 없는/디렉터리 import는 번들러 전제, 패키지 누락은 실패. */
export function classifyNodeError(code: string | undefined, message: string): 'bundler-required' | 'failed' {
  if (code === 'ERR_UNSUPPORTED_DIR_IMPORT') return 'bundler-required';
  if (code === 'ERR_MODULE_NOT_FOUND' && /Cannot find module '(\/|\.)/.test(message)) return 'bundler-required';
  return 'failed';
}

async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>, signal?: AbortSignal) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { if (signal?.aborted) return; await fn(items[i++]); }
  }));
}

const NODE_PROBE = `
const [file] = process.argv.slice(1);
const specs = JSON.parse(process.env.STAGE_SPECS);
const out = {};
for (const s of specs) {
  try { const m = await import(s); out[s] = { ok: true, names: Object.keys(m).length }; }
  catch (e) { out[s] = { ok: false, code: e && e.code, message: String(e && e.message || e).split('\\n')[0].slice(0, 300) }; }
}
process.stdout.write('\\n@@RESULT@@' + JSON.stringify(out));
`;

export interface VerifyOptions { consumerDir: string; pkgName: string; signal?: AbortSignal; log?: (m: string) => void; concurrency?: number; timeoutMs?: number }

export async function verifyExports(o: VerifyOptions): Promise<ExportsCheck> {
  const t0 = performance.now();
  const log = o.log ?? (() => {});
  const packageDir = path.join(o.consumerDir, 'node_modules', o.pkgName);
  const entries = expandExports(packageDir, o.pkgName);
  log(`exports ${entries.length}개(패턴은 설치된 파일 구조에서 펼침) 검증 시작`);
  const items: ExportCheckItem[] = entries.map((e) => ({
    key: e.key, specifier: e.specifier, pattern: e.pattern,
    node: { status: 'skipped' }, bundle: { status: 'skipped' }, run: { status: 'skipped' }, verdict: 'needs-review', reason: '검증 전',
  }));
  const byKey = new Map(items.map((i, idx) => [i.key, { item: i, entry: entries[idx] }]));

  // 1) Node 직접 import (한 프로세스에서 순서대로)
  const jsonKeys = new Set(entries.filter((e) => e.json).map((e) => e.key));
  const specs = entries.filter((e) => !e.json).map((e) => e.specifier);
  const probe = await runProc(process.execPath, ['--input-type=module', '-e', NODE_PROBE], { cwd: o.consumerDir, env: { ...process.env, STAGE_SPECS: JSON.stringify(specs) }, signal: o.signal, timeoutMs: o.timeoutMs ?? 120_000 });
  const marker = probe.stdout.split('@@RESULT@@')[1];
  const nodeResults: Record<string, { ok: boolean; names?: number; code?: string; message?: string }> = marker ? JSON.parse(marker) : {};
  for (const e of entries) {
    const it = byKey.get(e.key)!.item;
    if (e.json) continue;
    const r = nodeResults[e.specifier];
    if (!r) it.node = { status: 'failed', detail: firstErrorLine(probe.stderr || '검증 프로세스가 결과를 내지 못함') };
    else if (r.ok) it.node = { status: 'ok', names: r.names };
    else it.node = { status: classifyNodeError(r.code, r.message ?? ''), detail: (r.code ? `${r.code}: ` : '') + (r.message ?? '').replace(o.consumerDir, '<consumer>').slice(0, 200) };
  }

  // 2)·3) 번들러 해석 + 번들 평가 (동시 4개)
  const { build } = await import('esbuild');
  const outDir = path.join(o.consumerDir, '.stage-verify');
  fs.mkdirSync(outDir, { recursive: true });
  await pool(entries, o.concurrency ?? 4, async (e) => {
    const it = byKey.get(e.key)!.item;
    if (jsonKeys.has(e.key)) {
      const rel = pickTarget((JSON.parse(fs.readFileSync(path.join(packageDir, 'package.json'), 'utf8')).exports as Record<string, unknown>)[e.key]);
      try { JSON.parse(fs.readFileSync(path.join(packageDir, rel ?? ''), 'utf8')); it.run = { status: 'ok' }; } catch (err: any) { it.run = { status: 'failed', detail: String(err?.message ?? err).slice(0, 200) }; }
      return;
    }
    const t = performance.now();
    const file = path.join(outDir, `${e.key.replace(/[^\w]+/g, '_') || 'root'}.mjs`);
    try {
      await build({
        stdin: { contents: `export * from ${JSON.stringify(e.specifier)};`, resolveDir: o.consumerDir, loader: 'js' },
        absWorkingDir: o.consumerDir, bundle: true, format: 'esm', platform: 'node', write: true, outfile: file, logLevel: 'silent',
        banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
        define: { 'process.env.NODE_ENV': '"development"' },
      });
      it.bundle = { status: 'ok', ms: Math.round(performance.now() - t) };
    } catch (err: any) {
      const first = err?.errors?.[0];
      it.bundle = { status: 'failed', detail: (first ? `${first.text}${first.location?.file ? ` (${first.location.file.replace(/^.*node_modules\//, '')})` : ''}` : String(err?.message ?? err)).slice(0, 240) };
      return;
    }
    const r = await runProc(process.execPath, [file], { cwd: o.consumerDir, signal: o.signal, timeoutMs: 20_000 });
    it.run = r.killed ? { status: 'failed', detail: '평가 시간 초과(20초)' } : r.code === 0 ? { status: 'ok' } : { status: 'failed', detail: firstErrorLine(r.stderr || r.stdout) };
  }, o.signal);

  const counts: Record<ExportVerdict, number> = { pass: 0, 'needs-review': 0, fail: 0 };
  for (const [key, { item }] of byKey) {
    const j = judge({ node: item.node, bundle: item.bundle, run: item.run, json: jsonKeys.has(key) });
    item.verdict = j.verdict;
    item.reason = j.reason;
    counts[j.verdict]++;
  }
  fs.rmSync(outDir, { recursive: true, force: true });
  return { at: new Date().toISOString(), packageName: o.pkgName, total: items.length, counts, items, durationMs: Math.round(performance.now() - t0) };
}
