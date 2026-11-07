// 스크립트 SUT 실행 자식 프로세스. 대상 스크립트를 import()로 실행하면서 node:fs 호출을 실제로 수행하고 순서대로 기록한다.
// (원본 테스트는 node:fs를 가짜 모듈로 바꿔 호출만 기록했다. 여기서는 같은 모듈 훅으로 진짜 fs에 전달하면서 기록한다.)
// 사용법: node script-child.mjs <스크립트 절대 경로> <기록 파일 경로>   (cwd = 프로젝트 샌드박스 복사본)
import { registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';

const [scriptPath, traceOut] = process.argv.slice(2);
const real = process.getBuiltinModule('node:fs');
const ROOT = process.cwd();
const FAKE = 'stage:fs-trace';
const MUTATING = new Set(['rmSync', 'rmdirSync', 'mkdirSync', 'cpSync', 'copyFileSync', 'writeFileSync', 'appendFileSync', 'renameSync', 'unlinkSync', 'symlinkSync', 'linkSync', 'truncateSync', 'chmodSync', 'utimesSync']);
const MAX_MUTATIONS = 2000;

const mutations = [];
const readCounts = {};
let seq = 0;
let truncated = false;

const show = (v) => {
  if (typeof v === 'string') { const s = v.split(ROOT).join('<root>').replace(/\s+/g, ' '); return s.length > 140 ? `${s.slice(0, 137)}…(${v.length}자)` : s; }
  if (Buffer.isBuffer(v)) return `<Buffer ${v.length}B>`;
  if (v && typeof v === 'object') { try { return JSON.stringify(v); } catch { return String(v); } }
  return String(v);
};

globalThis.__stageReal = real;
globalThis.__stageFsCall = (name, args) => {
  const mutating = MUTATING.has(name);
  if (!mutating) { readCounts[name] = (readCounts[name] ?? 0) + 1; return real[name](...args); }
  const ev = { seq: ++seq, op: name, args: args.map(show).join(', '), ms: 0 };
  if (mutations.length < MAX_MUTATIONS) mutations.push(ev); else truncated = true;
  const t0 = performance.now();
  try { return real[name](...args); }
  catch (e) { ev.error = String(e?.message ?? e); throw e; }
  finally { ev.ms = Math.round((performance.now() - t0) * 100) / 100; }
};

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'node:fs' || specifier === 'fs') return { url: FAKE, shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url !== FAKE) return nextLoad(url, context);
    const lines = Object.keys(real)
      .filter((k) => /^[A-Za-z_$][\w$]*$/.test(k) && k !== 'default')
      .map((k) => (typeof real[k] === 'function' ? `export const ${k} = (...a) => globalThis.__stageFsCall(${JSON.stringify(k)}, a);` : `export const ${k} = globalThis.__stageReal.${k};`));
    lines.push('export default new Proxy({}, { get: (_t, k) => (typeof globalThis.__stageReal[k] === "function" ? (...a) => globalThis.__stageFsCall(k, a) : globalThis.__stageReal[k]) });');
    return { format: 'module', source: lines.join('\n'), shortCircuit: true };
  },
});

let error;
try {
  await import(pathToFileURL(scriptPath).href);
} catch (e) {
  error = String(e?.stack ?? e?.message ?? e).split('\n').slice(0, 6).join('\n').split(ROOT).join('<root>');
}
real.writeFileSync(traceOut, JSON.stringify({ mutations, readCounts, truncated, error }));
process.exit(error ? 1 : 0);
