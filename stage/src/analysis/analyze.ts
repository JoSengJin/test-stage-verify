// 테스트 파일 분석기. TypeScript parser·type checker로 import·대상·대체 객체·동작·assertion을 해석해
// 공통 실행 모델(Scenario)을 만든다. 규칙에 맞지 않는 부분은 추측하지 않고 Finding으로 남긴다.
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import {
  FRAMEWORK_VERSION, RULES_VERSION,
  type AnalysisResult, type ArgRef, type AssertModule, type Behavior, type Check, type ConsumerLink, type DoubleSpec,
  type ErrorMatcher, type Finding, type ImportInfo, type Loc, type ParamInfo, type ProjectInfo, type Scenario, type Step,
  type Subject, type SupportStatus, type TargetRef, type Value,
} from '../model.ts';
import { projectInfo, readJson } from './project.ts';
import { awaitedReturn, toSchema } from './schema.ts';
import { extractWiring } from './wiring.ts';
import { detectScriptTarget } from './script.ts';
import { newId, sha256 } from '../util.ts';

// ---- 인식 규칙 표 (규칙 확장 지점) ----
const NODE_TEST = new Set(['node:test', 'test']);
const NODE_ASSERT: Record<string, AssertModule> = {
  'node:assert': 'node:assert', assert: 'node:assert',
  'node:assert/strict': 'node:assert/strict', 'assert/strict': 'node:assert/strict',
};
/** 인식기는 없지만 테스트 도구로 알려진 모듈. 대상과 구분만 하고, 사용 시 미지원으로 표시한다. */
const KNOWN_TOOLS = new Set(['vitest', '@jest/globals', 'jest', 'sinon', 'chai', 'mocha', '@testing-library/react', 'uvu', 'ava', 'tap']);
const COMPARE_OPS = new Set([
  'equal', 'strictEqual', 'deepEqual', 'deepStrictEqual', 'notEqual', 'notStrictEqual', 'notDeepEqual',
  'notDeepStrictEqual', 'partialDeepStrictEqual', 'ok',
]);
const TEST_FNS = new Set(['test', 'it']);
const SUITE_FNS = new Set(['describe', 'suite']);
const BUILTIN_ERRORS = new Set(['Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError']);

type Tool =
  | { mod: 'test'; name: string; modifier?: string }
  | { mod: 'assert'; module: AssertModule; name: string }
  | { mod: 'other'; spec: string };

type Sym =
  | { t: 'value'; value: Value }
  | { t: 'unknown'; reason: string; loc: Loc }
  | { t: 'target'; ref: TargetRef; symbol: ts.Symbol }
  | { t: 'instance'; id: string; targetId: string; classSymbol: ts.Symbol }
  | { t: 'promise'; step: string }
  | { t: 'result'; step: string; path: (string | number)[] }
  | { t: 'double'; id: string }
  | { t: 'double-method'; id: string; method: string }
  | { t: 'fn'; node: ts.ArrowFunction | ts.FunctionExpression }
  | { t: 'void' };

interface Hook { kind: 'beforeEach' | 'afterEach'; fn: ts.ArrowFunction | ts.FunctionExpression }

export interface AnalyzeInput {
  testFile: string;
  projectRoot?: string;
  fileName?: string;
  linkEvidence?: string;
  linked?: boolean;
}

export function analyzeTestFile(input: AnalyzeInput): AnalysisResult {
  const content = fs.readFileSync(input.testFile, 'utf8');
  const findings: Finding[] = [];
  const result: AnalysisResult = {
    id: newId('an'),
    rulesVersion: RULES_VERSION,
    frameworkVersion: FRAMEWORK_VERSION,
    analyzedAt: new Date().toISOString(),
    input: {
      fileName: input.fileName ?? path.basename(input.testFile),
      sha256: sha256(content),
      linkedPath: input.projectRoot ? path.relative(input.projectRoot, input.testFile) : undefined,
      linkStatus: input.linked === false || !input.projectRoot ? 'not-linked' : 'linked',
      linkEvidence: input.linkEvidence ?? (input.projectRoot ? '프로젝트 경로 지정' : '프로젝트 연결 없음'),
    },
    imports: [],
    scenarios: [],
    findings,
    status: 'no-target',
  };
  let project: ProjectInfo | undefined;
  if (input.projectRoot) {
    project = projectInfo(input.projectRoot);
    result.project = project;
    const cfg = path.join(input.projectRoot, 'stage.config.json');
    result.stageConfig = fs.existsSync(cfg)
      ? { file: 'stage.config.json', sha256: sha256(fs.readFileSync(cfg)), present: true }
      : { file: 'stage.config.json', sha256: '', present: false };
    if (project.runner?.kind !== 'node-test') findings.push({ ruleId: 'runner/detect', level: 'unsupported', message: `1단계 러너 미지원: ${project.runner?.evidence}` });
    for (const e of project.publicEntries) if (!e.sourceFile) findings.push({ ruleId: 'public/entry-map', level: 'partial', message: e.evidence });
  } else {
    findings.push({ ruleId: 'project/link', level: 'partial', message: '프로젝트 연결 없음: 등록된 프로젝트에서 같은 내용의 파일을 찾지 못해 import·공개 API·러너를 해석할 수 없음' });
  }
  const a = new Analyzer(input.testFile, input.projectRoot, project, findings);
  a.run(result);
  return result;
}

class Analyzer {
  program: ts.Program;
  checker: ts.TypeChecker;
  sf: ts.SourceFile;
  options: ts.CompilerOptions;
  toolSyms = new Map<ts.Symbol, Tool>();
  targetBySymbol = new Map<ts.Symbol, TargetRef>(); // 원본(aliased) 심볼 → 대상
  localTarget = new Map<ts.Symbol, ts.Symbol>(); // import 로컬 심볼 → 원본 심볼
  targets: TargetRef[] = [];
  publicGraph = new Set<string>();
  publicExports: { specifier: string; exportName: string; symbol: ts.Symbol }[] = [];
  stageConfig: any;

  file: string;
  root: string | undefined;
  project: ProjectInfo | undefined;
  findings: Finding[];

