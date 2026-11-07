// 실환경 검증: 브라우저 API(window·sessionStorage 등)에 의존하는 mock 테스트를 3단계에서 "실제 브라우저"로 검증한다.
// 원본 테스트는 협력자(window.sessionStorage)를 mock으로 바꿔 호출 인자만 확인하므로, 실제 저장소에 값이 들어가는지는 증명하지 못한다.
// 그래서 테스트 안의 SUT 호출(함수·입력)을 정적으로 추출해, 같은 호출을 진짜 Chrome(실제 window.sessionStorage)에서
// 프로젝트 dist(기준)와 배포 후보에 각각 실행하고 실제 저장소 상태·호출 순서·반환·예외를 비교한다.
// window가 없는 서버 환경 시나리오는 Node 자식 프로세스에서 window 없이 실행한다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import ts from 'typescript';
import type { ExecStatus } from '../model.ts';
import { runProc } from './candidate.ts';

export interface RealScenario {
  id: string;
  testName: string;
  line: number;
  env: 'browser' | 'server';
  /** fromDir(프로젝트 배포 단위 디렉터리) 기준 모듈 경로 */
  moduleRel: string;
  exportName: string;
  bindings: { name: string; src: string }[];
  args: string[];
}

export interface Extraction {
  /** 테스트 파일이 브라우저 전역(window·sessionStorage 등)을 쓰는지 */
  browserDependent: boolean;
  scenarios: RealScenario[];
  skipped: { testName: string; line: number; reason: string }[];
}

const BROWSER_GLOBALS = /\b(window|document|sessionStorage|localStorage|navigator|location|indexedDB|globalThis\.window)\b/;

export function isBrowserDependent(testFile: string): boolean {
  try { return BROWSER_GLOBALS.test(fs.readFileSync(testFile, 'utf8')); } catch { return false; }
}

