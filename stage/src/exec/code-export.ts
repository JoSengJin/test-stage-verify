import path from 'node:path';
import fs from 'node:fs';
import ts from 'typescript';
import { build, transform } from 'esbuild';
import { RUNNER, type RealEnvResult } from './real-env.ts';
import { executeConnectedScenario } from './scenario-runtime.js';
import { createHookRenderer } from './render-hook.js';

/** 실제 후보 코드와 편집한 호출을 React 프로젝트에서 재사용할 수 있게 묶는다. */
export async function exportStage3Component(opts: {
  projectRoot: string;
  live?: RealEnvResult['live'];
  drafts?: { console?: string; scenarios?: Record<string, { args: string; seed: string }> };
  playground?: { code: string; sessionId: string }[];
  connected?: { definition: { scenarios: { id: string; name: string; network?: { valueKey: string } }[]; symbols: unknown[] }; results: Record<string, { input: unknown }> };
}): Promise<{ source: string; extension: 'tsx' | 'jsx' }> {
  const pkg = JSON.parse(fs.readFileSync(path.join(opts.projectRoot, 'package.json'), 'utf8'));
  const deps = { ...pkg.dependencies, ...pkg.devDependencies, ...pkg.peerDependencies };
  if (!deps.react) throw new Error('프로젝트 package.json에서 React 사용을 확인하지 못했습니다.');
  const typescript = fs.existsSync(path.join(opts.projectRoot, 'tsconfig.json')) || !!deps.typescript;
  const annotation = (type: string) => typescript ? ': ' + type : '';
  const extension = typescript ? 'tsx' : 'jsx';
  const consoleInfo = opts.live?.console;
  const imports = (consoleInfo?.modules ?? []).map((module, i) => `import * as m${i} from ${JSON.stringify(path.join(consoleInfo!.packageDir, module))};`);
  const screens = (opts.playground ?? []).map((screen) => {
    const ast = ts.createSourceFile('screen.jsx', screen.code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JSX);
    const imports = ast.statements.filter(ts.isImportDeclaration).map((node) => node.getText(ast));
    let body = ast.statements.filter((node) => !ts.isImportDeclaration(node)).map((node) => node.getText(ast)).join('\n');
    if (!body.includes("createRoot(document.getElementById('root')).render(<Screen />)")) throw new Error('가상 화면의 Screen 컴포넌트 진입점을 찾지 못했습니다.');
    body = body.replace("createRoot(document.getElementById('root')).render(<Screen />);", 'return <Screen />;')
      .replace('window.__STAGE_ORIGIN__ || location.origin', 'baseUrl || location.origin')
      .replace(`'x-stage-session': ${JSON.stringify(screen.sessionId)}`, '...headers');
    return `${imports.join('\n')}\nexport default function SavedScreen({ baseUrl, headers = {} }) {\n${body}\n}`;
  });
  const screenImports = screens.map((_, i) => `import Screen${i} from 'stage-screen:${i}';`);
  const moduleList = (consoleInfo?.modules ?? []).map((_, i) => `m${i}`).join(', ');
  const bundled = await build({
    stdin: { contents: `${imports.join('\n')}\n${screenImports.join('\n')}\nexport const __stageModules = { ${(consoleInfo?.modules ?? []).map((_, i) => `${i}: m${i}`).join(', ')} };\nexport const m = Object.assign({}, ${moduleList || '{}'});\nexport const savedScreens = [${screens.map((_, i) => `Screen${i}`).join(', ')}];`, resolveDir: opts.projectRoot, loader: 'jsx' },
    bundle: true, write: false, format: 'cjs', platform: 'browser', target: 'es2020', logLevel: 'silent',
    nodePaths: [path.join(opts.projectRoot, 'node_modules')],
    external: ['react', 'react/*', 'react-dom', 'react-dom/*'],
    define: { 'process.env.NODE_ENV': '"production"' },
    banner: { js: 'const process = { env: { NODE_ENV: "production" } };' },
    plugins: [{ name: 'saved-screens', setup(builder) {
      builder.onResolve({ filter: /^stage-screen:/ }, (args) => ({ path: args.path.slice('stage-screen:'.length), namespace: 'saved-screen' }));
      builder.onLoad({ filter: /.*/, namespace: 'saved-screen' }, (args) => ({ contents: screens[Number(args.path)], loader: 'jsx', resolveDir: opts.projectRoot }));
    } }],
  });
  const scenarios = Object.entries(opts.live?.scenarios ?? {}).map(([id, sc]) => {
    const draft = opts.drafts?.scenarios?.[id];
    return { ...sc, id, args: draft ? [draft.args] : sc.args, seed: draft?.seed?.trim() ? JSON.parse(draft.seed) : {} };
  });
  const code = opts.drafts?.console ?? 'return Object.keys(m);';
  const source = `${deps.next ? "'use client';\n" : ''}// React와 react-dom이 설치된 프로젝트에서 import해 사용하세요.
// 후보 코드가 포함되어 있습니다. 외부 API에는 서버 접근 및 CORS 허용이 필요합니다.
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import * as ReactDOM from 'react-dom';
import * as JSXRuntime from 'react/jsx-runtime';
import * as JSXDevRuntime from 'react/jsx-dev-runtime';
const candidate = new Function('require', ${JSON.stringify('const module = { exports: {} }; const exports = module.exports;\n' + bundled.outputFiles[0].text + '\nreturn module.exports;')})((name${annotation('string')}) => {
  if (name === 'react') return React;
  if (name === 'react-dom/client') return { createRoot };
  if (name === 'react-dom') return ReactDOM;
  if (name === 'react/jsx-runtime') return JSXRuntime;
  if (name === 'react/jsx-dev-runtime') return JSXDevRuntime;
  throw new Error('지원하지 않는 런타임 의존성 ' + name);
});
export const m = candidate.m;
export const __stageModules = candidate.__stageModules;
const savedScreens = candidate.savedScreens;
const executeConnectedScenario = new Function(${JSON.stringify('return (' + executeConnectedScenario.toString() + ');')})();
const connectedScenarios${annotation('any[]')} = ${JSON.stringify(opts.connected?.definition.scenarios.map((s) => ({ ...s, input: opts.connected!.results[s.id]?.input })) ?? [])};
const connectedSymbols = ${JSON.stringify(opts.connected?.definition.symbols ?? [])};
const __stageRunAll = new Function(${JSON.stringify(RUNNER + '\nreturn __stageRunAll;')})();
const scenarios${annotation('any[]')} = ${JSON.stringify(scenarios, null, 2)};
async function runDirect(m${annotation('Record<string, any>')}, renderHook${annotation('any')}) {
${code}
}
const renderHook = new Function(${JSON.stringify('return (' + createHookRenderer.toString() + ');')})()(React, createRoot);
export default function Stage3Verification({ baseUrl, headers = {} }${annotation('{ baseUrl?: string; headers?: Record<string, string> }')} = {}) {
  const [result, setResult] = useState('아직 실행하지 않았습니다.');
  const [running, setRunning] = useState(false);
  const execute = async (action${annotation('() => Promise<unknown>')}) => {
    setRunning(true);
    const consoleMethods = { log: console.log, info: console.info, warn: console.warn, error: console.error, debug: console.debug };
    const storageMethods = { setItem: Storage.prototype.setItem, removeItem: Storage.prototype.removeItem, clear: Storage.prototype.clear };
    try { const value = await action(); setResult(JSON.stringify(value, null, 2) ?? '(undefined)'); }
    catch (error) { setResult(error instanceof Error ? error.stack || error.message : String(error)); }
    finally { Object.assign(console, consoleMethods); Object.assign(Storage.prototype, storageMethods); setRunning(false); }
  };
  return <section>
    ${consoleInfo && !opts.connected ? '<button disabled={running} onClick={() => execute(() => runDirect(m, renderHook))}>직접 호출 실행</button>' : ''}
    {connectedScenarios.map((scenario) => <button key={scenario.id} disabled={running || !scenario.input || scenario.input.environment === 'node' || (!!scenario.network && !baseUrl)} onClick={() => execute(() => {
      const input = { ...scenario.input, values: { ...scenario.input.values } };
      if (scenario.network) input.values[scenario.network.valueKey] = baseUrl;
      delete input.values.__emitUrl;
      return executeConnectedScenario(input, Object.values(__stageModules), connectedSymbols, renderHook);
    })}>{scenario.name}{scenario.input?.environment === 'node' ? ' (Node 실행 결과는 Stage에서 확인)' : scenario.network && !baseUrl ? ' (baseUrl에 실제 서버 주소 필요)' : ' 실행·기대 결과 확인'}</button>)}
    {scenarios.map((scenario) => <button key={scenario.id} disabled={running} onClick={() => execute(() => __stageRunAll(true, [scenario], __stageModules))}>{scenario.exportName} 실행</button>)}
    <pre>{result}</pre>
    {savedScreens.map((Screen${annotation('React.ComponentType<any>')}, i${annotation('number')}) => <Screen key={i} baseUrl={baseUrl} headers={headers} />)}
  </section>;
}
`;
  await transform(source, { loader: extension });
  return { source, extension };
}
