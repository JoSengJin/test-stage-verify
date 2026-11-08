import ts from 'typescript';
import { testLiteral } from './scenario-presentation.ts';
import { testApi } from './test-api.ts';

export interface ScenarioEdit { start: number; end: number; text: string }
export interface ScenarioNetwork { kind: 'http' | 'sse'; valueKey: string; response?: unknown; failure?: boolean; method?: string; path?: string; envelope?: string[] }

/** Follow returned property paths rooted in JSON.parse results, independently of function names. */
export function responseEnvelope(source: string, file: string) {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const candidates = new Map<string, { path: string[]; line: number }>();
  const inspect = (scope: ts.Node) => {
    const parsed = new Set<string>();
    const returns: ts.Expression[] = [];
    if (!ts.isBlock(scope)) returns.push(scope as ts.Expression);
    const aliases: ts.VariableDeclaration[] = [];
    const scan = (node: ts.Node) => {
      if (node !== scope && ts.isFunctionLike(node)) return;
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        if (ts.isCallExpression(node.initializer) && node.initializer.expression.getText(sf) === 'JSON.parse') parsed.add(node.name.text);
        aliases.push(node);
      }
      if (ts.isReturnStatement(node) && node.expression) returns.push(node.expression);
      ts.forEachChild(node, scan);
    };
    scan(scope);
    for (const declaration of aliases) if (declaration.initializer && ts.isIdentifier(declaration.initializer) && parsed.has(declaration.initializer.text)) parsed.add((declaration.name as ts.Identifier).text);
    const collect = (node: ts.Node) => {
      const path: string[] = [];
      let root = node;
      while (ts.isPropertyAccessExpression(root) || ts.isElementAccessExpression(root)) {
        if (ts.isPropertyAccessExpression(root)) path.unshift(root.name.text);
        else if (ts.isStringLiteralLike(root.argumentExpression)) path.unshift(root.argumentExpression.text);
        else break;
        root = root.expression;
      }
      const parsedRoot = ts.isIdentifier(root) && parsed.has(root.text);
      const directParse = ts.isCallExpression(root) && root.expression.getText(sf) === 'JSON.parse';
      if (path.length && (parsedRoot || directParse)) {
        candidates.set(JSON.stringify(path), { path, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1 });
        return;
      }
      if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isNonNullExpression(node)) collect(node.expression);
      if (ts.isConditionalExpression(node)) { collect(node.whenTrue); collect(node.whenFalse); }
      if (ts.isBinaryExpression(node) && [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken].includes(node.operatorToken.kind)) { collect(node.left); collect(node.right); }
    };
    for (const expression of returns) collect(expression);
  };
  const visit = (node: ts.Node) => {
    if ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node) || ts.isMethodDeclaration(node)) && node.body) inspect(node.body);
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return candidates.size === 1 ? [...candidates.values()][0] : undefined;
}