/** 리터럴·객체·배열·알려진 식별자로만 이뤄진 식인지(mock 생성 등 부수효과가 없는 값). */
function isPure(n: ts.Node, known: Set<string>): boolean {
  if (ts.isStringLiteral(n) || ts.isNumericLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return true;
  if (n.kind === ts.SyntaxKind.TrueKeyword || n.kind === ts.SyntaxKind.FalseKeyword || n.kind === ts.SyntaxKind.NullKeyword) return true;
  if (ts.isIdentifier(n)) return n.text === 'undefined' || known.has(n.text);
  if (ts.isParenthesizedExpression(n)) return isPure(n.expression, known);
  if (ts.isPrefixUnaryExpression(n)) return isPure(n.operand, known);
  if (ts.isPropertyAccessExpression(n)) return isPure(n.expression, known);
  if (ts.isArrayLiteralExpression(n)) return n.elements.every((e) => isPure(e, known));
  if (ts.isTemplateExpression(n)) return n.templateSpans.every((s) => isPure(s.expression, known));
  if (ts.isObjectLiteralExpression(n)) {
    return n.properties.every((p) => {
      if (ts.isShorthandPropertyAssignment(p)) return known.has(p.name.text);
      if (ts.isPropertyAssignment(p)) return !ts.isComputedPropertyName(p.name) && isPure(p.initializer, known);
      return false;
    });
  }
  return false;
}

export function extractScenarios(testFile: string, fromDir: string): Extraction {
  const text = fs.readFileSync(testFile, 'utf8');
  const sf = ts.createSourceFile(testFile, text, ts.ScriptTarget.Latest, true);
  const dir = path.dirname(testFile);
  const browserDependent = BROWSER_GLOBALS.test(text);
  const moduleOf = (spec: string): string | undefined => {
    if (!spec.startsWith('.')) return undefined;
    const rel = path.relative(fromDir, path.resolve(dir, spec));
    return rel.startsWith('..') || path.isAbsolute(rel) ? undefined : rel;
  };
  const imported = new Map<string, { moduleRel: string; exportName: string }>();
  const topConsts: { name: string; src: string }[] = [];
  const known = new Set<string>();
  for (const st of sf.statements) {
    if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier) && st.importClause?.namedBindings && ts.isNamedImports(st.importClause.namedBindings)) {
      const moduleRel = moduleOf(st.moduleSpecifier.text);
      if (moduleRel) for (const e of st.importClause.namedBindings.elements) imported.set(e.name.text, { moduleRel, exportName: (e.propertyName ?? e.name).text });
    }
    if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        const init = d.initializer && ts.isAwaitExpression(d.initializer) ? d.initializer.expression : d.initializer;
        if (ts.isObjectBindingPattern(d.name) && init && ts.isCallExpression(init) && init.expression.kind === ts.SyntaxKind.ImportKeyword && ts.isStringLiteral(init.arguments[0])) {
          const moduleRel = moduleOf((init.arguments[0] as ts.StringLiteral).text);
          if (moduleRel) for (const e of d.name.elements) if (ts.isIdentifier(e.name)) imported.set(e.name.text, { moduleRel, exportName: ts.isIdentifier(e.propertyName ?? e.name) ? ((e.propertyName ?? e.name) as ts.Identifier).text : e.name.text });
        } else if (ts.isIdentifier(d.name) && d.initializer && st.declarationList.flags & ts.NodeFlags.Const && isPure(d.initializer, known)) {
          topConsts.push({ name: d.name.text, src: d.initializer.getText(sf) });
          known.add(d.name.text);
        }
      }
    }
  }

  const scenarios: RealScenario[] = [];
  const skipped: Extraction['skipped'] = [];
  const lineOf = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;
  let testIdx = 0;
  const visit = (n: ts.Node) => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && (n.expression.text === 'test' || n.expression.text === 'it') && n.arguments.length >= 2 && ts.isStringLiteralLike(n.arguments[0])) {
      const fn = n.arguments[1];
      if ((ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) && ts.isBlock(fn.body)) extractTest(n, (n.arguments[0] as ts.StringLiteralLike).text, fn.body, testIdx++);
      return;
    }
    ts.forEachChild(n, visit);
  };
  const extractTest = (node: ts.Node, testName: string, body: ts.Block, idx: number) => {
    const bindings = [...topConsts];
    const local = new Set(known);
    let env: 'browser' | 'server' = 'browser';
    let callIdx = 0;
    let found = 0;
    for (const st of body.statements) {
      if (ts.isExpressionStatement(st)) {
        const e = st.expression;
        if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.EqualsToken && /^(globalThis|global)\.window$/.test(e.left.getText(sf))) {
          env = e.right.getText(sf) === 'undefined' ? 'server' : 'browser';
          continue;
        }
        if (ts.isDeleteExpression(e) && /^(globalThis|global)\.window$/.test(e.expression.getText(sf))) { env = 'server'; continue; }
      }
      // SUT 호출 수집(어서션 안의 화살표 함수 등 중첩 포함)
      const calls: ts.CallExpression[] = [];
      const walk = (x: ts.Node) => { if (ts.isCallExpression(x) && ts.isIdentifier(x.expression) && imported.has(x.expression.text)) calls.push(x); ts.forEachChild(x, walk); };
      walk(st);
      for (const c of calls) {
        found++;
        const target = imported.get((c.expression as ts.Identifier).text)!;
        const bad = c.arguments.find((a) => !isPure(a, local));
        if (bad) { skipped.push({ testName, line: lineOf(c), reason: `호출 인자 \`${bad.getText(sf)}\`가 리터럴로 정해지지 않아 실환경에서 재현할 수 없음` }); continue; }
        scenarios.push({ id: `${idx}-${callIdx++}`, testName, line: lineOf(c), env, moduleRel: target.moduleRel, exportName: target.exportName, bindings: bindings.map((b) => ({ ...b })), args: c.arguments.map((a) => a.getText(sf)) });
      }
      // 이후 호출에서 쓸 수 있는 순수 지역 상수
      if (ts.isVariableStatement(st)) {
        for (const d of st.declarationList.declarations) {
          if (ts.isIdentifier(d.name) && d.initializer && isPure(d.initializer, local)) { bindings.push({ name: d.name.text, src: d.initializer.getText(sf) }); local.add(d.name.text); }
        }
      }
    }
    if (!found) skipped.push({ testName, line: lineOf(node), reason: '프로젝트 배포 파일의 함수를 호출하지 않음' });
  };
  visit(sf);
  return { browserDependent, scenarios, skipped };
}

export interface Observed {
  threw?: { name: string; message: string };
  returned: unknown;
  /** 호출 후 실제 저장소 상태(브라우저) 또는 window 정의 여부(서버) */
  storage: unknown;
  /** 실제 Storage.setItem/removeItem/clear 호출 순서 */
  calls: unknown[][];
}

