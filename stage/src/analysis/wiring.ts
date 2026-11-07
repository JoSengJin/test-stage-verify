// 실물 연결 구성 추출. 테스트가 공개 API(SUT)를 호출할 때 협력자를 대체 객체로 바꿔 끼운 지점을 찾아
// "대체 객체를 걷어내고 실제 모듈·실제 서버로 호출"하는 3단계 화면의 전환 항목으로 만든다.
// 시나리오 실행 모델(analyze.ts)과 달리 테스트 전체를 해석하지 않고 호출 지점의 옵션만 본다(타입 검사기 불필요).
import ts from 'typescript';
import type { ImportInfo, Loc, Value, Wiring, WiringCall, WiringCollaborator, WiringOption, WiringTest } from '../model.ts';

const HTTP_VERBS = new Set(['get', 'post', 'put', 'patch', 'delete']);
const SUITE_NAMES = new Set(['describe', 'suite']);
const CASE_NAMES = new Set(['test', 'it']);

interface Double { methods: string[]; origin: string }
type Scope = Map<string, ts.Expression>;

const unwrap = (e: ts.Expression): ts.Expression => {
  let cur = e;
  for (;;) {
    if (ts.isParenthesizedExpression(cur) || ts.isAwaitExpression(cur) || ts.isAsExpression(cur) || ts.isNonNullExpression(cur) || ts.isSatisfiesExpression(cur)) cur = cur.expression;
    else return cur;
  }
};

const propName = (n: ts.PropertyName): string | undefined =>
  ts.isIdentifier(n) || ts.isStringLiteralLike(n) || ts.isNumericLiteral(n) ? n.text : undefined;