  constructor(file: string, root: string | undefined, project: ProjectInfo | undefined, findings: Finding[]) {
    this.file = file; this.root = root; this.project = project; this.findings = findings;
    let options: ts.CompilerOptions = {};
    const cfgPath = root ? ts.findConfigFile(root, ts.sys.fileExists, 'tsconfig.json') : undefined;
    if (cfgPath && root && path.dirname(cfgPath) === root) {
      const parsed = ts.getParsedCommandLineOfConfigFile(cfgPath, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => {} });
      if (parsed) options = parsed.options;
    } else {
      options = { module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, target: ts.ScriptTarget.ES2022, strict: true };
    }
    this.options = { ...options, noEmit: true, allowJs: true, allowImportingTsExtensions: true, skipLibCheck: true, types: [] };
    const entries = (project?.publicEntries ?? []).flatMap((e) => (e.sourceFile ? [e.sourceFile] : []));
    this.program = ts.createProgram([file, ...entries], this.options);
    this.checker = this.program.getTypeChecker();
    this.sf = this.program.getSourceFile(file)!;
    if (root && fs.existsSync(path.join(root, 'stage.config.json'))) this.stageConfig = readJson(path.join(root, 'stage.config.json'));
    this.buildPublicGraph(entries);
  }

  loc(node: ts.Node): Loc {
    const sf = node.getSourceFile();
    const { line, character } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
    return { file: this.rel(sf.fileName), line: line + 1, column: character + 1 };
  }
  rel(f: string) { return this.root ? path.relative(this.root, f) : path.basename(f); }
  text(node: ts.Node) { const t = node.getText(this.sf).replace(/\s+/g, ' '); return t.length > 240 ? t.slice(0, 237) + '...' : t; }

  resolve(spec: string, from: string): ts.ResolvedModuleFull | undefined {
    return ts.resolveModuleName(spec, from, this.options, ts.sys).resolvedModule;
  }

  /** 공개 entry에서 도달 가능한 소스 파일 집합과 공개 export 목록. 재수출은 checker가 해석한다. */
  buildPublicGraph(entries: string[]) {
    const queue = [...entries];
    while (queue.length) {
      const f = path.resolve(queue.pop()!);
      if (this.publicGraph.has(f)) continue;
      this.publicGraph.add(f);
      const sf = this.program.getSourceFile(f);
      if (!sf) continue;
      for (const st of sf.statements) {
        const spec = (ts.isImportDeclaration(st) || ts.isExportDeclaration(st)) && st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier) ? st.moduleSpecifier.text : undefined;
        if (!spec) continue;
        const r = this.resolve(spec, f);
        if (r && !r.isExternalLibraryImport) queue.push(r.resolvedFileName);
      }
    }
    for (const e of this.project?.publicEntries ?? []) {
      if (!e.sourceFile) continue;
      const sf = this.program.getSourceFile(e.sourceFile);
      const modSym = sf && this.checker.getSymbolAtLocation(sf);
      if (!modSym) continue;
      for (const ex of this.checker.getExportsOfModule(modSym)) {
        const resolved = ex.flags & ts.SymbolFlags.Alias ? this.checker.getAliasedSymbol(ex) : ex;
        this.publicExports.push({ specifier: e.specifier, exportName: ex.name, symbol: resolved });
      }
    }
  }

  run(result: AnalysisResult) {
    this.collectImports(result.imports);
    // 최상위·describe 본문 순회
    const scenarios: Scenario[] = [];
    this.walkSuite(this.sf.statements, [], [], [], false, scenarios);
    result.scenarios = scenarios;
    if (scenarios.length === 0) this.findings.push({ ruleId: 'test/none', level: 'no-target', message: '인식한 테스트 케이스가 없음(node:test의 test/it 호출 없음)' });
    result.status = aggregate([...scenarios.map((s) => s.support.status)], this.findings);
    result.wiring = extractWiring(this.sf, result.imports, (f) => this.rel(f));
    result.script = detectScriptTarget(this.sf, this.sf.fileName, this.root);
  }

  // ---- import ----
  collectImports(out: ImportInfo[]) {
    const fileDir = this.file;
    const record = (spec: string, kind: ImportInfo['kind'], names: string[], node: ts.Node) => {
      let role: ImportInfo['role'];
      let evidence: string;
      let resolvedFile: string | undefined;
      if (NODE_TEST.has(spec) || NODE_ASSERT[spec]) { role = 'test-tool'; evidence = `${spec}: 인식기 있는 테스트 도구`; }
      else if (KNOWN_TOOLS.has(spec)) { role = 'test-tool'; evidence = `${spec}: 알려진 테스트 도구(현재 인식기 없음)`; }
      else {
        const r = this.resolve(spec, fileDir);
        const pkgName = this.project?.name;
        if (pkgName && (spec === pkgName || spec.startsWith(pkgName + '/'))) { role = 'public-package'; evidence = `패키지 자기 참조(${spec}): 공개 API 지정자`; resolvedFile = r?.resolvedFileName; }
        else if (!r) { role = 'unresolved'; evidence = `모듈 해석 실패(moduleResolution=${ts.ModuleResolutionKind[this.options.moduleResolution ?? 0] ?? '?'})`; }
        else if (r.isExternalLibraryImport) { role = 'external'; evidence = `외부 패키지: ${r.resolvedFileName}`; resolvedFile = r.resolvedFileName; }
        else {
          resolvedFile = r.resolvedFileName;
          const inPublic = this.publicGraph.has(path.resolve(r.resolvedFileName));
          role = inPublic ? 'target-source' : 'test-helper';
          evidence = inPublic ? `공개 entry에서 도달 가능한 소스: ${this.rel(r.resolvedFileName)}` : `공개 entry에서 도달 불가 → 테스트 보조 파일로 분류: ${this.rel(r.resolvedFileName)}`;
        }
      }
      if (role === 'unresolved') this.findings.push({ ruleId: 'import/resolve', level: 'partial', message: `import '${spec}'를 해석할 수 없음`, loc: this.loc(node), evidence });
      if (role === 'test-tool' && KNOWN_TOOLS.has(spec)) this.findings.push({ ruleId: 'tool/unknown', level: 'unsupported', message: `${spec} 인식기가 없음(현재 node:test·node:assert만 지원)`, loc: this.loc(node) });
      out.push({ specifier: spec, kind, role, resolvedFile: resolvedFile && this.rel(resolvedFile), names, loc: this.loc(node), evidence });
      return role;
    };

    for (const st of this.sf.statements) {
      if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier)) continue;
      const spec = st.moduleSpecifier.text;
      const clause = st.importClause;
      const names: string[] = [];
      const bindings: { local: ts.Identifier; imported: string }[] = [];
      if (clause?.name) { names.push('default'); bindings.push({ local: clause.name, imported: 'default' }); }
      const nb = clause?.namedBindings;
      if (nb && ts.isNamespaceImport(nb)) { names.push('*'); bindings.push({ local: nb.name, imported: '*' }); }
      if (nb && ts.isNamedImports(nb)) for (const el of nb.elements) {
        const imported = (el.propertyName ?? el.name).text;
        names.push(el.isTypeOnly ? `type ${imported}` : imported);
        if (!el.isTypeOnly) bindings.push({ local: el.name, imported });
      }
      const typeOnly = clause?.isTypeOnly || (bindings.length === 0 && names.length > 0);
      const role = record(spec, typeOnly ? 'type-only' : 'static', names, st);
      if (typeOnly) continue;
      for (const b of bindings) this.bindImport(spec, role, b.local, b.imported);
    }
    // 동적 import
    const visit = (n: ts.Node) => {
      if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const arg = n.arguments[0];
        if (arg && ts.isStringLiteralLike(arg)) record(arg.text, 'dynamic', [], n);
        else this.findings.push({ ruleId: 'import/dynamic', level: 'unsupported', message: '동적 import 지정자를 정적으로 확정할 수 없음', loc: this.loc(n), evidence: this.text(n) });
      }
      ts.forEachChild(n, visit);
    };
    visit(this.sf);
  }

  bindImport(spec: string, role: ImportInfo['role'], local: ts.Identifier, imported: string) {
    const localSym = this.checker.getSymbolAtLocation(local);
    if (!localSym) return;
    if (NODE_TEST.has(spec)) { this.toolSyms.set(localSym, { mod: 'test', name: imported === 'default' ? 'test' : imported }); return; }
    if (NODE_ASSERT[spec]) { this.toolSyms.set(localSym, { mod: 'assert', module: NODE_ASSERT[spec], name: imported === 'default' || imported === '*' ? '$assert' : imported }); return; }
    if (role === 'test-tool') { this.toolSyms.set(localSym, { mod: 'other', spec }); return; }
    if (role !== 'target-source' && role !== 'public-package') return;
    const orig = localSym.flags & ts.SymbolFlags.Alias ? this.checker.getAliasedSymbol(localSym) : localSym;
    this.localTarget.set(localSym, orig);
    this.targetFor(orig, imported, local, role === 'public-package' ? spec : undefined);
  }

  targetFor(orig: ts.Symbol, importedAs: string, node: ts.Node, publicSpec?: string): TargetRef {
    const existing = this.targetBySymbol.get(orig);
    if (existing) return existing;
    const decl = orig.valueDeclaration ?? orig.declarations?.[0];
    const kind: TargetRef['kind'] = orig.flags & ts.SymbolFlags.Class ? 'class' : orig.flags & ts.SymbolFlags.Function ? 'function' : 'value';
    let publicApi: TargetRef['publicApi'];
    const match = this.publicExports.find((p) => p.symbol === orig);
    if (publicSpec) publicApi = { status: 'mapped', specifier: publicSpec, exportName: importedAs, evidence: `테스트가 공개 지정자 ${publicSpec}로 직접 import` };
    else if (match) publicApi = { status: 'mapped', specifier: match.specifier, exportName: match.exportName, evidence: `checker: ${this.rel(decl?.getSourceFile().fileName ?? '?')}의 ${orig.name} ≡ ${match.specifier}의 export '${match.exportName}' (같은 선언 심볼)` };
    else publicApi = { status: 'unmapped', evidence: `${orig.name}은(는) 공개 entry(${(this.project?.publicEntries ?? []).map((e) => e.specifier).join(', ') || '없음'})의 export와 같은 심볼이 아님` };
    const ref: TargetRef = {
      id: `t${this.targets.length + 1}`,
      kind,
      sourceFile: this.rel(decl?.getSourceFile().fileName ?? ''),
      sourceExport: orig.name,
      importedAs,
      loc: this.loc(node),
      publicApi,
    };
    this.targets.push(ref);
    this.targetBySymbol.set(orig, ref);
    return ref;
  }

  symbolOf(node: ts.Node): ts.Symbol | undefined {
    return this.checker.getSymbolAtLocation(node);
  }

  toolOf(expr: ts.Expression, ctxSyms?: Set<ts.Symbol>): Tool | undefined {
    expr = unwrap(expr);
    if (ts.isIdentifier(expr)) {
      const s = this.symbolOf(expr);
      return s ? this.toolSyms.get(s) : undefined;
    }
    if (ts.isPropertyAccessExpression(expr)) {
      const prop = expr.name.text;
      // t.mock.fn / t.assert.* (TestContext)
      if (ts.isPropertyAccessExpression(expr.expression) && ts.isIdentifier(expr.expression.expression)) {
        const s = this.symbolOf(expr.expression.expression);
        if (s && ctxSyms?.has(s) && expr.expression.name.text === 'mock') return { mod: 'test', name: `mock.${prop}` };
      }
      const base = this.toolOf(expr.expression, ctxSyms);
      if (!base) return undefined;
      if (base.mod === 'assert' && base.name === '$assert') return { mod: 'assert', module: base.module, name: prop === 'strict' ? '$assert' : prop };
      if (base.mod === 'assert' && base.name === 'strict') return { mod: 'assert', module: 'node:assert/strict', name: prop };
      if (base.mod === 'test' && base.name === 'mock') return { mod: 'test', name: `mock.${prop}` };
      if (base.mod === 'test' && (TEST_FNS.has(base.name) || SUITE_FNS.has(base.name))) return { mod: 'test', name: base.name, modifier: prop };
      if (base.mod === 'other') return base;
      return { mod: 'test', name: `${base.name}.${prop}` };
    }
    return undefined;
  }

  // ---- 테스트 구조 ----
  walkSuite(stmts: readonly ts.Statement[], pathNames: string[], hooks: Hook[], suiteFindings: Finding[], skipped: boolean, out: Scenario[]) {
    const localHooks = [...hooks];
    const localFindings = [...suiteFindings];
    for (const st of stmts) {
      if (ts.isImportDeclaration(st) || ts.isTypeAliasDeclaration(st) || ts.isInterfaceDeclaration(st) || ts.isEmptyStatement(st)) continue;
      if (ts.isVariableStatement(st)) {
        const isConst = (st.declarationList.flags & ts.NodeFlags.Const) !== 0;
        for (const d of st.declarationList.declarations) {
          if (!isConst && d.initializer) localFindings.push({ ruleId: 'suite/mutable-init', level: 'partial', message: `describe 수준 let/var 초기값은 테스트 간 공유 상태라 시나리오별로 확정하지 않음: ${this.text(d)}`, loc: this.loc(d) });
        }
        continue; // const는 참조 시점에 정적 평가한다.
      }
      if (ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st)) continue; // 보조 함수: 호출되면 그 시점에 연결 필요로 표시
      if (ts.isExpressionStatement(st) && ts.isCallExpression(st.expression)) {
        const call = st.expression;
        const tool = this.toolOf(call.expression);
        if (tool?.mod === 'test') {
          const fn = lastFn(call);
          if (SUITE_FNS.has(tool.name)) {
            const name = strArg(call) ?? '(이름 없음)';
            const skip = skipped || isSkipModifier(tool.modifier) || hasSkipOption(call);
            if (fn && ts.isBlock(fn.body)) this.walkSuite(fn.body.statements, [...pathNames, name], localHooks, localFindings, skip, out);
            continue;
          }
          if (TEST_FNS.has(tool.name)) {
            out.push(this.scenario(call, tool, pathNames, localHooks, localFindings, skipped, out.length));
            continue;
          }
          if ((tool.name === 'beforeEach' || tool.name === 'afterEach') && fn) { localHooks.push({ kind: tool.name, fn }); continue; }
          if (tool.name === 'before' || tool.name === 'after') {
            localFindings.push({ ruleId: 'hook/once', level: 'unsupported', message: `${tool.name} 훅(테스트 간 공유 준비/정리)은 시나리오별 격리 실행 모델로 옮기지 않음`, loc: this.loc(st) });
            continue;
          }
        }
      }
      const f: Finding = { ruleId: 'suite/statement', level: 'unsupported', message: `테스트 구조에서 해석하지 않은 구문(${ts.SyntaxKind[st.kind]})`, loc: this.loc(st), evidence: this.text(st) };
      // 최상위 구문은 파일 수준 판단, describe 안 구문은 해당 describe의 시나리오에 연결한다.
      if (pathNames.length === 0) this.findings.push(f); else localFindings.push(f);
    }
    if (pathNames.length === 0) this.findings.push(...localFindings.filter((f) => !suiteFindings.includes(f) && f.ruleId !== 'suite/statement'));
  }

  scenario(call: ts.CallExpression, tool: Tool & { mod: 'test' }, pathNames: string[], hooks: Hook[], suiteFindings: Finding[], skipped: boolean, index: number): Scenario {
    const title = strArg(call) ?? '(이름 없음)';
    const sb = new ScenarioBuilder(this, `sc${index + 1}`);
    sb.findings.push(...suiteFindings);
    const fn = lastFn(call);
    if (skipped || isSkipModifier(tool.modifier) || hasSkipOption(call)) {
      sb.findings.push({ ruleId: 'test/skip', level: 'unsupported', message: '원본 테스트가 skip/todo로 표시됨: 실행 모델로 옮기지 않고 미실행으로 남김', loc: this.loc(call) });
    }
    if (!fn) sb.findings.push({ ruleId: 'test/fn', level: 'unsupported', message: '테스트 본문 함수를 찾지 못함', loc: this.loc(call) });
    else {
      for (const h of hooks.filter((h) => h.kind === 'beforeEach')) sb.runFunction(h.fn, 'beforeEach');
      sb.runFunction(fn, 'test');
      for (const h of hooks.filter((h) => h.kind === 'afterEach')) sb.runTeardown(h.fn);
    }
    return sb.finish(title, [...pathNames, title], this.loc(call));
  }

  consumerLink(classSymbol: ts.Symbol | undefined, methods: string[]): ConsumerLink {
    const setup = this.stageConfig?.consumer?.setup;
    if (!setup?.export) return { status: 'unlinked', evidence: 'stage.config.json에 consumer.setup이 없어 실제 컨슈머 초기화 경로를 알 수 없음' };
    if (!classSymbol) return { status: 'unlinked', evidence: '시나리오 대상이 클래스 인스턴스가 아님' };
    const ex = this.publicExports.find((p) => p.exportName === setup.export);
    if (!ex) return { status: 'unlinked', evidence: `consumer.setup.export '${setup.export}'가 공개 entry export에 없음` };
    const decl = ex.symbol.valueDeclaration;
    if (!decl) return { status: 'unlinked', evidence: `'${setup.export}' 선언을 찾지 못함` };
    const t = this.checker.getTypeOfSymbolAtLocation(ex.symbol, decl);
    const sig = t.getCallSignatures()[0];
    if (!sig) return { status: 'unlinked', evidence: `'${setup.export}'는 호출 가능한 함수가 아님` };
    const ret = awaitedReturn(this.checker, sig);
    const retSym = ret.getSymbol();
    if (retSym !== classSymbol) return { status: 'unlinked', evidence: `'${setup.export}'의 반환 타입(${this.checker.typeToString(ret)})이 시나리오 대상 클래스(${classSymbol.name})가 아님` };
    return { status: 'linked', setupExport: setup.export, operations: methods, evidence: `checker: ${setup.export}(...)의 반환 타입이 ${classSymbol.name} → 같은 공개 메서드(${methods.join(', ')})를 컨슈머 초기화 경로로 호출 가능` };
  }
}

