import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { createHash } from 'node:crypto';
import { build } from 'esbuild';
import { extractScenarios, type LiveConsole } from './real-env.ts';
import { executeConnectedScenario } from './scenario-runtime.js';
import { runProc } from './candidate.ts';
import { scenarioPresentation } from './scenario-presentation.ts';
import { adaptScenario, responseEnvelope, type ScenarioNetwork } from './scenario-adapters.ts';
import { collaboratorChoices, initConnectedConsole } from './connected-console.js';
import { moduleContracts, type FactoryContract } from './module-contracts.ts';
import { testApi } from './test-api.ts';

export interface ConnectedScenario {
  id: string;
  name: string;
  line: number;
  original: string;
  code: string;
  connections: string[];
  values: Record<string, unknown>;
  connectionKinds: Record<string, 'object' | 'function' | 'value'>;
  presentation: ReturnType<typeof scenarioPresentation>;
  connectionRoles: Record<string, string>;
  adaptations: string[];
  network?: ScenarioNetwork;
  factories: (FactoryContract & { name: string; expression: string; legacyExpression: string })[];
}

export function connectedScenarios(testFile: string, fromDir: string, moduleRoot = fromDir) {
  const source = fs.readFileSync(testFile, 'utf8');
  const sf = ts.createSourceFile(testFile, source, ts.ScriptTarget.Latest, true);
  const api = testApi(sf);
  const extracted = extractScenarios(testFile, fromDir);
  const symbols = extracted.symbols.map((s) => {
    const [exportName, alias] = s.name.split(' as ');
    return { name: alias || exportName, exportName, module: extracted.modules.indexOf(s.moduleRel) };
  });
  const helpers = new Map<string, ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression>();
  for (const statement of sf.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) helpers.set(statement.name.text, statement);
    if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.initializer && (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer))) helpers.set(declaration.name.text, declaration.initializer);
    }
  }
  const contractCache = new Map<string, Map<string, FactoryContract>>();
  const contracts = extracted.modules.map(module => moduleContracts(path.join(moduleRoot, module), contractCache));
  const hooks = new Set(symbols.filter(symbol => contracts[symbol.module]?.get(symbol.exportName)?.hook).map(symbol => symbol.name));
  const factories = contracts.flatMap((module, index) => [...module].filter(([, contract]) => !contract.hook && ((contract.schema && (contract.callableWithoutArguments || contract.fields)) || (contract.methods.length && contract.callableWithoutArguments))).map(([name, contract]) => ({ ...contract, name, expression: `modules[${index}][${JSON.stringify(name)}]`, legacyExpression: `m.${name}` })));
  const constants = sf.statements.filter(ts.isVariableStatement).flatMap((s) => s.declarationList.declarations).filter((d) => ts.isIdentifier(d.name) && d.initializer && (ts.isStringLiteralLike(d.initializer) || ts.isNumericLiteral(d.initializer) || [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword].includes(d.initializer.kind)));
  const scenarios: ConnectedScenario[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && api.tests.has(node.expression.getText(sf)) && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) {
      const fn = node.arguments[node.arguments.length - 1];
      if ((!ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn)) || !ts.isBlock(fn.body)) return;
      const body = fn.body;
      const adapted = adaptScenario(body, sf, constants, helpers, hooks);
      if (adapted.network?.kind === 'http') for (const module of extracted.modules) {
        const file = path.join(moduleRoot, module);
        if (!fs.existsSync(file)) continue;
        const envelope = responseEnvelope(fs.readFileSync(file, 'utf8'), file);
        if (envelope) {
          adapted.network.envelope = envelope.path;
          adapted.notes.push(`프로젝트 ${module}:${envelope.line}의 실제 응답 파싱 경로(${envelope.path.join('.')})에 맞춰 로컬 검증 서버의 JSON을 구성합니다.`);
        }
      }
      const edits = adapted.edits;
      const values: Record<string, unknown> = {};
      const bindings = constants.map((d) => {
        const key = d.name.getText(sf);
        if (key === adapted.network?.valueKey) {
          values[key] = ''; return `const ${key} = values[${JSON.stringify(key)}];`;
        }
        return `const ${d.getText(sf)};`;
      });
      const assertionAliases = [...api.assertions].filter(name => name !== 'assert').map(name => `const ${name} = assert;`);
      const original = source.slice(body.getStart(sf) + 1, body.end - 1).trim();
      let code = source.slice(body.getStart(sf) + 1, body.end - 1);
      const offset = body.getStart(sf) + 1;
      for (const edit of edits.sort((a, b) => b.start - a.start)) code = code.slice(0, edit.start - offset) + edit.text + code.slice(edit.end - offset);
      code = code.replace(/\.mock\.(calls|callCount)\b/g, '.observed.$1');
      scenarios.push({ id: String(scenarios.length), name: node.arguments[0].text, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, original, code: [...assertionAliases, ...bindings, code.trim()].join('\n'), connections: Object.keys(adapted.roles), values, connectionKinds: adapted.kinds, connectionRoles: adapted.roles, adaptations: adapted.notes, network: adapted.network, factories, presentation: scenarioPresentation(body, sf, constants, adapted.network?.valueKey, adapted.roles) });
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { scenarios, symbols, sourceHash: createHash('sha256').update(source).digest('hex'), presentationVersion: 7 };
}