export function extractWiring(sf: ts.SourceFile, imports: ImportInfo[], rel: (file: string) => string): Wiring | undefined {
  const sutSpecs = new Set(imports.filter((i) => i.role === 'public-package' || i.role === 'target-source').map((i) => i.specifier));
  if (sutSpecs.size === 0) return undefined;

  const text = (n: ts.Node) => { const t = n.getText(sf).replace(/\s+/g, ' '); return t.length > 200 ? t.slice(0, 197) + '...' : t; };
  const loc = (n: ts.Node): Loc => { const { line, character } = sf.getLineAndCharacterOfPosition(n.getStart(sf)); return { file: rel(sf.fileName), line: line + 1, column: character + 1 }; };

  // ---- SUT·node:test 바인딩 ----
  const sutLocal = new Map<string, { name: string; specifier: string }>();
  const caseNames = new Set<string>();
  const suiteNames = new Set<string>();
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
    const spec = st.moduleSpecifier.text;
    const nb = st.importClause?.namedBindings;
    if (spec === 'node:test' && nb && ts.isNamedImports(nb)) {
      for (const el of nb.elements) {
        const imported = (el.propertyName ?? el.name).text;
        if (CASE_NAMES.has(imported)) caseNames.add(el.name.text);
        if (SUITE_NAMES.has(imported)) suiteNames.add(el.name.text);
      }
    }
    if (!sutSpecs.has(spec) || st.importClause?.isTypeOnly) continue;
    if (st.importClause?.name) sutLocal.set(st.importClause.name.text, { name: 'default', specifier: spec });
    if (nb && ts.isNamedImports(nb)) for (const el of nb.elements) if (!el.isTypeOnly) sutLocal.set(el.name.text, { name: (el.propertyName ?? el.name).text, specifier: spec });
  }
  // const { a, b: c } = await import('spec')
  const findDynamic = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) && ts.isObjectBindingPattern(n.name) && n.initializer) {
      const init = unwrap(n.initializer);
      if (ts.isCallExpression(init) && init.expression.kind === ts.SyntaxKind.ImportKeyword && init.arguments[0] && ts.isStringLiteralLike(init.arguments[0]) && sutSpecs.has(init.arguments[0].text)) {
        for (const el of n.name.elements) if (ts.isIdentifier(el.name)) sutLocal.set(el.name.text, { name: (el.propertyName && ts.isIdentifier(el.propertyName) ? el.propertyName.text : el.name.text), specifier: init.arguments[0].text });
      }
    }
    ts.forEachChild(n, findDynamic);
  };
  findDynamic(sf);
  if (sutLocal.size === 0) return undefined;
  if (caseNames.size === 0) for (const n of CASE_NAMES) caseNames.add(n);
  if (suiteNames.size === 0) for (const n of SUITE_NAMES) suiteNames.add(n);

  // ---- 대체 객체를 만드는 파일 내 보조 함수 ----
  const helpers = new Map<string, ts.FunctionLikeDeclaration>();
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && st.name && st.body) helpers.set(st.name.text, st);
    if (ts.isVariableStatement(st)) for (const d of st.declarationList.declarations) {
      const init = d.initializer && unwrap(d.initializer);
      if (ts.isIdentifier(d.name) && init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) helpers.set(d.name.text, init);
    }
  }
  const isMockCall = (c: ts.CallExpression) => {
    const f = c.expression;
    return ts.isPropertyAccessExpression(f) && ['fn', 'method', 'getter', 'setter'].includes(f.name.text) && /(^|\.)mock$/.test(f.expression.getText(sf));
  };
  const makers = new Set<string>();
  const containsMock = (n: ts.Node, names: Set<string>): boolean => {
    let found = false;
    const v = (x: ts.Node) => {
      if (found) return;
      if (ts.isCallExpression(x) && (isMockCall(x) || (ts.isIdentifier(x.expression) && names.has(x.expression.text)))) { found = true; return; }
      ts.forEachChild(x, v);
    };
    ts.forEachChild(n, v);
    return found;
  };
  for (let changed = true; changed;) {
    changed = false;
    for (const [name, fn] of helpers) if (!makers.has(name) && containsMock(fn, makers)) { makers.add(name); changed = true; }
  }
  const returnedKeys = (fn: ts.FunctionLikeDeclaration): string[] => {
    let keys: string[] = [];
    const visitReturn = (n: ts.Node): void => {
      if (ts.isReturnStatement(n) && n.expression) {
        const e = unwrap(n.expression);
        if (ts.isObjectLiteralExpression(e) && !keys.length) keys = e.properties.flatMap((p) => (ts.isPropertyAssignment(p) || ts.isMethodDeclaration(p) || ts.isShorthandPropertyAssignment(p)) && p.name ? [propName(p.name) ?? ''] : []).filter(Boolean);
      }
      if (n !== fn && (ts.isFunctionLike(n))) return; // 중첩 함수의 return은 제외
      ts.forEachChild(n, visitReturn);
    };
    if (ts.isArrowFunction(fn) && !ts.isBlock(fn.body)) { const e = unwrap(fn.body); if (ts.isObjectLiteralExpression(e)) keys = e.properties.flatMap((p) => (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) && p.name ? [propName(p.name) ?? ''] : []).filter(Boolean); }
    else if (fn.body) ts.forEachChild(fn.body, visitReturn);
    return keys;
  };

  // ---- 식 분류: 대체 객체인가 ----
  const lookup = (name: string, scopes: Scope[]) => { for (let i = scopes.length - 1; i >= 0; i--) { const v = scopes[i].get(name); if (v) return v; } return undefined; };
  const classify = (expr: ts.Expression, scopes: Scope[], depth = 0): Double | undefined => {
    if (depth > 6) return undefined;
    const e = unwrap(expr);
    if (ts.isIdentifier(e)) { const init = lookup(e.text, scopes); return init ? classify(init, scopes, depth + 1) : undefined; }
    if (ts.isCallExpression(e)) {
      if (isMockCall(e)) return { methods: ['()'], origin: text(e) };
      // 대체 객체 생성기(createRecorder 등)를 인자로 받아 협력자를 만드는 보조 함수(createClientMock(rec) 등)도 대체 객체 생성자로 본다.
      const isFactoryVar = (a: ts.Expression) => {
        const ua = unwrap(a);
        const v = ts.isIdentifier(ua) ? lookup(ua.text, scopes) : ua; // 변수로 받은 생성기, 또는 인자 자리에서 바로 만든 생성기
        const c = v && unwrap(v);
        return !!c && ts.isCallExpression(c) && ts.isIdentifier(c.expression) && makers.has(c.expression.text);
      };
      if (ts.isIdentifier(e.expression) && helpers.has(e.expression.text) && (makers.has(e.expression.text) || e.arguments.some(isFactoryVar))) {
        const keys = returnedKeys(helpers.get(e.expression.text)!);
        return { methods: keys.length ? keys : ['()'], origin: text(e) };
      }
      // rec.fn(...) — 대체 객체 생성기(createRecorder 등)가 만든 객체의 메서드 호출
      const f = e.expression;
      if (ts.isPropertyAccessExpression(f) && ts.isIdentifier(f.expression)) {
        const base = lookup(f.expression.text, scopes);
        const b = base && unwrap(base);
        if (b && ts.isCallExpression(b) && ts.isIdentifier(b.expression) && makers.has(b.expression.text)) return { methods: ['()'], origin: text(e) };
      }
      return undefined;
    }
    if (ts.isObjectLiteralExpression(e)) {
      const methods: string[] = [];
      let any = false;
      for (const p of e.properties) {
        if (ts.isPropertyAssignment(p) && p.name) { const n = propName(p.name); if (n) methods.push(n); if (classify(p.initializer, scopes, depth + 1)) any = true; }
        else if (ts.isShorthandPropertyAssignment(p)) { methods.push(p.name.text); if (classify(p.name, scopes, depth + 1)) any = true; }
        else if (ts.isSpreadAssignment(p)) { const d = classify(p.expression, scopes, depth + 1); if (d) { any = true; methods.push(...d.methods); } }
      }
      return any ? { methods: [...new Set(methods)], origin: text(e) } : undefined;
    }
    return undefined;
  };

  const literal = (expr: ts.Expression): { ok: true; value: Value } | { ok: false } => {
    const e = unwrap(expr);
    if (ts.isStringLiteralLike(e)) return { ok: true, value: e.text };
    if (ts.isNumericLiteral(e)) return { ok: true, value: Number(e.text) };
    if (e.kind === ts.SyntaxKind.TrueKeyword) return { ok: true, value: true };
    if (e.kind === ts.SyntaxKind.FalseKeyword) return { ok: true, value: false };
    if (e.kind === ts.SyntaxKind.NullKeyword) return { ok: true, value: null };
    if (ts.isIdentifier(e) && e.text === 'undefined') return { ok: true, value: { $stage: 'undefined' } };
    if (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(e.operand)) return { ok: true, value: -Number(e.operand.text) };
    if (ts.isArrayLiteralExpression(e)) {
      const out: Value[] = [];
      for (const el of e.elements) { const r = literal(el); if (!r.ok) return r; out.push(r.value); }
      return { ok: true, value: out };
    }
    if (ts.isObjectLiteralExpression(e)) {
      const out: Record<string, Value> = {};
      for (const p of e.properties) {
        if (!ts.isPropertyAssignment(p) || !p.name) return { ok: false };
        const n = propName(p.name);
        const r = n === undefined ? ({ ok: false } as const) : literal(p.initializer);
        if (!r.ok) return r;
        out[n!] = r.value;
      }
      return { ok: true, value: out };
    }
    return { ok: false };
  };

  const roleOf = (option: string, methods: string[]): WiringCollaborator['role'] =>
    option === 'client' || methods.some((m) => HTTP_VERBS.has(m)) ? 'http-client' : 'observer';

  // ---- 호출 지점 ----
  const makeCall = (call: ts.CallExpression | ts.NewExpression, sut: { name: string; specifier: string }, id: string, scopes: Scope[]): WiringCall => {
    const args = call.arguments ?? [];
    const options: WiringOption[] = [];
    const collaborators: WiringCollaborator[] = [];
    const addDouble = (key: string, d: Double, node: ts.Node, source: string) => {
      options.push({ key, kind: 'double', source });
      collaborators.push({ option: key, role: roleOf(key, d.methods), methods: d.methods.filter((m) => m !== '()'), origin: d.origin, loc: loc(node) });
    };
    const first = args[0];
    const pathArg = first && ts.isStringLiteralLike(first) ? first.text : undefined;
    for (const [i, arg] of args.entries()) {
      const obj = unwrap(arg);
      if (!ts.isObjectLiteralExpression(obj)) {
        // new OrderService(http)처럼 위치 인자로 넘긴 대체 객체
        const d = classify(arg, scopes);
        if (d) addDouble(`arg${i}`, d, arg, text(arg));
        continue;
      }
      for (const p of obj.properties) {
        if (ts.isSpreadAssignment(p)) {
          const d = classify(p.expression, scopes);
          if (d) for (const m of d.methods.filter((x) => x !== '()')) addDouble(m, { methods: ['()'], origin: d.origin }, p, text(p));
          else options.push({ key: `...${text(p.expression)}`, kind: 'other', source: text(p) });
          continue;
        }
        const key = ts.isShorthandPropertyAssignment(p) ? p.name.text : ts.isPropertyAssignment(p) && p.name ? propName(p.name) : undefined;
        if (!key) { options.push({ key: '?', kind: 'other', source: text(p) }); continue; }
        const valueExpr: ts.Expression = ts.isShorthandPropertyAssignment(p) ? p.name : (p as ts.PropertyAssignment).initializer;
        const d = classify(valueExpr, scopes);
        if (d) { addDouble(key, d, p, text(p)); continue; }
        const lit = literal(valueExpr);
        if (lit.ok) { options.push({ key, kind: 'literal', value: lit.value, source: text(valueExpr) }); continue; }
        const v = unwrap(valueExpr);
        options.push({ key, kind: ts.isArrowFunction(v) || ts.isFunctionExpression(v) ? 'function' : 'other', source: text(valueExpr) });
      }
    }
    return { id, sut: sut.name, specifier: sut.specifier, path: pathArg, options, collaborators, loc: loc(call) };
  };

  const constsOf = (body: ts.Node): Scope => {
    const s: Scope = new Map();
    const stmts = ts.isBlock(body) || ts.isSourceFile(body) ? body.statements : [];
    for (const st of stmts) if (ts.isVariableStatement(st) && st.declarationList.flags & ts.NodeFlags.Const) {
      for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name) && d.initializer) s.set(d.name.text, d.initializer);
    }
    // beforeEach 등 준비 훅에서 `http = {...}`처럼 나중에 대입한 변수(let)도 협력자 출처로 본다(첫 대입 기준).
    const assigns = (list: readonly ts.Statement[]) => {
      for (const st of list) {
        if (ts.isExpressionStatement(st) && ts.isBinaryExpression(st.expression) && st.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(st.expression.left) && !s.has(st.expression.left.text)) s.set(st.expression.left.text, st.expression.right);
      }
    };
    assigns(stmts);
    for (const st of stmts) {
      if (!ts.isExpressionStatement(st) || !ts.isCallExpression(st.expression) || !ts.isIdentifier(st.expression.expression) || !/^(before|beforeEach)$/.test(st.expression.expression.text)) continue;
      const cb = st.expression.arguments.find((a): a is ts.ArrowFunction | ts.FunctionExpression => ts.isArrowFunction(a) || ts.isFunctionExpression(a));
      if (cb && ts.isBlock(cb.body)) assigns(cb.body.statements);
    }
    return s;
  };

  const tests: WiringTest[] = [];
  const titleOf = (c: ts.CallExpression) => { const a = c.arguments[0]; return a && ts.isStringLiteralLike(a) ? a.text : text(c.arguments[0] ?? c); };
  const callbackOf = (c: ts.CallExpression) => c.arguments.find((a): a is ts.ArrowFunction | ts.FunctionExpression => ts.isArrowFunction(a) || ts.isFunctionExpression(a));

  type SutNode = ts.CallExpression | ts.NewExpression;
  const isSutNode = (n: ts.Node): n is SutNode => (ts.isCallExpression(n) || ts.isNewExpression(n)) && ts.isIdentifier(n.expression) && sutLocal.has(n.expression.text);
  /** 협력자나 고정 옵션을 넘기지 않는 호출(예: 대체 객체 안에서 만든 오류 객체)은 연결 지점이 아니다. */
  const addCall = (test: WiringTest, n: SutNode, scopes: Scope[]) => {
    const call = makeCall(n, sutLocal.get((n.expression as ts.Identifier).text)!, `${test.id}.c${test.calls.length + 1}`, scopes);
    if (call.collaborators.length || call.options.some((o) => o.kind === 'literal')) test.calls.push(call);
  };
  /** describe 안 beforeEach에서 만든 SUT는 그 describe의 모든 테스트가 쓰는 것으로 본다. */
  const hookSutNodes = (body: ts.Node): SutNode[] => {
    const out: SutNode[] = [];
    const stmts = ts.isBlock(body) ? body.statements : [];
    for (const st of stmts) {
      if (!ts.isExpressionStatement(st) || !ts.isCallExpression(st.expression) || !ts.isIdentifier(st.expression.expression) || !/^(before|beforeEach)$/.test(st.expression.expression.text)) continue;
      const cb = callbackOf(st.expression);
      const v = (n: ts.Node) => { if (isSutNode(n)) out.push(n); ts.forEachChild(n, v); };
      if (cb) v(cb.body);
    }
    return out;
  };

  const walkTest = (c: ts.CallExpression, pathNames: string[], scopes: Scope[], inherited: SutNode[]) => {
    const fn = callbackOf(c);
    if (!fn) return;
    const test: WiringTest = { id: `wt${tests.length + 1}`, title: titleOf(c), path: [...pathNames, titleOf(c)], loc: loc(c), calls: [], globals: [] };
    const inner = [...scopes, constsOf(fn.body)];
    for (const n of inherited) addCall(test, n, scopes);
    const visit = (n: ts.Node) => {
      if (isSutNode(n)) addCall(test, n, inner);
      if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isPropertyAccessExpression(n.left) && /^(globalThis|global|window)$/.test(n.left.expression.getText(sf)) && classify(n.right, inner)) {
        test.globals.push(n.left.name.text);
      }
      ts.forEachChild(n, visit);
    };
    visit(fn.body);
    if (test.calls.length) tests.push(test);
  };

  const walk = (n: ts.Node, pathNames: string[], scopes: Scope[], inherited: SutNode[]) => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) {
      if (suiteNames.has(n.expression.text)) {
        const fn = callbackOf(n);
        if (fn) {
          const sc = [...scopes, constsOf(fn.body)];
          const inh = [...inherited, ...hookSutNodes(fn.body)];
          ts.forEachChild(fn.body, (x) => walk(x, [...pathNames, titleOf(n)], sc, inh));
        }
        return;
      }
      if (caseNames.has(n.expression.text)) { walkTest(n, pathNames, scopes, inherited); return; }
    }
    ts.forEachChild(n, (x) => walk(x, pathNames, scopes, inherited));
  };
  const fileScope = constsOf(sf);
  ts.forEachChild(sf, (x) => walk(x, [], [fileScope], []));

  const called = new Set(tests.flatMap((t) => t.calls.map((c) => `${c.specifier}\u0000${c.sut}`)));
  const sut = [...sutLocal.values()].filter((s, i, all) => all.findIndex((o) => o.name === s.name && o.specifier === s.specifier) === i && called.has(`${s.specifier}\u0000${s.name}`));
  return { sut, tests, needsHttpClient: tests.some((t) => t.calls.some((c) => c.collaborators.some((k) => k.role === 'http-client'))) };
}