class ScenarioBuilder {
  env = new Map<ts.Symbol, Sym>();
  steps: Step[] = [];
  doubles: DoubleSpec[] = [];
  findings: Finding[] = [];
  teardown: Scenario['teardown'] = [];
  usedTargets = new Set<TargetRef>();
  ctxSyms = new Set<ts.Symbol>();
  instanceClass = new Map<string, ts.Symbol>();
  nStep = 0;
  nCheck = 0;
  a: Analyzer;
  id: string;
  constructor(a: Analyzer, id: string) { this.a = a; this.id = id; }

  get checker() { return this.a.checker; }

  find(level: Finding['level'], ruleId: string, message: string, node?: ts.Node) {
    this.findings.push({ ruleId, level, message, loc: node ? this.a.loc(node) : undefined, evidence: node ? this.a.text(node) : undefined });
  }

  runFunction(fn: ts.ArrowFunction | ts.FunctionExpression, phase: string) {
    const p = fn.parameters[0];
    if (p) { const s = this.a.symbolOf(p.name); if (s) this.ctxSyms.add(s); }
    if (!ts.isBlock(fn.body)) { this.evalExpr(fn.body); return; }
    for (const st of fn.body.statements) this.exec(st, phase);
  }

  runTeardown(fn: ts.ArrowFunction | ts.FunctionExpression) {
    const stmts = ts.isBlock(fn.body) ? fn.body.statements : [ts.factory.createExpressionStatement(fn.body)];
    for (const st of stmts) {
      if (ts.isExpressionStatement(st) && ts.isCallExpression(st.expression)) {
        const tool = this.a.toolOf(st.expression.expression, this.ctxSyms);
        if (tool?.mod === 'test' && (tool.name === 'mock.restoreAll' || tool.name === 'mock.reset')) { this.teardown.push({ kind: 'restoreMocks', loc: this.a.loc(st) }); continue; }
      }
      this.find('unsupported', 'hook/teardown', '정리(afterEach) 구문을 해석하지 못함', st);
    }
  }