/** 한 시나리오를 한 실행 환경(브라우저 또는 Node)에서 기준 dist·배포 후보로 실행한 결과 */
export interface ScenarioRun {
  browser: string;
  base?: Observed;
  cand?: Observed;
  verdict: 'pass' | 'fail' | 'error';
  reason: string;
}

export interface RealScenarioResult {
  id: string;
  testName: string;
  line: number;
  env: 'browser' | 'server';
  moduleRel: string;
  exportName: string;
  args: string[];
  runs: ScenarioRun[];
  /** 모든 환경에서 통과하고 브라우저 간 결과도 같을 때만 pass */
  verdict: 'pass' | 'fail' | 'error';
  reason: string;
}

export interface BrowserRun {
  name: string;
  kind: BrowserKind;
  executable?: string;
  userAgent?: string;
  ok: boolean;
  reason: string;
}

export interface RealEnvResult {
  status: ExecStatus;
  reason: string;
  /** 검증에 쓴 브라우저 목록(크로스브라우징 커버리지) */
  browsers: BrowserRun[];
  scenarios: RealScenarioResult[];
  skipped: Extraction['skipped'];
}

/** 브라우저·Node 양쪽에서 같은 코드로 시나리오를 실행하는 러너(문자열로 번들 뒤에 붙는다). 오래된 엔진을 위해 ES2018 이하로 변환해 쓴다. */
const RUNNER = `
async function __stageRunAll(isBrowser, scenarios, side) {
  let LOG = null;
  if (isBrowser) {
    ['setItem', 'removeItem', 'clear'].forEach(function (m) {
      var orig = Storage.prototype[m];
      Storage.prototype[m] = function () { var a = Array.prototype.slice.call(arguments); if (LOG) LOG.push([this === window.sessionStorage ? 'sessionStorage' : 'localStorage', m].concat(a)); return orig.apply(this, a); };
    });
  }
  const snap = (s) => { const o = {}; Object.keys(s).sort().forEach((k) => { o[k] = s.getItem(k); }); return o; };
  const out = {};
  for (const sc of scenarios) {
    const obs = { returned: null, storage: null, calls: [] };
    try {
      if (isBrowser) { window.sessionStorage.clear(); window.localStorage.clear(); } else { delete globalThis.window; }
      const body = sc.bindings.map((b) => 'const ' + b.name + ' = ' + b.src + ';').join('\\n') + '\\nreturn [' + sc.args.join(',') + '];';
      const args = new Function(body)();
      const fn = side[sc.mod] && side[sc.mod][sc.exportName];
      if (typeof fn !== 'function') throw new Error('내보내기 ' + sc.exportName + '가 함수가 아님');
      LOG = [];
      try { const r = await fn.apply(null, args); obs.returned = r === undefined ? null : JSON.parse(JSON.stringify(r)); }
      catch (e) { obs.threw = { name: String(e && e.name), message: String(e && e.message) }; }
      obs.calls = LOG; LOG = null;
      obs.storage = isBrowser ? { sessionStorage: snap(window.sessionStorage), localStorage: snap(window.localStorage) } : { windowDefined: typeof globalThis.window !== 'undefined' };
    } catch (e) { obs.setupError = String(e && e.message); }
    out[sc.id] = obs;
  }
  return out;
}`;

export type BrowserKind = 'chromium' | 'firefox' | 'safari' | 'manual';
export interface BrowserSpec { name: string; kind: BrowserKind; executable: string }

const exists = (p: string) => { try { return fs.existsSync(p); } catch { return false; } };

function kindOf(executable: string): BrowserKind {
  const n = executable.toLowerCase();
  if (n === 'manual') return 'manual';
  if (n.includes('firefox')) return 'firefox';
  if (n.includes('safari')) return 'safari';
  return 'chromium';
}

/**
 * 검증에 쓸 브라우저를 정한다.
 *  - STAGE_BROWSERS(쉼표 구분 실행 파일 경로, 또는 safari·manual) 또는 STAGE_BROWSER가 있으면 그것만 쓴다.
 *  - 없으면 설치된 Chrome·Edge(Chromium 기반)·Firefox를 자동 탐지한다. Safari는 창이 뜨므로 STAGE_BROWSERS=safari로 명시할 때만 쓴다.
 *  - manual: 브라우저를 직접 띄우지 않고 검증 주소를 로그에 남긴다. 사용자가 원하는 브라우저로 그 주소를 열면 같은 방식으로 결과를 받는다.
 */
