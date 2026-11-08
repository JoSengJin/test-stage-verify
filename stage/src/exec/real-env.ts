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
import { createHookRenderer } from './render-hook.js';
import { testApi } from './test-api.ts';

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
  /** 같은 테스트에서 먼저 만든 SUT 인스턴스(`const logger = createLogger(...)`, `new Client(...)`) */
  setup?: SetupStep[];
}

export interface SetupStep { name: string; kind: 'call' | 'new'; moduleRel: string; exportName: string; args: string[] }

export interface Extraction {
  /** 테스트가 import한 배포 단위 모듈(직접 호출 화면에서 불러온다) */
  modules: string[];
  /** 테스트가 import한 이름과 그 모듈 */
  symbols: { name: string; moduleRel: string }[];
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

/** 이 이름들의 전역·API를 mock으로 대체한 테스트는 실제 환경에서 그대로 실행해도 안전하다(저장소·console·시간·난수). 그 밖의 mock은 외부 협력자라 자동 실행하지 않는다. */
const SAFE_MOCK_ROOTS = new Set(['console', 'Date', 'Math', 'crypto', 'globalThis', 'window']);

export function usesMock(testFile: string): boolean {
  try {
    const source = ts.createSourceFile(testFile, fs.readFileSync(testFile, 'utf8'), ts.ScriptTarget.Latest, true);
    const api = testApi(source);
    let found = false;
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ['mock.fn', 'mock.method'].includes(api.canonical(node.expression))) found = true;
      if (!found) ts.forEachChild(node, visit);
    };
    visit(source);
    return found;
  } catch { return false; }
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
  /** `a.b.c`·`a` 꼴 식의 맨 앞 식별자 */
  const rootOf = (n: ts.Node): string | undefined => {
    let x: ts.Node = n;
    while (true) {
      if (ts.isIdentifier(x)) return x.text;
      if (ts.isPropertyAccessExpression(x) || ts.isElementAccessExpression(x)) x = x.expression;
      else if (ts.isCallExpression(x) || ts.isNonNullExpression(x) || ts.isParenthesizedExpression(x) || ts.isAwaitExpression(x)) x = x.expression;
      else return undefined;
    }
  };
  const hasSafeParse = (n: ts.Node): boolean => ts.isObjectLiteralExpression(n) && n.properties.some((p) => (ts.isPropertyAssignment(p) || ts.isMethodDeclaration(p) || ts.isShorthandPropertyAssignment(p)) && p.name.getText(sf) === 'safeParse');
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
    const instances = new Map<string, SetupStep>();
    const schemaLocals = new Set<string>();
    let env: 'browser' | 'server' = browserDependent ? 'browser' : 'server';
    let callIdx = 0;
    let found = 0;
    // mock.method(<대상>, ...)의 대상 뿌리 — SUT 인스턴스·import한 객체를 mock으로 바꾼 테스트는 실제로 실행하면 외부(네트워크 등)로 나갈 수 있다.
    const mockedRoots = new Set<string>();
    const scan = (x: ts.Node) => { if (ts.isCallExpression(x) && /^mock\.method$/.test(x.expression.getText(sf)) && x.arguments[0]) { const r = rootOf(x.arguments[0]); if (r) mockedRoots.add(r); } ts.forEachChild(x, scan); };
    scan(body);
    // 메서드 호출의 뿌리로 쓰이는 변수만 인스턴스로 본다(`const r = f()`는 결과값이지 인스턴스가 아님).
    const methodRoots = new Set<string>();
    const scanRoots = (x: ts.Node) => { if (ts.isCallExpression(x) && ts.isPropertyAccessExpression(x.expression)) { const r = rootOf(x.expression); if (r) methodRoots.add(r); } ts.forEachChild(x, scanRoots); };
    scanRoots(body);
    for (const st of body.statements) {
      if (ts.isExpressionStatement(st)) {
        const e = st.expression;
        if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.EqualsToken && /^(globalThis|global)\.window$/.test(e.left.getText(sf))) {
          env = e.right.getText(sf) === 'undefined' ? 'server' : 'browser';
          continue;
        }
        if (ts.isDeleteExpression(e) && /^(globalThis|global)\.window$/.test(e.expression.getText(sf))) { env = 'server'; continue; }
      }
      // 가짜 스키마({ safeParse: mock.fn(...) })를 담은 지역 상수 — 실제 스키마로 바꿔 실행한다.
      if (ts.isVariableStatement(st)) {
        for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name) && d.initializer && hasSafeParse(d.initializer)) schemaLocals.add(d.name.text);
      }
      // SUT 인스턴스 선언: const x = factory(...) / new Class(...)
      if (ts.isVariableStatement(st) && st.declarationList.declarations.length === 1) {
        const d = st.declarationList.declarations[0];
        const init = d.initializer && ts.isAwaitExpression(d.initializer) ? d.initializer.expression : d.initializer;
        if (ts.isIdentifier(d.name) && methodRoots.has(d.name.text) && init && (ts.isCallExpression(init) || ts.isNewExpression(init)) && ts.isIdentifier(init.expression) && imported.has(init.expression.text) && (init.arguments ?? []).every((a) => isPure(a, local))) {
          const t = imported.get(init.expression.text)!;
          instances.set(d.name.text, { name: d.name.text, kind: ts.isNewExpression(init) ? 'new' : 'call', moduleRel: t.moduleRel, exportName: t.exportName, args: (init.arguments ?? []).map((a) => a.getText(sf)) });
          continue;
        }
      }
      // SUT 호출 수집(어서션 안의 화살표 함수 등 중첩 포함): import한 함수, import한 객체·생성한 인스턴스의 메서드
      const calls: ts.CallExpression[] = [];
      const walk = (x: ts.Node) => {
        if (ts.isCallExpression(x)) {
          const r = rootOf(x.expression);
          if (r && (ts.isIdentifier(x.expression) ? imported.has(r) : (ts.isPropertyAccessExpression(x.expression) && (imported.has(r) || instances.has(r))))) calls.push(x);
        }
        ts.forEachChild(x, walk);
      };
      walk(st);
      for (const c of calls) {
        found++;
        const root = rootOf(c.expression)!;
        const target = imported.get(root) ?? instances.get(root)!;
        const rest = ts.isIdentifier(c.expression) ? '' : c.expression.getText(sf).slice(root.length).replace(/\s+/g, '');
        const calleePath = `${imported.has(root) ? imported.get(root)!.exportName : root}${rest}`;
        if (mockedRoots.has(root) && !SAFE_MOCK_ROOTS.has(root)) { skipped.push({ testName, line: lineOf(c), reason: `\`${root}\`의 일부를 mock으로 대체하는 테스트 — 실제로 자동 실행하면 외부로 나갈 수 있어 사용자가 직접 호출해 확인` }); continue; }
        const args = c.arguments.map((a) => (ts.isIdentifier(a) && schemaLocals.has(a.text)) || hasSafeParse(a) ? '__REAL_SCHEMA__' : a);
        const bad = args.find((a) => typeof a !== 'string' && !isPure(a, local));
        if (bad && typeof bad !== 'string') { skipped.push({ testName, line: lineOf(c), reason: `호출 인자 \`${bad.getText(sf)}\`가 리터럴로 정해지지 않아 자동 재현할 수 없음 — 사용자가 직접 호출해 확인` }); continue; }
        const rootInstance = instances.get(root);
        const setup = [...instances.values()];
        scenarios.push({ id: `${idx}-${callIdx++}`, testName, line: lineOf(c), env, moduleRel: rootInstance ? rootInstance.moduleRel : target.moduleRel, exportName: calleePath, bindings: bindings.map((b) => ({ ...b })), args: args.map((a) => (typeof a === 'string' ? a : a.getText(sf))), ...(setup.length ? { setup } : {}) });
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
  const symbols = [...imported].map(([name, v]) => ({ name: v.exportName === name ? name : `${v.exportName} as ${name}`, moduleRel: v.moduleRel }));
  return { modules: [...new Set([...imported.values()].map((v) => v.moduleRel))], symbols, browserDependent, scenarios, skipped };
}