export async function runConnectedNode(opts: { dir: string; console: LiveConsole; scenario: ReturnType<typeof connectedScenarios>; input: unknown; signal: AbortSignal }) {
  const work = fs.mkdtempSync(path.join(opts.dir, 'connected-'));
  const output = path.join(work, 'result.json');
  const imports = opts.console.modules.map((m, i) => `import * as m${i} from ${JSON.stringify(path.join(opts.console.packageDir, m))};`).join('\n');
  const script = path.join(work, 'run.cjs');
  await build({ stdin: { contents: `${imports}\nimport fs from 'node:fs';\nconst execute = ${executeConnectedScenario.toString()};\nexecute(${JSON.stringify(opts.input)}, [${opts.console.modules.map((_, i) => `m${i}`).join(',')}], ${JSON.stringify(opts.scenario.symbols)}).then(result => fs.writeFileSync(${JSON.stringify(output)}, JSON.stringify(result)));`, resolveDir: opts.console.packageDir }, bundle: true, outfile: script, platform: 'node', format: 'cjs', logLevel: 'silent', nodePaths: [path.join(opts.console.projectRoot, 'node_modules')] });
  const result = await runProc(process.execPath, [script], { cwd: work, signal: opts.signal, timeoutMs: 60_000 });
  if (result.code !== 0 || !fs.existsSync(output)) throw new Error(`실제 Node 실행 실패: ${(result.stderr || result.stdout).slice(-2000)}`);
  return JSON.parse(fs.readFileSync(output, 'utf8'));
}

const esc = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function connectedConsoleHtml(opts: { runId: string; jobId: string; definition: ReturnType<typeof connectedScenarios>; saved?: Record<string, { input: unknown; result: unknown }> }) {
  const data = JSON.stringify(opts).replace(/</g, '\\u003c');
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>실제 협력자 시나리오 검증</title>
<style>
[hidden]{display:none!important}
body{font:14px/1.5 system-ui,sans-serif;color:#202333;max-width:840px;margin:16px auto;padding:0 16px}
label{display:block;font-weight:600;margin:12px 0}select,input,textarea{box-sizing:border-box;width:100%;margin-top:6px;padding:9px;border:1px solid #cbd0dc;border-radius:6px;font:inherit;background:white;color:inherit}
textarea{font:12px/1.5 ui-monospace,monospace}dl{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px}dl>div{border:1px solid #e1e4ec;border-radius:8px;padding:10px}dt{font-size:12px;color:#636b7b}dd{margin:4px 0 0;white-space:pre-wrap;overflow-wrap:anywhere;font-family:ui-monospace,monospace}
pre{white-space:pre-wrap;overflow:auto;background:#f5f6f9;padding:12px;font:12px/1.5 ui-monospace,monospace}details{margin:18px 0;color:#636b7b}summary{cursor:pointer}button{padding:10px 20px;background:#3549dd;color:white;border:0;border-radius:6px;font:600 14px system-ui;cursor:pointer}button:disabled{background:#c3c8d9;cursor:default}.hint{color:#636b7b;font-size:13px}#status{display:inline-block;margin-left:12px;font-weight:600}#status[data-status=passed]{color:#087549}#status[data-status=failed]{color:#b63037}
</style>
<label>테스트 시나리오<select id="scenario">${opts.definition.scenarios.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select></label>
<dl id="facts"></dl>
<div id="adaptations"></div>
<p id="next" class="hint"></p>
<div id="connections"></div><div id="network"></div><div id="values"></div>
<button id="run" type="button" disabled>검증 실행</button><span id="status" role="status"></span>
<div id="result" aria-live="polite"></div>
<details><summary>실행 상세</summary><pre id="out">실행 대기</pre></details>
<details><summary>원본 테스트 확인</summary><pre id="original"></pre></details>
<details id="advanced"><summary>개발자 설정</summary>
<p class="hint">기본 화면에서 선택한 실제 연결을 표시합니다. 직접 연결이나 실행 코드 수정이 필요할 때 사용하세요.</p>
<div id="expressions"></div>
<label>실행 위치<select id="environment"><option value="browser">실제 브라우저</option><option value="node">실제 Node (window 없음)</option></select></label>
<label>실행 전 세션 저장소 (JSON)<input id="seed" value="{}"></label>
<label>실행 코드·기대 결과 검증<textarea id="code" rows="14" spellcheck="false"></textarea></label>
</details>
<script>window.process = window.process || { env: { NODE_ENV: 'production' } };</script>
<script src="/api/runs/${encodeURIComponent(opts.runId)}/live-console.js"></script>
<script>
const options = ${data};
(${initConnectedConsole.toString()})(options, ${executeConnectedScenario.toString()}, ${collaboratorChoices.toString()});
</script>`;
}