export function findBrowsers(env: NodeJS.ProcessEnv = process.env): BrowserSpec[] {
  const explicit = (env.STAGE_BROWSERS ?? env.STAGE_BROWSER ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (explicit.length) {
    const out: BrowserSpec[] = [];
    for (const e of explicit) {
      if (e === 'manual') out.push({ name: '수동 연결 브라우저', kind: 'manual', executable: 'manual' });
      else if (e === 'safari') { if (exists('/Applications/Safari.app')) out.push({ name: 'Safari', kind: 'safari', executable: '/Applications/Safari.app' }); }
      else if (exists(e)) out.push({ name: path.basename(e).replace(/\.exe$/i, ''), kind: kindOf(e), executable: e });
    }
    return out;
  }
  const home = os.homedir();
  const local = process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local');
  const pf = [process.env['ProgramFiles'] ?? 'C:\\Program Files', process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'];
  const table: { name: string; kind: BrowserKind; paths: string[] }[] = [
    { name: 'Chrome', kind: 'chromium', paths: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', ...pf.map((p) => path.join(p, 'Google', 'Chrome', 'Application', 'chrome.exe')), path.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe')] },
    { name: 'Edge', kind: 'chromium', paths: ['/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable', ...pf.map((p) => path.join(p, 'Microsoft', 'Edge', 'Application', 'msedge.exe'))] },
    { name: 'Chromium', kind: 'chromium', paths: ['/Applications/Chromium.app/Contents/MacOS/Chromium', '/usr/bin/chromium', '/usr/bin/chromium-browser'] },
    { name: 'Firefox', kind: 'firefox', paths: ['/Applications/Firefox.app/Contents/MacOS/firefox', '/usr/bin/firefox', ...pf.map((p) => path.join(p, 'Mozilla Firefox', 'firefox.exe'))] },
  ];
  const out: BrowserSpec[] = [];
  for (const t of table) { const p = t.paths.find(exists); if (p) out.push({ name: t.name, kind: t.kind, executable: p }); }
  return out;
}

/** User-Agent에서 브라우저 이름·버전을 읽는다. */
export function describeUserAgent(ua: string | undefined, fallback: string): string {
  if (!ua) return fallback;
  // Edge는 UA에 Chrome/도 함께 있고 Chrome은 Safari/도 있으므로 구체적인 토큰부터 찾는다.
  for (const [token, name] of [['Edg', 'Edge'], ['Firefox', 'Firefox'], ['Chrome', 'Chrome'], ['Version', 'Safari']] as const) {
    const m = ua.match(new RegExp(`${token}/([\\d.]+)`));
    if (m) return `${name} ${m[1].split('.')[0]}`;
  }
  return fallback;
}

async function bundle(entry: string, outFile: string, platform: 'browser' | 'node', globalName: string, nodePaths: string[]) {
  const { build } = await import('esbuild');
  await build({
    entryPoints: [entry], outfile: outFile, bundle: true, logLevel: 'silent', nodePaths,
    ...(platform === 'browser' ? { platform: 'browser', format: 'iife', globalName, target: 'es2018', define: { 'process.env.NODE_ENV': '"production"' } } : { platform: 'node', format: 'cjs' }),
  });
}

type BrowserOutcome = { result: { base: Record<string, Observed>; cand: Record<string, Observed>; userAgent: string } } | { error: string };