export interface Observed {
  threw?: { name: string; message: string };
  /** 가짜 스키마를 실제 스키마들로 바꿔 실행한 결과(스키마 이름 → 결과) */
  variants?: Record<string, { returned?: unknown; threw?: { name: string; message: string }; calls: unknown[][] }>;
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
  /** 사용자가 3단계 화면에서 배포 후보 함수를 직접 실행해 볼 때 쓰는 번들 위치와 시나리오 정의 */
  live?: { dir: string; scenarios: Record<string, LiveScenario>; console?: LiveConsole };
  /** 자동으로 재현하지 못해 사용자가 실제 함수를 직접 호출해 확인해야 하는 항목이 있음 */
  manual?: boolean;
}

export interface LiveScenario { mod: number; mods: number[]; exportName: string; bindings: { name: string; src: string }[]; args: string[]; setup: { name: string; kind: 'call' | 'new'; mod: number; exportName: string; args: string[] }[] }

/** 아무 export나 직접 호출해 보는 화면에 필요한 정보(배포 후보 모듈 목록) */
export interface LiveConsole { packageDir: string; projectRoot: string; modules: string[]; symbols: { name: string; moduleRel: string }[] }

/** 실행마다 달라지는 값(시각·UUID·난수 문자열)을 가려 기준과 배포 후보의 결과를 같은 잣대로 비교한다. */
export function maskVolatile(json: string): string {
  return json
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, '<ts>')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>')
    .replace(/corr-[a-z0-9]+-[a-z0-9]+/g, 'corr-<t>-<r>')
    .replace(/\b\d{12,}\b/g, '<epoch>');
}
const sigOf = (o: Observed) => maskVolatile(JSON.stringify([o.threw, o.returned, o.storage, o.calls, o.variants]));