  exec(st: ts.Statement, phase: string) {
    if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (ts.isIdentifier(d.name)) {
          const s = this.a.symbolOf(d.name);
          const v: Sym = d.initializer ? this.evalExpr(d.initializer, d.name.text) : { t: 'value', value: { $stage: 'undefined' } };
          if (s) this.env.set(s, v);
        } else if (ts.isObjectBindingPattern(d.name) && d.initializer && isDynamicImport(d.initializer)) {
          this.bindDynamicImport(d.name, d.initializer);
        } else this.find('unsupported', 'stmt/destructure', '구조 분해 선언은 동적 import 외에는 지원하지 않음', d);
      }
      return;
    }
    if (ts.isExpressionStatement(st)) {
      const e = unwrap(st.expression);
      if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(e.left)) {
        const s = this.a.symbolOf(e.left);
        const v = this.evalExpr(e.right, e.left.text);
        if (s) this.env.set(s, v);
        return;
      }
      const v = this.evalExpr(e);
      if (v.t === 'unknown') this.find('partial', 'stmt/unknown', `실행 구문을 해석하지 못함: ${v.reason}`, st);
      return;
    }
    if (ts.isEmptyStatement(st)) return;
    this.find('unsupported', 'stmt/kind', `${phase} 본문의 ${ts.SyntaxKind[st.kind]} 구문은 실행 모델로 옮기지 않음(분기·반복·예외 처리 등)`, st);
  }

  bindDynamicImport(pattern: ts.ObjectBindingPattern, init: ts.Expression) {
    for (const el of pattern.elements) {
      if (!ts.isIdentifier(el.name)) continue;
      const local = this.a.symbolOf(el.name);
      const imported = (el.propertyName && ts.isIdentifier(el.propertyName) ? el.propertyName : el.name).text;
      const t = local && this.checker.getTypeOfSymbolAtLocation(local, el);
      const orig = t?.getSymbol();
      if (local && orig && (orig.flags & (ts.SymbolFlags.Class | ts.SymbolFlags.Function))) {
        const ref = this.a.targetFor(orig, imported, init);
        this.env.set(local, { t: 'target', ref, symbol: orig });
      } else this.find('partial', 'import/dynamic-binding', `동적 import 바인딩 '${imported}'의 선언을 해석하지 못함`, el);
    }
  }

  // ---- 표현식 평가 (기호 실행) ----
  evalExpr(e: ts.Expression, nameHint?: string): Sym {
    e = unwrap(e);
    if (ts.isAwaitExpression(e)) {
      const inner = this.evalExpr(e.expression, nameHint);
      if (inner.t === 'promise') {
        const st = this.steps.find((s) => s.id === inner.step);
        if (st && st.kind === 'call') st.awaited = true;
        return { t: 'result', step: inner.step, path: [] };
      }
      return inner;
    }
    if (ts.isCallExpression(e)) return this.evalCall(e, nameHint);
    if (ts.isNewExpression(e)) return this.evalNew(e);
    if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) return { t: 'fn', node: e };
    if (ts.isObjectLiteralExpression(e)) {
      const mockProps = e.properties.filter((p) => ts.isPropertyAssignment(p) && this.isMockFn(p.initializer));
      if (mockProps.length > 0) return this.makeDoubleObject(e, nameHint ?? 'double');
    }
    if (ts.isIdentifier(e)) {
      const s = this.a.symbolOf(e);
      if (s && this.env.has(s)) return this.env.get(s)!;
      const orig = s && this.a.localTarget.get(s);
      if (orig) { const ref = this.a.targetBySymbol.get(orig)!; return { t: 'target', ref, symbol: orig }; }
    }
    if (ts.isPropertyAccessExpression(e)) {
      const base = this.evalExpr(e.expression);
      if (base.t === 'double') return { t: 'double-method', id: base.id, method: e.name.text };
      if (base.t === 'result') return { ...base, path: [...base.path, e.name.text] };
    }
    if (ts.isElementAccessExpression(e)) {
      const base = this.evalExpr(e.expression);
      const k = this.staticValue(e.argumentExpression);
      if (base.t === 'result' && k.ok && (typeof k.value === 'string' || typeof k.value === 'number')) return { ...base, path: [...base.path, k.value] };
    }
    const v = this.staticValue(e);
    return v.ok ? { t: 'value', value: v.value } : { t: 'unknown', reason: v.reason, loc: this.a.loc(e) };
  }

  isMockFn(e: ts.Expression) {
    e = unwrap(e);
    if (!ts.isCallExpression(e)) return false;
    const tool = this.a.toolOf(e.expression, this.ctxSyms);
    return tool?.mod === 'test' && tool.name === 'mock.fn';
  }

  newDoubleId(base: string) {
    let id = base; let n = 2;
    while (this.doubles.some((d) => d.id === id)) id = `${base}${n++}`;
    return id;
  }

  makeDoubleObject(e: ts.ObjectLiteralExpression, varName: string): Sym {
    const id = this.newDoubleId(varName);
    const methods: DoubleSpec['methods'] = {};
    for (const p of e.properties) {
      if (ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) && this.isMockFn(p.initializer)) {
        methods[p.name.text] = { behavior: this.behaviorOf(unwrap(p.initializer) as ts.CallExpression), loc: this.a.loc(p) };
      } else this.find('unsupported', 'double/mixed', '대체 객체에 mock.fn이 아닌 속성이 섞여 있음', p);
    }
    this.doubles.push({ id, varName, shape: 'object', loc: this.a.loc(e), methods });
    return { t: 'double', id };
  }

  behaviorOf(call: ts.CallExpression): Behavior {
    const impl = call.arguments[0] && unwrap(call.arguments[0]);
    if (!impl) return { kind: 'noop' };
    if (!ts.isArrowFunction(impl) && !ts.isFunctionExpression(impl)) {
      this.find('partial', 'double/impl', 'mock.fn 구현이 함수 리터럴이 아니어서 동작을 확정하지 못함', impl);
      return { kind: 'noop' };
    }
    const isAsync = !!impl.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword);
    const valueOf = (x: ts.Expression): Value => {
      const v = this.staticValue(x);
      if (!v.ok) this.find('partial', 'double/value', `대체 객체 응답값을 정적으로 확정하지 못함: ${v.reason}`, x);
      return v.ok ? v.value : { $stage: 'unknown', reason: v.reason };
    };
    if (!ts.isBlock(impl.body)) return isAsync ? { kind: 'resolves', value: valueOf(impl.body) } : { kind: 'returns', value: valueOf(impl.body) };
    const body = impl.body.statements;
    if (body.length === 0) return isAsync ? { kind: 'resolves', value: { $stage: 'undefined' } } : { kind: 'noop' };
    if (body.length === 1 && ts.isReturnStatement(body[0])) {
      const v = body[0].expression ? valueOf(body[0].expression) : { $stage: 'undefined' };
      return isAsync ? { kind: 'resolves', value: v } : { kind: 'returns', value: v };
    }
    if (body.length === 1 && ts.isThrowStatement(body[0])) {
      const v = valueOf(body[0].expression);
      return isAsync ? { kind: 'rejects', value: v } : { kind: 'throws', value: v };
    }
    this.find('unsupported', 'double/impl-body', 'mock.fn 구현 본문이 단일 return/throw가 아님(입력에 따른 분기 등)', impl);
    return { kind: 'noop' };
  }

  evalNew(e: ts.NewExpression): Sym {
    const callee = this.evalExpr(e.expression);
    if (callee.t === 'target' && callee.ref.kind === 'class') {
      this.usedTargets.add(callee.ref);
      const sig = this.checker.getResolvedSignature(e);
      const params = sig ? this.params(sig, e) : [];
      const args = (e.arguments ?? []).map((x, i) => this.argRef(x, params[i]?.name ?? `arg${i}`));
      const id = this.stepId();
      const instance = `i${id.slice(1)}`;
      this.steps.push({ id, kind: 'construct', target: callee.ref.id, instance, args, params, loc: this.a.loc(e), source: this.a.text(e) });
      this.instanceClass.set(instance, callee.symbol);
      this.checkCollaborators(id, sig, args, e);
      return { t: 'instance', id: instance, targetId: callee.ref.id, classSymbol: callee.symbol };
    }
    const v = this.staticValue(e);
    return v.ok ? { t: 'value', value: v.value } : { t: 'unknown', reason: v.reason, loc: this.a.loc(e) };
  }

  stepId() { return `s${++this.nStep}`; }

  params(sig: ts.Signature, node: ts.Node): ParamInfo[] {
    return sig.parameters.map((p) => {
      const decl = p.valueDeclaration as ts.ParameterDeclaration | undefined;
      const t = this.checker.getTypeOfSymbolAtLocation(p, node);
      const optional = !!decl && (!!decl.questionToken || !!decl.initializer);
      const core = optional ? this.checker.getNonNullableType(t) : t;
      return { name: p.name, optional, type: this.checker.typeToString(t), schema: toSchema(this.checker, core, node) };
    });
  }

  /** London 협력 관계: 대체 객체가 매개변수 계약(인터페이스)에 없는 메서드를 정의하면 계약 불일치. */
  checkCollaborators(stepId: string, sig: ts.Signature | undefined, args: ArgRef[], node: ts.Node) {
    if (!sig) return;
    args.forEach((a, i) => {
      if (a.kind !== 'double') return;
      const d = this.doubles.find((x) => x.id === a.id);
      const p = sig.parameters[i];
      if (!d || !p) return;
      const pt = this.checker.getTypeOfSymbolAtLocation(p, node);
      d.collaboratorOf = { step: stepId, param: p.name, type: this.checker.typeToString(pt) };
      if (pt.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return;
      const names = new Set(this.checker.getPropertiesOfType(pt).map((s) => s.name));
      for (const m of Object.keys(d.methods)) {
        if (!names.has(m)) this.find('mismatch', 'contract/double-extra', `대체 객체 '${d.varName}'의 '${m}'은(는) 협력 계약 ${this.checker.typeToString(pt)}에 없음`, node);
      }
      const missing = [...names].filter((n) => !(n in d.methods));
      if (missing.length) this.find('info', 'double/partial', `대체 객체 '${d.varName}'가 계약 메서드 일부만 대체함(미대체: ${missing.join(', ')})`, node);
    });
  }

  argRef(x: ts.Expression, name: string): ArgRef {
    const v = this.evalExpr(x, name);
    if (v.t === 'double') return { kind: 'double', id: v.id };
    if (v.t === 'double-method') return { kind: 'doubleMethod', id: v.id, method: v.method };
    if (v.t === 'value') return { kind: 'value', value: v.value };
    const reason = v.t === 'unknown' ? v.reason : `인자 종류(${v.t})를 실행 모델 값으로 옮길 수 없음`;
    this.find('partial', 'arg/unknown', `인자 '${name}'을(를) 정적으로 확정하지 못함 — 연결 필요: ${reason}`, x);
    return { kind: 'value', value: { $stage: 'unknown', reason } };
  }

  evalCall(e: ts.CallExpression, nameHint?: string): Sym {
    const tool = this.a.toolOf(e.expression, this.ctxSyms);
    if (tool?.mod === 'assert') { this.assertion(e, tool); return { t: 'void' }; }
    if (tool?.mod === 'test') {
      if (tool.name === 'mock.fn') {
        const id = this.newDoubleId(nameHint ?? 'fn');
        this.doubles.push({ id, varName: nameHint ?? id, shape: 'function', loc: this.a.loc(e), methods: { '()': { behavior: this.behaviorOf(e), loc: this.a.loc(e) } } });
        return { t: 'double', id };
      }
      this.find('unsupported', 'tool/api', `node:test API '${tool.name}'은(는) 인식 규칙이 없음`, e);
      return { t: 'void' };
    }
    if (tool?.mod === 'other') { this.find('unsupported', 'tool/unknown', `${tool.spec} 호출은 인식 규칙이 없음`, e); return { t: 'void' }; }
    if (isDynamicImport(e)) return { t: 'unknown', reason: '동적 import는 구조 분해 선언으로만 지원', loc: this.a.loc(e) };

    const callee = unwrap(e.expression);
    if (ts.isPropertyAccessExpression(callee)) {
      const base = this.evalExpr(callee.expression);
      if (base.t === 'instance') return this.methodCall(e, base, callee.name.text);
      if (base.t === 'double' || base.t === 'double-method') return { t: 'unknown', reason: '테스트가 대체 객체를 직접 호출/조회함(검증 구문 밖)', loc: this.a.loc(e) };
    }
    const target = this.evalExpr(callee);
    if (target.t === 'target' && target.ref.kind === 'function') {
      this.usedTargets.add(target.ref);
      const sig = this.checker.getResolvedSignature(e);
      const params = sig ? this.params(sig, e) : [];
      const args = e.arguments.map((x, i) => this.argRef(x, params[i]?.name ?? `arg${i}`));
      const id = this.stepId();
      const ret = sig ? awaitedReturn(this.checker, sig) : undefined;
      this.steps.push({ id, kind: 'call', target: target.ref.id, args, params, returns: ret ? toSchema(this.checker, ret, e) : { kind: 'unknown' }, returnsText: ret ? this.checker.typeToString(ret) : '?', awaited: false, loc: this.a.loc(e), source: this.a.text(e) });
      this.checkCollaborators(id, sig, args, e);
      return this.callResult(id, sig);
    }
    return { t: 'unknown', reason: `호출 대상(${this.a.text(callee)})이 검증 대상 공개 API·인스턴스가 아님(보조 함수 결과는 정적으로 알 수 없음)`, loc: this.a.loc(e) };
  }

  callResult(id: string, sig: ts.Signature | undefined): Sym {
    const r = sig?.getReturnType();
    const isPromise = r && this.checker.getAwaitedType(r) !== r;
    return isPromise ? { t: 'promise', step: id } : { t: 'result', step: id, path: [] };
  }

  methodCall(e: ts.CallExpression, inst: Sym & { t: 'instance' }, method: string): Sym {
    const classType = this.checker.getDeclaredTypeOfSymbol(inst.classSymbol);
    const prop = this.checker.getPropertyOfType(classType, method);
    if (!prop) this.find('mismatch', 'contract/method-missing', `테스트가 호출한 '${method}'이(가) 대상 ${inst.classSymbol.name}의 공개 계약에 없음`, e);
    const sig = prop ? this.checker.getResolvedSignature(e) : undefined;
    const params = sig ? this.params(sig, e) : [];
    const args = e.arguments.map((x, i) => this.argRef(x, params[i]?.name ?? `arg${i}`));
    const id = this.stepId();
    const ret = sig ? awaitedReturn(this.checker, sig) : undefined;
    this.steps.push({
      id, kind: 'call', instance: inst.id, method, args, params,
      returns: ret ? toSchema(this.checker, ret, e) : { kind: 'unknown' }, returnsText: ret ? this.checker.typeToString(ret) : '?',
      awaited: false, loc: this.a.loc(e), source: this.a.text(e),
    });
    this.checkCollaborators(id, sig, args, e);
    return this.callResult(id, sig);
  }

  // ---- assertion ----
  assertion(e: ts.CallExpression, tool: Tool & { mod: 'assert' }) {
    const op = tool.name === '$assert' ? 'ok' : tool.name;
    const loc = this.a.loc(e);
    const source = this.a.text(e);
    const id = `c${++this.nCheck}`;
    const push = (check: Check) => this.steps.push({ id: this.stepId(), kind: 'check', check });
    const unsupported = (reason: string) => {
      this.find('unsupported', 'assert/unsupported', reason, e);
      push({ id, kind: 'unsupported', loc, source, reason });
    };
    if (COMPARE_OPS.has(op)) {
      const subject = this.subject(e.arguments[0]);
      if (!subject.ok) return unsupported(`검증 대상 값(${this.a.text(e.arguments[0])})을 관찰 항목으로 해석하지 못함: ${subject.reason}`);
      let expected: Value | undefined;
      if (op !== 'ok') {
        const ex = this.staticValue(e.arguments[1]);
        if (!ex.ok) { this.find('partial', 'assert/expected', `기대값을 정적으로 확정하지 못함 — 연결 필요: ${ex.reason}`, e.arguments[1]); expected = { $stage: 'unknown', reason: ex.reason }; }
        else expected = ex.value;
      }
      push({ id, kind: 'compare', module: tool.module, op, subject: subject.value, expected, loc, source });
      return;
    }
    if (op === 'rejects' || op === 'throws') {
      const arg = e.arguments[0];
      let s = arg ? this.evalExpr(arg) : undefined;
      if (s?.t === 'fn') s = ts.isBlock(s.node.body) ? undefined : this.evalExpr(s.node.body);
      const stepId = s?.t === 'promise' ? s.step : s?.t === 'result' && s.path.length === 0 ? s.step : undefined;
      if (!stepId) return unsupported(`${op}의 첫 인자가 대상 호출로 해석되지 않음`);
      const m = e.arguments[1] ? this.matcher(e.arguments[1]) : { ok: true as const, value: undefined };
      if (!m.ok) return unsupported(`오류 판정 조건을 해석하지 못함: ${m.reason}`);
      push({ id, kind: 'error', module: tool.module, op, step: stepId, matcher: m.value, loc, source });
      return;
    }
    unsupported(`assert.${op}은(는) 인식 규칙이 없음`);
  }

  matcher(x: ts.Expression): { ok: true; value: ErrorMatcher | undefined } | { ok: false; reason: string } {
    x = unwrap(x);
    if (ts.isRegularExpressionLiteral(x)) { const v = this.staticValue(x); return v.ok ? { ok: true, value: { kind: 'regexp', value: v.value } } : v; }
    if (ts.isObjectLiteralExpression(x)) { const v = this.staticValue(x); return v.ok ? { ok: true, value: { kind: 'object', value: v.value } } : v; }
    if (ts.isIdentifier(x)) {
      const s = this.evalExpr(x);
      if (s.t === 'target' && s.ref.kind === 'class') { this.usedTargets.add(s.ref); return { ok: true, value: { kind: 'ctor', target: s.ref.id } }; }
      if (BUILTIN_ERRORS.has(x.text) && this.isGlobal(x)) return { ok: true, value: { kind: 'builtin', name: x.text } };
    }
    return { ok: false, reason: `지원하지 않는 판정 형태: ${this.a.text(x)}` };
  }

  subject(x: ts.Expression | undefined): { ok: true; value: Subject } | { ok: false; reason: string } {
    if (!x) return { ok: false, reason: '인자 없음' };
    x = unwrap(x);
    // X.mock.callCount()
    if (ts.isCallExpression(x) && ts.isPropertyAccessExpression(x.expression) && x.expression.name.text === 'callCount') {
      const d = this.mockOwner(x.expression.expression);
      if (d) return { ok: true, value: { kind: 'callCount', double: d.id, method: d.method } };
    }
    // X.mock.calls.length / X.mock.calls[i].arguments / X.mock.calls[i].arguments[j]
    const chain = accessChain(x);
    if (chain) {
      const { base, keys } = chain;
      const d = ts.isPropertyAccessExpression(base) && base.name.text === 'mock' ? this.mockOwner(base) : undefined;
      if (d) {
        if (keys.length === 2 && keys[0] === 'calls' && keys[1] === 'length') return { ok: true, value: { kind: 'callCount', double: d.id, method: d.method } };
        if (keys.length >= 3 && keys[0] === 'calls' && typeof keys[1] === 'number' && keys[2] === 'arguments') {
          if (keys.length === 3) return { ok: true, value: { kind: 'callArgs', double: d.id, method: d.method, call: keys[1] } };
          if (keys.length === 4 && typeof keys[3] === 'number') return { ok: true, value: { kind: 'callArg', double: d.id, method: d.method, call: keys[1], arg: keys[3] } };
        }
        return { ok: false, reason: `mock 관찰 경로 ${keys.join('.')}는 인식 규칙이 없음` };
      }
    }
    const s = this.evalExpr(x);
    if (s.t === 'result') return { ok: true, value: { kind: 'result', step: s.step, path: s.path } };
    if (s.t === 'promise') return { ok: false, reason: 'await 하지 않은 Promise를 비교함' };
    return { ok: false, reason: s.t === 'unknown' ? s.reason : `관찰 가능한 실행 결과가 아님(${s.t})` };
  }

  /** `X.mock` 표현식의 X가 대체 객체 메서드 또는 대체 함수인지 확인 */
  mockOwner(mockExpr: ts.Expression): { id: string; method: string } | undefined {
    mockExpr = unwrap(mockExpr);
    if (!ts.isPropertyAccessExpression(mockExpr) || mockExpr.name.text !== 'mock') return undefined;
    const owner = this.evalExpr(mockExpr.expression);
    if (owner.t === 'double-method') return { id: owner.id, method: owner.method };
    if (owner.t === 'double') return this.doubles.find((d) => d.id === owner.id)?.shape === 'function' ? { id: owner.id, method: '()' } : undefined;
    return undefined;
  }

  isGlobal(id: ts.Identifier) {
    const s = this.a.symbolOf(id);
    const decl = s?.declarations?.[0];
    return !s || !decl || decl.getSourceFile().hasNoDefaultLib || decl.getSourceFile().fileName.includes('/typescript/lib/');
  }

  // ---- 정적 값 평가 ----
  staticValue(x: ts.Expression | undefined, depth = 0): { ok: true; value: Value } | { ok: false; reason: string } {
    if (!x) return { ok: true, value: { $stage: 'undefined' } };
    if (depth > 20) return { ok: false, reason: '평가 깊이 초과' };
    x = unwrap(x);
    if (ts.isStringLiteral(x) || ts.isNoSubstitutionTemplateLiteral(x)) return { ok: true, value: x.text };
    if (ts.isNumericLiteral(x)) return { ok: true, value: Number(x.text) };
    if (x.kind === ts.SyntaxKind.TrueKeyword) return { ok: true, value: true };
    if (x.kind === ts.SyntaxKind.FalseKeyword) return { ok: true, value: false };
    if (x.kind === ts.SyntaxKind.NullKeyword) return { ok: true, value: null };
    if (ts.isRegularExpressionLiteral(x)) {
      const i = x.text.lastIndexOf('/');
      return { ok: true, value: { $stage: 'regexp', source: x.text.slice(1, i), flags: x.text.slice(i + 1) } };
    }
    if (ts.isPrefixUnaryExpression(x) && x.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(x.operand)) return { ok: true, value: -Number(x.operand.text) };
    if (ts.isTemplateExpression(x)) {
      let s = x.head.text;
      for (const span of x.templateSpans) {
        const v = this.staticValue(span.expression, depth + 1);
        if (!v.ok) return v;
        if (typeof v.value === 'object' && v.value !== null) return { ok: false, reason: '템플릿 안 객체 값' };
        s += String(v.value) + span.literal.text;
      }
      return { ok: true, value: s };
    }
    if (ts.isArrayLiteralExpression(x)) {
      const out: Value[] = [];
      for (const el of x.elements) {
        if (ts.isSpreadElement(el)) return { ok: false, reason: '배열 spread' };
        const v = this.staticValue(el, depth + 1);
        if (!v.ok) return v;
        out.push(v.value);
      }
      return { ok: true, value: out };
    }
    if (ts.isObjectLiteralExpression(x)) {
      const out: Record<string, Value> = {};
      for (const p of x.properties) {
        if (ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name) || ts.isNumericLiteral(p.name))) {
          const v = this.staticValue(p.initializer, depth + 1);
          if (!v.ok) return v;
          out[p.name.text] = v.value;
        } else if (ts.isShorthandPropertyAssignment(p)) {
          const v = this.staticValue(p.name, depth + 1);
          if (!v.ok) return v;
          out[p.name.text] = v.value;
        } else return { ok: false, reason: `객체 속성 형태(${ts.SyntaxKind[p.kind]}) 미지원` };
      }
      return { ok: true, value: out };
    }
    if (ts.isIdentifier(x)) {
      if (x.text === 'undefined' && this.isGlobal(x)) return { ok: true, value: { $stage: 'undefined' } };
      let s = this.a.symbolOf(x);
      if (s && this.env.has(s)) {
        const v = this.env.get(s)!;
        if (v.t === 'value') return { ok: true, value: v.value };
        return { ok: false, reason: `'${x.text}'은(는) 정적 값이 아님(${v.t})` };
      }
      if (s && s.flags & ts.SymbolFlags.Alias) s = this.checker.getAliasedSymbol(s);
      const decl = s?.valueDeclaration;
      if (decl && ts.isVariableDeclaration(decl) && decl.initializer && ts.isVariableDeclarationList(decl.parent) && decl.parent.flags & ts.NodeFlags.Const) {
        return this.staticValue(decl.initializer, depth + 1);
      }
      return { ok: false, reason: `'${x.text}'의 값을 정적으로 알 수 없음` };
    }
    if (ts.isNewExpression(x) && ts.isIdentifier(x.expression)) {
      const args: Value[] = [];
      for (const a of x.arguments ?? []) { const v = this.staticValue(a, depth + 1); if (!v.ok) return v; args.push(v.value); }
      const s = this.evalExpr(x.expression);
      if (s.t === 'target' && s.ref.kind === 'class') {
        this.usedTargets.add(s.ref);
        if (s.ref.publicApi.status !== 'mapped') return { ok: false, reason: `${s.ref.sourceExport}의 공개 export 대응 없음` };
        return { ok: true, value: { $stage: 'construct', export: s.ref.publicApi.exportName, sourceExport: s.ref.sourceExport, args } };
      }
      if (BUILTIN_ERRORS.has(x.expression.text) && this.isGlobal(x.expression)) {
        return { ok: true, value: { $stage: 'error', name: x.expression.text, message: typeof args[0] === 'string' ? args[0] : '' } };
      }
    }
    return { ok: false, reason: `정적 평가 규칙 없음(${ts.SyntaxKind[x.kind]}: ${this.a.text(x)})` };
  }

  finish(title: string, pathNames: string[], loc: Loc): Scenario {
    const targets = [...this.usedTargets];
    for (const t of targets) if (t.publicApi.status !== 'mapped') this.findings.push({ ruleId: 'public/map', level: 'partial', message: `대상 ${t.sourceExport}의 공개 API 대응을 찾지 못함 — 배포 후보에서 실행할 수 없음: ${t.publicApi.evidence}`, loc: t.loc });
    const actions = this.steps.filter((s) => s.kind === 'call' || s.kind === 'construct');
    const hasCtor = this.steps.some((s) => s.kind === 'construct');
    const runKind: Scenario['runKind'] = actions.length === 0 ? 'none' : hasCtor ? 'stateful-object' : 'function';
    if (runKind === 'none') this.findings.push({ ruleId: 'target/none', level: 'no-target', message: '검증 대상 공개 API 호출이 없음(테스트가 대상 소스의 함수·클래스를 실행하지 않음)', loc });
    if (!this.steps.some((s) => s.kind === 'check')) this.findings.push({ ruleId: 'assert/none', level: 'partial', message: '인식한 assertion이 없음 — 통과 기준을 확정할 수 없음', loc });
    const ctorStep = this.steps.find((s) => s.kind === 'construct');
    const classSym = ctorStep && ctorStep.kind === 'construct' ? this.instanceClass.get(ctorStep.instance) : undefined;
    const methods = [...new Set(this.steps.flatMap((s) => (s.kind === 'call' && s.method ? [s.method] : [])))];
    // 실행할 대상이 없으면 다른 판정보다 '실행 가능한 대상 없음'이 우선한다(근거 Finding은 모두 남긴다).
    const status = runKind === 'none' ? 'no-target' : aggregate([], this.findings);
    return {
      id: this.id,
      title,
      path: pathNames,
      loc,
      runKind,
      targets,
      doubles: this.doubles,
      steps: this.steps,
      teardown: this.teardown,
      support: { status, findings: this.findings },
      consumerLink: runKind === 'stateful-object' ? this.a.consumerLink(classSym, methods) : undefined,
    };
  }
}