async function runInBrowser(spec: BrowserSpec, dir: string, files: string[], scenarios: unknown[], signal: AbortSignal, timeoutMs: number, log: (m: string) => void): Promise<BrowserOutcome> {
  const { transform } = await import('esbuild');
  const pageScript = (await transform(`${RUNNER}
(async () => {
  try {
    const scenarios = ${JSON.stringify(scenarios)};
    const pick = (prefix) => { const o = {}; Object.keys(window).forEach((k) => { if (k.indexOf(prefix) === 0) o[k.slice(prefix.length)] = window[k]; }); return o; };
    const base = await __stageRunAll(true, scenarios, pick('__stageB_'));
    const cand = await __stageRunAll(true, scenarios, pick('__stageC_'));
    await fetch('/result', { method: 'POST', body: JSON.stringify({ base, cand, userAgent: navigator.userAgent }) });
  } catch (e) { await fetch('/result', { method: 'POST', body: JSON.stringify({ error: String(e && e.stack || e) }) }); }
})();`, { target: 'es2018' })).code;
  const html = `<!doctype html><meta charset="utf-8"><title>stage real-env</title><body><pre id="o">실행 중…</pre>
${files.map((f) => `<script src="/${f}"></script>`).join('\n')}
<script>${pageScript}</script>`;
  // Chromium은 새 headless(--headless=new, 109+)를 먼저 쓰고, 결과 없이 종료하면 구 headless(--headless)로 한 번 더 시도한다.
  const attempts: string[][] = spec.kind === 'chromium' ? [['--headless=new'], ['--headless']] : [[]];
  let last: BrowserOutcome = { error: '실행하지 않음' };
  for (const flags of attempts) {
    last = await new Promise<BrowserOutcome>((resolve) => {
      let done = false;
      let child: ReturnType<typeof spawn> | undefined;
      const finish = (v: BrowserOutcome) => { if (done) return; done = true; clearTimeout(timer); child?.kill('SIGKILL'); server.close(); resolve(v); };
      const server = http.createServer(async (req, res) => {
        if (req.url === '/result' && req.method === 'POST') {
          let body = '';
          for await (const c of req) body += c;
          res.end('ok');
          try { const j = JSON.parse(body); finish(j.error ? { error: j.error } : { result: j }); } catch (e) { finish({ error: `결과 해석 실패: ${(e as Error).message}` }); }
          return;
        }
        const name = (req.url ?? '/').slice(1);
        if (name && files.includes(name)) { res.setHeader('content-type', 'text/javascript; charset=utf-8'); res.end(fs.readFileSync(path.join(dir, name))); return; }
        res.setHeader('content-type', 'text/html; charset=utf-8');
        res.end(html);
      });
      const timer = setTimeout(() => finish({ error: `시간 초과(${timeoutMs}ms)${spec.kind === 'manual' ? ' — 검증 주소를 브라우저로 열지 않았거나 결과가 도착하지 않음' : ''}` }), timeoutMs);
      signal.addEventListener('abort', () => finish({ error: '취소됨' }), { once: true });
      server.listen(0, '127.0.0.1', () => {
        const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
        const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-browser-'));
        if (spec.kind === 'manual') { log(`수동 연결: 원하는 브라우저로 ${url} 을 여세요 (${Math.round(timeoutMs / 1000)}초 내)`); return; }
        if (spec.kind === 'safari') { child = spawn('open', ['-a', 'Safari', url], { stdio: 'ignore' }); return; }
        const args = spec.kind === 'firefox'
          ? ['-headless', '-no-remote', '-profile', profile, url]
          : [...flags, '--disable-gpu', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${profile}`, url];
        child = spawn(spec.executable, args, { stdio: 'ignore' });
        child.on('error', (e) => finish({ error: `실행 실패: ${e.message}` }));
        child.on('exit', () => setTimeout(() => finish({ error: `결과를 보내기 전에 종료됨${flags[0] ? `(${flags[0]})` : ''}` }), 500));
      });
    });
    if ('result' in last) return last;
    if (!/종료됨/.test(last.error)) return last;
  }
  return last;
}

export async function runRealEnv(opts: { testFile: string; fromDir: string; packageDir: string; projectRoot: string; outDir: string; signal: AbortSignal; timeoutMs: number; env?: NodeJS.ProcessEnv; log?: (m: string) => void }): Promise<RealEnvResult> {
  const env = opts.env ?? process.env;
  const log = opts.log ?? (() => undefined);
  const fail = (reason: string, browsers: BrowserRun[] = [], skipped: Extraction['skipped'] = []): RealEnvResult => ({ status: 'failed', reason, browsers, scenarios: [], skipped });
  const ex = extractScenarios(opts.testFile, opts.fromDir);
  if (!ex.scenarios.length) {
    return fail(`실환경에서 재현할 SUT 호출을 테스트에서 찾지 못함${ex.skipped[0] ? ` — ${ex.skipped[0].reason}` : ''}. 실제 검증이 성립하지 않아 통과로 처리하지 않음`, [], ex.skipped);
  }
  const work = fs.mkdtempSync(path.join(opts.outDir, 'real-env-'));
  const mods = [...new Set(ex.scenarios.map((s) => s.moduleRel))];
  const nodePaths = [path.join(opts.projectRoot, 'node_modules')];
  const prepared = ex.scenarios.map((s) => ({ id: s.id, mod: mods.indexOf(s.moduleRel), exportName: s.exportName, bindings: s.bindings, args: s.args, env: s.env }));
  const browserScenarios = prepared.filter((s) => s.env === 'browser');
  const serverScenarios = prepared.filter((s) => s.env === 'server');

  // 번들: 기준(프로젝트 dist)과 배포 후보 각각, 브라우저용(iife, ES2018)과 서버용(cjs)
  const browserFiles: string[] = [];
  const nodeBundles: { base: string[]; cand: string[] } = { base: [], cand: [] };
  try {
    for (let i = 0; i < mods.length; i++) {
      const sides: ['B' | 'C', string][] = [['B', path.join(opts.fromDir, mods[i])], ['C', path.join(opts.packageDir, mods[i])]];
      for (const [tag, entry] of sides) {
        if (!fs.existsSync(entry)) throw new Error(`${tag === 'C' ? '배포 후보' : '프로젝트 dist'}에 파일이 없음: ${mods[i]}`);
        const gname = `__stage${tag}_${i}`;
        if (browserScenarios.some((s) => s.mod === i)) { const f = `${tag}${i}.js`; await bundle(entry, path.join(work, f), 'browser', gname, nodePaths); browserFiles.push(f); }
        if (serverScenarios.some((s) => s.mod === i)) { const f = path.join(work, `${tag}${i}.cjs`); await bundle(entry, f, 'node', gname, nodePaths); (tag === 'B' ? nodeBundles.base : nodeBundles.cand)[i] = f; }
      }
    }
  } catch (e) {
    return fail(`실환경 검증 준비 실패: ${(e as Error).message}`, [], ex.skipped);
  }

  const browsers: BrowserRun[] = [];
  /** 환경 이름 → 시나리오 id → 관찰 결과 */
  const observed: { name: string; base: Record<string, Observed>; cand: Record<string, Observed> }[] = [];

  if (browserScenarios.length) {
    const specs = findBrowsers(env);
    if (!specs.length) return fail('실제 브라우저(Chrome·Edge·Firefox 등)를 찾지 못함 — STAGE_BROWSERS에 실행 파일 경로(쉼표 구분) 또는 manual을 지정하세요. mock으로 대체하지 않으므로 통과로 처리하지 않음', [], ex.skipped);
    for (const spec of specs) {
      log(`브라우저 실행: ${spec.name} (${spec.executable})`);
      const r = await runInBrowser(spec, work, browserFiles, browserScenarios, opts.signal, Math.min(opts.timeoutMs, spec.kind === 'manual' || spec.kind === 'safari' ? 120_000 : 60_000), log);
      if ('error' in r) { browsers.push({ name: spec.name, kind: spec.kind, executable: spec.executable, ok: false, reason: r.error }); log(`  ${spec.name}: 실패 — ${r.error}`); continue; }
      const name = describeUserAgent(r.result.userAgent, spec.name);
      browsers.push({ name, kind: spec.kind, executable: spec.executable, userAgent: r.result.userAgent, ok: true, reason: '실행 완료' });
      observed.push({ name, base: r.result.base, cand: r.result.cand });
      log(`  ${name}: 실행 완료`);
    }
  }

  if (serverScenarios.length) {
    const script = path.join(work, 'server-run.cjs');
    const out = path.join(work, 'server-out.json');
    fs.writeFileSync(script, `${RUNNER}
const fs = require('node:fs');
const load = (files) => { const o = {}; files.forEach((f, i) => { if (f) o[i] = require(f); }); return o; };
(async () => {
  const scenarios = ${JSON.stringify(serverScenarios)};
  const b = await __stageRunAll(false, scenarios, load(${JSON.stringify(nodeBundles.base)}));
  const c = await __stageRunAll(false, scenarios, load(${JSON.stringify(nodeBundles.cand)}));
  fs.writeFileSync(${JSON.stringify(out)}, JSON.stringify({ b, c }));
})().catch((e) => { console.error(e); process.exit(1); });
`);
    const r = await runProc(process.execPath, [script], { cwd: work, signal: opts.signal, timeoutMs: 60_000 });
    if (r.code !== 0) return fail(`서버 환경 실행 실패: ${(r.stderr || r.stdout).trim().split('\n').slice(-3).join(' ')}`, browsers, ex.skipped);
    const j = JSON.parse(fs.readFileSync(out, 'utf8'));
    observed.push({ name: `Node ${process.version} (window 없음)`, base: j.b, cand: j.c });
  }

  const scenarios: RealScenarioResult[] = ex.scenarios.map((s) => {
    const envs = observed.filter((o) => (s.env === 'server') === o.name.startsWith('Node '));
    const runs: ScenarioRun[] = envs.map((o) => {
      const b = o.base[s.id] as (Observed & { setupError?: string }) | undefined;
      const c = o.cand[s.id] as (Observed & { setupError?: string }) | undefined;
      if (!b || !c) return { browser: o.name, verdict: 'error', reason: '실행 결과 없음' };
      if (b.setupError || c.setupError) return { browser: o.name, base: b, cand: c, verdict: 'error', reason: `시나리오 재현 실패: ${b.setupError ?? c.setupError}` };
      const same = JSON.stringify([b.threw, b.returned, b.storage, b.calls]) === JSON.stringify([c.threw, c.returned, c.storage, c.calls]);
      return { browser: o.name, base: b, cand: c, verdict: same ? 'pass' : 'fail', reason: same ? '프로젝트 dist와 같은 결과(저장소 상태·호출 순서·반환·예외)' : '배포 후보와 프로젝트 dist의 실제 환경 결과가 다름' };
    });
    const common = { id: s.id, testName: s.testName, line: s.line, env: s.env, moduleRel: s.moduleRel, exportName: s.exportName, args: s.args, runs };
    if (!runs.length) return { ...common, verdict: 'error' as const, reason: '실행한 환경이 없음' };
    const bad = runs.find((r) => r.verdict !== 'pass');
    if (bad) return { ...common, verdict: bad.verdict, reason: `${bad.browser}: ${bad.reason}` };
    // 크로스브라우징: 같은 배포 후보가 브라우저마다 다른 결과를 내면 프레임워크 결함이다.
    const sig = (r: ScenarioRun) => JSON.stringify([r.cand?.threw, r.cand?.returned, r.cand?.storage, r.cand?.calls]);
    const diff = runs.find((r) => sig(r) !== sig(runs[0]));
    if (diff) return { ...common, verdict: 'fail' as const, reason: `브라우저 간 결과 다름: ${runs[0].browser} ↔ ${diff.browser}` };
    return { ...common, verdict: 'pass' as const, reason: runs.length > 1 ? `${runs.map((r) => r.browser).join(', ')} 모두 기준과 같고 서로 일치` : `${runs[0].browser}에서 기준과 같은 결과` };
  });

  const badScenarios = scenarios.filter((s) => s.verdict !== 'pass');
  const badBrowsers = browsers.filter((b) => !b.ok);
  const okBrowsers = browsers.filter((b) => b.ok);
  const minBrowsers = Number(env.STAGE_MIN_BROWSERS ?? 1);
  const reasons: string[] = [];
  if (badBrowsers.length) reasons.push(`브라우저 ${badBrowsers.map((b) => `${b.name}(${b.reason})`).join(', ')} 실행 실패`);
  if (badScenarios.length) reasons.push(`시나리오 ${badScenarios.length}/${scenarios.length}개 미통과: ${badScenarios.slice(0, 3).map((s) => `${s.testName} — ${s.reason}`).join('; ')}`);
  if (browserScenarios.length && okBrowsers.length < minBrowsers) reasons.push(`검증된 브라우저 ${okBrowsers.length}개 < 필요 ${minBrowsers}개(STAGE_MIN_BROWSERS)`);
  const status: ExecStatus = reasons.length === 0 && (okBrowsers.length > 0 || !ex.browserDependent) ? 'passed' : 'failed';
  const cover = okBrowsers.length ? okBrowsers.map((b) => b.name).join(', ') : 'Node';
  const reason = reasons.length ? `실환경 검증 미통과: ${reasons.join(' / ')}`
    : `${cover}에서 ${scenarios.length}개 시나리오 일치${okBrowsers.length === 1 ? ' · 단일 브라우저만 검증됨(크로스브라우징 미확인)' : ''}`;
  return { status, reason, browsers, scenarios, skipped: ex.skipped };
}