/** 브라우저·Node 양쪽에서 같은 코드로 시나리오를 실행하는 러너(문자열로 번들 뒤에 붙는다). 오래된 엔진을 위해 ES2018 이하로 변환해 쓴다. */
export const RUNNER = `
async function __stageRunAll(isBrowser, scenarios, side) {
  let LOG = null;
  const safe = function (x) { try { return JSON.parse(JSON.stringify(x === undefined ? null : x)); } catch (e) { return String(x); } };
  if (isBrowser) {
    ['setItem', 'removeItem', 'clear'].forEach(function (m) {
      var orig = Storage.prototype[m];
      Storage.prototype[m] = function () { var a = Array.prototype.slice.call(arguments); if (LOG) LOG.push([this === window.sessionStorage ? 'sessionStorage' : 'localStorage', m].concat(a)); return orig.apply(this, a); };
    });
  }
  ['log', 'info', 'warn', 'error', 'debug'].forEach(function (m) {
    var orig = console[m];
    console[m] = function () { var a = Array.prototype.slice.call(arguments); if (LOG) LOG.push(['console', m].concat(a.map(safe))); return orig.apply(this, a); };
  });
  const snap = (s) => { const o = {}; Object.keys(s).sort().forEach((k) => { o[k] = s.getItem(k); }); return o; };
  const evalArgs = (bindings, args, schema) => new Function('__REAL_SCHEMA__', bindings.map((b) => 'const ' + b.name + ' = ' + b.src + ';').join('\\n') + '\\nreturn [' + args.join(',') + '];')(schema);
  const walkPath = (inst, mod, path) => {
    const parts = path.split('.');
    let owner = null;
    let cur = inst[parts[0]] !== undefined ? inst[parts[0]] : mod && mod[parts[0]];
    for (let i = 1; i < parts.length; i++) { owner = cur; cur = cur == null ? undefined : cur[parts[i]]; }
    return { fn: cur, owner: owner };
  };
  // 가짜 스키마 자리에 쓸 실제 스키마: 배포 모듈이 내보낸 값 중 safeParse를 가진 것
  const realSchemas = () => {
    const out = [];
    Object.keys(side).forEach(function (k) { const m = side[k]; Object.keys(m || {}).forEach(function (n) { const v = m[n]; if (v && typeof v.safeParse === 'function' && out.length < 8) out.push({ name: n, value: v }); }); });
    return out;
  };
  const out = {};
  for (const sc of scenarios) {
    const obs = { returned: null, storage: null, calls: [] };
    try {
      if (isBrowser) { window.sessionStorage.clear(); window.localStorage.clear(); if (sc.seed) Object.keys(sc.seed).forEach(function (k) { window.sessionStorage.setItem(k, String(sc.seed[k])); }); } else { delete globalThis.window; }
      const needSchema = sc.args.indexOf('__REAL_SCHEMA__') >= 0;
      const schemas = needSchema ? realSchemas() : [{ name: '', value: undefined }];
      if (!schemas.length) throw new Error('배포 모듈이 내보낸 실제 스키마(safeParse를 가진 값)를 찾지 못함');
      const variants = {};
      let lastCalls = [];
      for (const sch of schemas) {
        const inst = {};
        for (const st of (sc.setup || [])) {
          const mod = side[st.mod];
          const C = mod && mod[st.exportName];
          if (typeof C !== 'function') throw new Error('내보내기 ' + st.exportName + '가 함수가 아님');
          const a = evalArgs(sc.bindings, st.args, sch.value);
          inst[st.name] = st.kind === 'new' ? new C(...a) : await C(...a);
        }
        const target = walkPath(inst, side[sc.mod], sc.exportName);
        if (typeof target.fn !== 'function') throw new Error('내보내기 ' + sc.exportName + '가 함수가 아님');
        const args = evalArgs(sc.bindings, sc.args, sch.value);
        LOG = [];
        const v = {};
        try { const r = await target.fn.apply(target.owner, args); v.returned = r === undefined ? null : safe(r); }
        catch (e) { v.threw = { name: String(e && e.name), message: String(e && e.message) }; }
        lastCalls = LOG; LOG = null;
        v.calls = lastCalls;
        variants[sch.name] = v;
      }
      if (needSchema) { obs.variants = variants; obs.calls = []; } else { const v = variants['']; obs.returned = v.returned === undefined ? null : v.returned; if (v.threw) obs.threw = v.threw; obs.calls = v.calls; }
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
    // 자동으로 재현할 호출이 없으면(협력자가 외부 시스템·콜백·훅 등) 통과시키지도 실패시키지도 않고, 사용자가 실제 함수를 직접 호출해 확인하게 한다.
    if (ex.modules.length) {
      const work0 = fs.mkdtempSync(path.join(opts.outDir, 'real-env-'));
      return { status: 'passed', manual: true, reason: `자동으로 재현할 호출이 없어 mock 대신 실제 함수를 사용자가 직접 호출해 확인해야 함(${ex.skipped.length}건)`, browsers: [], scenarios: [], skipped: ex.skipped, live: { dir: work0, scenarios: {}, console: { packageDir: opts.packageDir, projectRoot: opts.projectRoot, modules: ex.modules, symbols: ex.symbols } } };
    }
    return fail(`실환경에서 재현할 SUT 호출을 테스트에서 찾지 못함${ex.skipped[0] ? ` — ${ex.skipped[0].reason}` : ''}. 실제 검증이 성립하지 않아 통과로 처리하지 않음`, [], ex.skipped);
  }
  const work = fs.mkdtempSync(path.join(opts.outDir, 'real-env-'));
  const mods = [...new Set(ex.scenarios.flatMap((s) => [s.moduleRel, ...(s.setup ?? []).map((t) => t.moduleRel)]))];
  const nodePaths = [path.join(opts.projectRoot, 'node_modules')];
  const prepared = ex.scenarios.map((s) => {
    const setup = (s.setup ?? []).map((t) => ({ name: t.name, kind: t.kind, mod: mods.indexOf(t.moduleRel), exportName: t.exportName, args: t.args }));
    return { id: s.id, mod: mods.indexOf(s.moduleRel), exportName: s.exportName, bindings: s.bindings, args: s.args, env: s.env, setup, mods: [...new Set([mods.indexOf(s.moduleRel), ...setup.map((t) => t.mod)])] };
  });
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
        if (browserScenarios.some((s) => s.mods.includes(i))) { const f = `${tag}${i}.js`; await bundle(entry, path.join(work, f), 'browser', gname, nodePaths); browserFiles.push(f); }
        if (serverScenarios.some((s) => s.mods.includes(i))) { const f = path.join(work, `${tag}${i}.cjs`); await bundle(entry, f, 'node', gname, nodePaths); (tag === 'B' ? nodeBundles.base : nodeBundles.cand)[i] = f; }
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
      const same = sigOf(b) === sigOf(c);
      return { browser: o.name, base: b, cand: c, verdict: same ? 'pass' : 'fail', reason: same ? '프로젝트 dist와 같은 결과(저장소 상태·호출 순서·반환·예외)' : '배포 후보와 프로젝트 dist의 실제 환경 결과가 다름' };
    });
    const common = { id: s.id, testName: s.testName, line: s.line, env: s.env, moduleRel: s.moduleRel, exportName: s.exportName, args: s.args, runs };
    if (!runs.length) return { ...common, verdict: 'error' as const, reason: '실행한 환경이 없음' };
    const bad = runs.find((r) => r.verdict !== 'pass');
    if (bad) return { ...common, verdict: bad.verdict, reason: `${bad.browser}: ${bad.reason}` };
    // 크로스브라우징: 같은 배포 후보가 브라우저마다 다른 결과를 내면 프레임워크 결함이다.
    const sig = (r: ScenarioRun) => (r.cand ? sigOf(r.cand) : '');
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
  const live: Record<string, LiveScenario> = {};
  for (const sc of prepared) if (sc.env === 'browser') live[sc.id] = { mod: sc.mod, mods: sc.mods, exportName: sc.exportName, bindings: sc.bindings, args: sc.args, setup: sc.setup };
  const manual = ex.skipped.length > 0;
  return { status, reason: manual && status === 'passed' ? `${reason} · 자동 재현하지 못한 ${ex.skipped.length}건은 사용자가 직접 호출해 확인` : reason, manual, browsers, scenarios, skipped: ex.skipped, live: { dir: work, scenarios: live, console: { packageDir: opts.packageDir, projectRoot: opts.projectRoot, modules: ex.modules, symbols: ex.symbols } } };
}

const esc = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');

/**
 * 배포 후보 번들(C{n}.js)을 실제 브라우저에서 직접 호출해 보는 화면.
 * mock 없이 진짜 window.sessionStorage에 쓰고, 호출 순서·반환·예외·저장소 상태를 그대로 보여 준다.
 * 인자 식과 사전 저장소(JSON)는 사용자가 바꿔 다시 실행할 수 있다.
 */
export async function liveFrameHtml(opts: { runId: string; sc: LiveScenario; scenarioId?: string; argsText?: string; seedText?: string }): Promise<string> {
  const { transform } = await import('esbuild');
  const argsText = opts.argsText ?? opts.sc.args.join(', ');
  let seed: unknown = {};
  let seedErr = '';
  try { seed = opts.seedText?.trim() ? JSON.parse(opts.seedText) : {}; } catch (e) { seedErr = (e as Error).message; }
  const sc = { id: 'live', mod: opts.sc.mod, exportName: opts.sc.exportName, bindings: opts.sc.bindings, args: [argsText], seed, setup: opts.sc.setup };
  const code = (await transform(`${RUNNER}