function aggregate(statuses: SupportStatus[], findings: Finding[]): SupportStatus {
  const levels = new Set(findings.map((f) => f.level));
  const all = new Set<SupportStatus>(statuses);
  if (levels.has('mismatch') || all.has('contract-mismatch')) return 'contract-mismatch';
  if (levels.has('unsupported') || all.has('unsupported')) return 'unsupported';
  if (levels.has('no-target') && (statuses.length === 0 || statuses.every((s) => s === 'no-target'))) return 'no-target';
  if (levels.has('partial') || all.has('partial')) return 'partial';
  if (statuses.length > 0 && statuses.every((s) => s === 'no-target')) return 'no-target';
  return 'auto';
}

function unwrap(e: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e) || ts.isSatisfiesExpression(e) || ts.isTypeAssertionExpression(e)) e = e.expression;
  return e;
}

function isDynamicImport(e: ts.Expression): boolean {
  e = unwrap(e);
  if (ts.isAwaitExpression(e)) e = unwrap(e.expression);
  return ts.isCallExpression(e) && e.expression.kind === ts.SyntaxKind.ImportKeyword;
}

function lastFn(call: ts.CallExpression): ts.ArrowFunction | ts.FunctionExpression | undefined {
  for (let i = call.arguments.length - 1; i >= 0; i--) {
    const a = unwrap(call.arguments[i]);
    if (ts.isArrowFunction(a) || ts.isFunctionExpression(a)) return a;
  }
  return undefined;
}