/** Adapt test operations to native APIs while retaining the test's assertion expressions. */
export function adaptScenario(body: ts.Block, sf: ts.SourceFile, constants: readonly ts.VariableDeclaration[], helpers: Map<string, ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression>, hooks: Set<string>) {
  const edits: ScenarioEdit[] = [];
  const roles: Record<string, string> = {};
  const kinds: Record<string, 'object' | 'function' | 'value'> = {};
  const notes: string[] = [];
  const bindings = new Map<string, unknown>();
  const dynamic = new Map<string, string>();
  let network: ScenarioNetwork | undefined;
  const hookHandles = new Map<string, string>();
  let eventSource = false;
  let observedCount = 0;
  const api = testApi(sf);
  const declarations = new Map<string, ts.VariableDeclaration>();
  const edit = (node: ts.Node, text: string) => edits.push({ start: node.getStart(sf), end: node.end, text });
  const connection = (key: string, role: string, kind: 'object' | 'function' | 'value', owner?: string) => {
    roles[key] = role; kinds[key] = kind;
    return `await connect(${JSON.stringify(key)}${owner ? ', ' + owner : ''})`;
  };
  const helperInfo = (helper: ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression) => {
    const methods: string[] = [];
    const globals = new Set<string>();
    const scan = (node: ts.Node) => {
      if (ts.isPropertyAssignment(node) && ts.isCallExpression(node.initializer) && api.canonical(node.initializer.expression) === 'mock.fn') methods.push(ts.isStringLiteralLike(node.name) ? node.name.text : node.name.getText(sf));
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        if (['globalThis.window', 'global.window'].includes(node.left.getText(sf)) && ts.isObjectLiteralExpression(node.right)) {
          for (const property of node.right.properties) if (property.name) globals.add(ts.isStringLiteralLike(property.name) ? property.name.text : property.name.getText(sf));
        }
        if (ts.isPropertyAccessExpression(node.left) && node.left.expression.getText(sf) === 'window') globals.add(node.left.name.text);
      }
      ts.forEachChild(node, scan);
    };
    scan(helper);
    const role = globals.has('EventSource') ? 'event-source' : globals.has('sessionStorage') ? 'session-storage' : globals.has('localStorage') ? 'local-storage' : methods.includes('safeParse') ? 'schema' : methods.includes('useEffect') && methods.includes('useRef') ? 'react' : methods.includes('info') ? 'logger' : 'object';
    return { role, methods };
  };
  for (const constant of constants) {
    const parsed = testLiteral(constant.initializer, bindings);
    if (parsed.known) bindings.set(constant.name.getText(sf), parsed.value);
  }
  // Read literal setup first. This is data extraction, never evaluation of test helpers.
  for (const statement of body.statements) if (ts.isVariableStatement(statement)) {
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name)) declarations.set(declaration.name.text, declaration);
      const parsed = testLiteral(declaration.initializer, bindings);
      if (parsed.known) bindings.set(declaration.name.getText(sf), parsed.value);
    }
  }
  const endpoint = (node: ts.Node | undefined) => {
    const candidates = new Set<string>();
    const visited = new Set<string>();
    const inspect = (expression: ts.Node) => {
      if (ts.isPropertyAssignment(expression)) { inspect(expression.initializer); return; }
      if (ts.isPropertyAccessExpression(expression)) { inspect(expression.expression); return; }
      if (ts.isIdentifier(expression)) {
        const value = bindings.get(expression.text);
        if (typeof value === 'string' && /^https?:/.test(value)) { candidates.add(expression.text); return; }
        const declaration = declarations.get(expression.text);
        if (declaration?.initializer && !visited.has(expression.text) && ts.isObjectLiteralExpression(declaration.initializer)) { visited.add(expression.text); ts.forEachChild(declaration.initializer, inspect); }
      }
      ts.forEachChild(expression, inspect);
    };
    if (node) inspect(node);
    return candidates.size === 1 ? [...candidates][0] : undefined;
  };
  const instanceEndpoint = (owner: string) => {
    const root = owner.split('.')[0];
    const initializer = declarations.get(root)?.initializer;
    return initializer && (ts.isNewExpression(initializer) || ts.isCallExpression(initializer)) ? endpoint(initializer) : undefined;
  };
  const sseEndpoint = () => {
    const candidates = new Set<string>();
    const inspect = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'connect') {
        const value = instanceEndpoint(node.expression.expression.getText(sf));
        if (value) candidates.add(value);
      }
      ts.forEachChild(node, inspect);
    };
    inspect(body);
    return candidates.size === 1 ? [...candidates][0] : undefined;
  };
  const walk = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isObjectLiteralExpression(node.initializer)) {
      const methods = node.initializer.properties.filter(ts.isPropertyAssignment).filter(p => ts.isCallExpression(p.initializer) && api.canonical(p.initializer.expression) === 'mock.fn').map(p => ts.isStringLiteralLike(p.name) ? p.name.text : p.name.getText(sf));
      if (!methods.length) { ts.forEachChild(node, walk); return; }
      const key = node.name.getText(sf);
      edit(node.initializer, `observeObject(${connection(key, methods.includes('safeParse') ? 'schema' : 'object', 'object')}, ${JSON.stringify(methods)})`);
      return;
    }
    if (ts.isCallExpression(node)) {
      const name = api.canonical(node.expression);
      if (/^assert\./.test(name)) {
        const actual = node.arguments[0]?.getText(sf) || '';
        const label = name === 'assert.rejects' ? '비동기 오류 전달' : name === 'assert.doesNotThrow' ? '예외 없이 실행'
          : /\.mock\.callCount\(\)/.test(actual) ? '실제 협력자 호출 횟수'
          : /\.mock\.calls/.test(actual) ? '실제 협력자 호출 인자' : name === 'assert.ok' ? '조건 검증' : '반환값';
        let statement: ts.Node = node;
        while (statement.parent && !ts.isExpressionStatement(statement)) statement = statement.parent;
        if (ts.isExpressionStatement(statement)) edits.push({ start: statement.getStart(sf), end: statement.getStart(sf), text: `assert.label(${JSON.stringify(label)});\n` });
      }
      if (name === 'mock.method') {
        const owner = node.arguments[0].getText(sf);
        const method = ts.isStringLiteralLike(node.arguments[1]) ? node.arguments[1].text : '';
        const role = owner === 'console' ? 'console' : owner === 'Date' ? 'clock' : owner === 'Math' ? 'random' : owner === 'globalThis.crypto' ? 'uuid' : method === 'request' ? 'http' : 'object';
        const key = role === 'http' ? 'transport' : role === 'uuid' ? 'crypto' : owner;
        const observed = ts.isVariableDeclaration(node.parent) ? node.parent.name.getText(sf) : `__observed${observedCount++}`;
        const value = `observeMethod(${connection(key, role, 'value', owner)}, ${node.arguments[1].getText(sf)})`;
        edit(node, ts.isExpressionStatement(node.parent) ? `${observed} = ${value}` : value);
        if (ts.isExpressionStatement(node.parent)) edits.push({ start: node.parent.getStart(sf), end: node.parent.getStart(sf), text: 'const ' });
        const implementation = node.arguments[2];
        if (implementation && ts.isArrowFunction(implementation) && !ts.isBlock(implementation.body) && ['clock', 'random', 'uuid'].includes(role)) {
          dynamic.set(implementation.body.getText(sf), `${observed}.observed.calls[0].result`);
          notes.push(`${owner}.${method}의 고정 mock 반환값을 실제 호출에서 관찰한 반환값으로 비교합니다.`);
        }
        const urlKey = role === 'http' ? instanceEndpoint(owner) : undefined;
        if (role === 'http' && urlKey) {
          const response = implementation && ts.isArrowFunction(implementation) ? testLiteral(implementation.body, bindings) : { known: false, value: undefined };
          const failure = !!implementation && /\bthrow\b/.test(implementation.getText(sf));
          network = { kind: 'http', valueKey: urlKey, ...(response.known && response.value && typeof response.value === 'object' ? { response: (response.value as { data?: unknown }).data } : {}), failure };
        }
        return;
      }
      if (name === 'mock.fn') {
        const key = ts.isVariableDeclaration(node.parent) ? node.parent.name.getText(sf) : `callback${Object.keys(roles).length + 1}`;
        edit(node, `observeFunction(${connection(key, 'callback', 'function')})`); return;
      }
      if (helpers.has(name)) {
        const info = helperInfo(helpers.get(name)!);
        const key = info.role === 'react' ? 'react' : info.role === 'event-source' ? 'eventSource' : ts.isVariableDeclaration(node.parent) ? node.parent.name.getText(sf) : name;
        if (info.role === 'event-source') {
          eventSource = true;
          edit(node, `observeEventSource(${connection(key, info.role, 'value')})`);
          const urlKey = sseEndpoint();
          if (urlKey) network = { kind: 'sse', valueKey: urlKey };
          notes.push('직접 호출하던 가짜 이벤트를 실제 EventSource 연결·서버 메시지 수신으로 재현합니다.');
        } else {
          const expression = connection(key, info.role, 'object');
          edit(node, ts.isExpressionStatement(node.parent) ? expression : `observeObject(${expression}, ${JSON.stringify(info.methods)})`);
          if (info.role === 'session-storage' && node.arguments.length) notes.push('실제 Storage의 없는 키는 null을 반환합니다. mock의 undefined 반환 분기는 실제 Storage에서 재현되지 않습니다.');
        }
        return;
      }
      if (hooks.has(name) && ts.isExpressionStatement(node.parent) && node.arguments.length === 1) {
        let handle = hookHandles.get(name);
        if (handle) edit(node, `await ${handle}.rerender(${node.arguments[0].getText(sf)})`);
        else {
          handle = hookHandles.size ? `__hook${hookHandles.size}` : '__hook';
          hookHandles.set(name, handle);
          edit(node, `const ${handle} = await mountHook(props => ${name}(props), ${node.arguments[0].getText(sf)})`);
          notes.push('실제 React root의 mount·rerender 후 effect 완료를 기다립니다. Hook 호출 순서와 assertion은 원본 테스트에서 가져옵니다.');
        }
        return;
      }
      if (eventSource && /\.onopen$/.test(name)) { edit(node, `await waitForSource(${name.slice(0, -7)}, 'open')`); return; }
      if (eventSource && /\.listeners\.message$/.test(name)) { edit(node, `await receiveSse(${name.slice(0, -18)}, (${node.arguments[0].getText(sf)}).data)`); return; }
      if (/\.(get|post|put|patch|delete)$/.test(name) && network?.kind === 'http' && node.arguments[0]) {
        const parsed = testLiteral(node.arguments[0], bindings);
        if (parsed.known && typeof parsed.value === 'string') { network.path = parsed.value; network.method = name.split('.').at(-1)!.toUpperCase(); }
      }
    }
    ts.forEachChild(node, walk);
  };
  walk(body);
  // Expectations based on fixed time/random values must follow the actual collaborator's recorded result.
  if (dynamic.size) {
    const expand = (node: ts.Node, seen = new Set<string>()): { text: string; changed: boolean } => {
      const replacement = dynamic.get(node.getText(sf));
      if (replacement) return { text: `(${replacement})`, changed: true };
      if (ts.isCallExpression(node) && !(ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'toString' && node.arguments.length === 0)) return { text: node.getText(sf), changed: false };
      if (ts.isIdentifier(node) && !seen.has(node.text)) {
        const declaration = declarations.get(node.text);
        if (declaration?.initializer) {
          const expanded = expand(declaration.initializer, new Set(seen).add(node.text));
          if (expanded.changed) return { text: `(${expanded.text})`, changed: true };
        }
      }
      const changes: ScenarioEdit[] = [];
      ts.forEachChild(node, child => {
        const expanded = expand(child, seen);
        if (expanded.changed) changes.push({ start: child.getStart(sf), end: child.end, text: expanded.text });
      });
      let text = node.getText(sf);
      for (const change of changes.sort((a, b) => b.start - a.start)) text = text.slice(0, change.start - node.getStart(sf)) + change.text + text.slice(change.end - node.getStart(sf));
      return { text, changed: !!changes.length };
    };
    const expectations = (node: ts.Node) => {
      if (ts.isCallExpression(node) && /^assert\./.test(api.canonical(node.expression)) && node.arguments[1]) {
        const expanded = expand(node.arguments[1]);
        if (expanded.changed) edit(node.arguments[1], expanded.text);
      }
      ts.forEachChild(node, expectations);
    };
    expectations(body);
  }
  return { edits, roles, kinds, notes: [...new Set(notes)], network };
}