(function () {
  var sc = ${JSON.stringify(sc).replace(/</g, '\\u003c')};
  var side = {}; ${JSON.stringify(opts.sc.mods)}.forEach(function (i) { side[i] = window['__stageC_' + i]; });
  var out = document.getElementById('out');
  var show = function (o) { out.textContent = JSON.stringify(o, null, 2); };
  if (${JSON.stringify(seedErr)}) { show({ 오류: '사전 저장소 JSON 오류: ' + ${JSON.stringify(seedErr)} }); return; }
  __stageRunAll(true, [sc], side).then(function (r) {
    var o = r.live;
    show({ 호출: sc.exportName + '(' + sc.args[0] + ')', 반환값: o.returned, 예외: o.threw || null, '호출 순서(실제 Storage)': o.calls, '호출 후 실제 sessionStorage': o.storage && o.storage.sessionStorage, 설정오류: o.setupError || null });
  }, function (e) { show({ 오류: String(e && e.stack || e) }); });
})();`, { target: 'es2018' })).code;
  return `<!doctype html><meta charset="utf-8"><title>live</title>
<style>body{font:13px/1.5 system-ui,sans-serif;margin:8px}textarea{width:100%;box-sizing:border-box;font:12px ui-monospace,monospace}pre{background:#f4f4f5;padding:8px;border-radius:6px;overflow:auto;margin:6px 0 0}label{display:block;font-weight:600;margin-top:6px}button{margin-top:6px;padding:4px 12px}</style>
<form method="get"><label>호출 인자 (JS 식, 테스트의 상수 사용 가능)</label><textarea name="args" rows="2">${esc(argsText)}</textarea>
<label>실행 전 sessionStorage (JSON, 예: {"access_token":"old"})</label><textarea name="seed" rows="2">${esc(opts.seedText ?? '')}</textarea>
<button type="submit">실제 함수 다시 실행</button></form>
<pre id="out">실행 중…</pre>
<script>window.process = window.process || { env: { NODE_ENV: "production" } };</script>
${opts.sc.mods.map((i) => `<script src="/api/runs/${encodeURIComponent(opts.runId)}/live-file/C${i}.js"></script>`).join('\n')}
<script>${code.replace(/<\/script/gi, '<\\/script')}</script>
<script>document.querySelector('form').addEventListener('input', function () {
  parent.postMessage({ stageCode: true, runId: ${JSON.stringify(opts.runId)}, scenarioId: ${JSON.stringify(opts.scenarioId ?? '')}, args: this.elements.args.value, seed: this.elements.seed.value }, '*');
});</script>`;
}

/**
 * 직접 호출 화면용 번들: 테스트가 import한 배포 후보 모듈 전부를 한 번들에 넣어 `window.__stageM`으로 노출한다.
 * React가 있으면 같은 번들에 함께 넣어(React 사본이 하나여야 훅이 동작) `renderHook` 도우미를 제공한다.
 */
export async function buildLiveConsole(dir: string, c: LiveConsole): Promise<string> {
  const outFile = path.join(dir, 'console-v2.js');
  if (fs.existsSync(outFile)) return outFile;
  const { build } = await import('esbuild');
  const imports = c.modules.map((m, i) => `import * as m${i} from ${JSON.stringify(path.join(c.packageDir, m))};`).join('\n');
  const merge = `window.__stageModules = [${c.modules.map((_, i) => `m${i}`).join(', ')}]; window.__stageM = Object.assign({}, ...window.__stageModules);`;
  const helper = `
import * as __R from 'react';
import { createRoot as __createRoot } from 'react-dom/client';
window.__stageReact = __R.default || __R;
window.__stageRenderHook = (${createHookRenderer.toString()})(__R, __createRoot);`;
  const common = { bundle: true, outfile: outFile, logLevel: 'silent' as const, platform: 'browser' as const, format: 'iife' as const, target: 'es2018', nodePaths: [path.join(c.projectRoot, 'node_modules')], define: { 'process.env.NODE_ENV': '"production"' }, absWorkingDir: c.packageDir };
  try { await build({ ...common, stdin: { contents: `${imports}\n${helper}\n${merge}`, resolveDir: c.packageDir, loader: 'js' } }); }
  catch { await build({ ...common, stdin: { contents: `${imports}\n${merge}`, resolveDir: c.packageDir, loader: 'js' } }); }
  return outFile;
}

/** 배포 후보의 함수를 mock 없이 직접 호출해 보는 화면(자동으로 재현하지 못한 호출을 사람이 확인하는 용도) */
export function liveConsoleHtml(opts: { runId: string; symbols: LiveConsole['symbols']; hint?: string }): string {
  const names = [...new Set(opts.symbols.map((s) => s.name.split(' as ').pop()!))];
  const snippet = `${opts.hint ? `// ${opts.hint.replace(/\n/g, ' ')}\n` : ''}// m은 실제 배포 후보 모듈입니다. 아래 기본 코드는 export 목록만 조회합니다.
// HTTP 확인 시 호출할 서버 주소로 client를 생성하고 await client.get(path) 등을 작성하세요.
// 사용 가능: ${names.map((n) => `m.${n}`).join(', ') || '(없음)'}
// 훅은 renderHook으로: const h = await renderHook(() => m.useSomething(args)); return h.current;
return Object.keys(m);`;
  const runId = encodeURIComponent(opts.runId);
  return `<!doctype html><meta charset="utf-8"><title>직접 호출</title>
<style>body{font:13px/1.5 system-ui,sans-serif;margin:8px}textarea{width:100%;box-sizing:border-box;font:12px ui-monospace,monospace}pre{background:#f4f4f5;padding:8px;border-radius:6px;overflow:auto;margin:6px 0 0;max-height:14rem;white-space:pre-wrap}button{margin-top:6px;padding:4px 12px}.m{color:#666}</style>
<label><b>실제 함수 호출 코드</b> <span class="m">(async 함수 본문, <code>return</code>한 값이 결과)</span></label>
<textarea id="code" rows="7" spellcheck="false">${esc(snippet)}</textarea>
<button id="run" type="button">실행</button> <span class="m" id="st"></span>
<pre id="out">아직 실행하지 않았습니다.</pre>
<script>window.process = window.process || { env: { NODE_ENV: "production" } };</script>
<script>
(function () {
  var out = document.getElementById('out'), st = document.getElementById('st');
  var seen = function () { var s = []; return function (k, v) { if (typeof v === 'function') return '[Function ' + (v.name || '') + ']'; if (v instanceof Error) return v.name + ': ' + v.message; if (v && typeof v === 'object') { if (s.indexOf(v) >= 0) return '[Circular]'; s.push(v); } return v; }; };
  var show = function (v) { try { return JSON.stringify(v === undefined ? '(undefined)' : v, seen(), 2); } catch (e) { return String(v); } };
  window.addEventListener('message', function (e) {
    if (e.source === parent && e.data && typeof e.data.restoreStageCode === 'string') document.getElementById('code').value = e.data.restoreStageCode;
  });
  document.getElementById('code').addEventListener('input', function () {
    parent.postMessage({ stageCode: true, runId: ${JSON.stringify(opts.runId)}, code: document.getElementById('code').value }, '*');
  });
  var requests = null;
  var nativeFetch = window.fetch;
  if (nativeFetch) window.fetch = async function (input, init) {
    var record = { 전송: 'fetch', 메서드: String(init && init.method || input && input.method || 'GET').toUpperCase(), URL: String(input && input.url || input), 상태: '응답 대기' };
    if (requests) requests.push(record);
    try {
      var response = await nativeFetch.apply(this, arguments);
      record.상태 = response.status;
      record.응답URL = response.url;
      return response;
    } catch (e) { record.상태 = '전송 실패'; record.오류 = String(e); throw e; }
  };
  if (window.XMLHttpRequest) {
    var details = new WeakMap();
    var proto = window.XMLHttpRequest.prototype, open = proto.open, send = proto.send;
    proto.open = function (method, url) {
      var result = open.apply(this, arguments);
      details.set(this, { 전송: 'XMLHttpRequest', 메서드: String(method).toUpperCase(), URL: String(url), 상태: '응답 대기' });
      return result;
    };
    proto.send = function () {
      var record = details.get(this), xhr = this;
      if (requests && record) requests.push(record);
      if (record) {
        var update = function () {
          record.상태 = xhr.status || '전송 실패 (네트워크·CORS·취소 등)';
          record.응답URL = xhr.responseURL;
        };
        this.addEventListener('readystatechange', function () { if (xhr.readyState === 4) update(); });
        this.addEventListener('loadend', update, { once: true });
      }
      try { return send.apply(this, arguments); }
      catch (e) { if (record) { record.상태 = '전송 실패'; record.오류 = String(e); } throw e; }
    };
  }
  document.getElementById('run').onclick = async function () {
    if (!window.__stageM) { out.textContent = '배포 후보 번들을 불러오지 못했습니다.'; return; }
    var button = document.getElementById('run');
    button.disabled = true;
    requests = [];
    var logs = []; var orig = {};
    ['log', 'info', 'warn', 'error'].forEach(function (m) { orig[m] = console[m]; console[m] = function () { logs.push(m + ': ' + Array.prototype.slice.call(arguments).map(function (a) { return typeof a === 'string' ? a : show(a); }).join(' ')); return orig[m].apply(console, arguments); }; });
    st.textContent = '실행 중…';
    var text;
    try {
      var rh = window.__stageRenderHook || function () { throw new Error('이 프로젝트에서 React를 찾지 못해 renderHook을 쓸 수 없음'); };
      var r = await new Function('m', 'renderHook', 'return (async function(){' + document.getElementById('code').value + '\\n})()')(window.__stageM, rh);
      text = '반환값\\n' + show(r);
    } catch (e) { text = '예외\\n' + (e && e.stack || e); }
    Object.keys(orig).forEach(function (m) { console[m] = orig[m]; });
    out.textContent = text + '\\n\\nHTTP 요청 (실행 중 fetch·XMLHttpRequest 관찰)\\n' + (requests.length ? show(requests) : '관찰된 HTTP 요청 0건. 기본 코드는 export 목록만 조회합니다. HTTP 호출 코드를 작성하고 await로 완료를 기다리세요.') + (logs.length ? '\\n\\nconsole 출력\\n' + logs.join('\\n') : '') + '\\n\\n실제 sessionStorage\\n' + show((function () { var o = {}; try { Object.keys(sessionStorage).forEach(function (k) { o[k] = sessionStorage.getItem(k); }); } catch (e) {} return o; })());
    requests = null;
    button.disabled = false;
    st.textContent = '';
  };
})();
</script>
<script src="/api/runs/${runId}/live-console.js"></script>`;
}