function strArg(call: ts.CallExpression): string | undefined {
  const a = call.arguments[0];
  return a && ts.isStringLiteralLike(a) ? a.text : undefined;
}

function isSkipModifier(m?: string) { return m === 'skip' || m === 'todo'; }

function hasSkipOption(call: ts.CallExpression): boolean {
  return call.arguments.some((a) => ts.isObjectLiteralExpression(a) && a.properties.some((p) =>
    ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && (p.name.text === 'skip' || p.name.text === 'todo') && p.initializer.kind !== ts.SyntaxKind.FalseKeyword));
}

/** a.b[0].c 형태를 (base, [b,0,c])로 분해. base는 `.mock`로 끝나는 지점까지. */
function accessChain(x: ts.Expression): { base: ts.Expression; keys: (string | number)[] } | undefined {
  const keys: (string | number)[] = [];
  let cur = unwrap(x);
  for (;;) {
    if (ts.isPropertyAccessExpression(cur)) {
      if (cur.name.text === 'mock') return { base: cur, keys };
      keys.unshift(cur.name.text); cur = unwrap(cur.expression); continue;
    }
    if (ts.isElementAccessExpression(cur) && ts.isNumericLiteral(cur.argumentExpression)) {
      keys.unshift(Number(cur.argumentExpression.text)); cur = unwrap(cur.expression); continue;
    }
    return undefined;
  }
}
