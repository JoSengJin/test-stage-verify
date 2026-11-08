import ts from 'typescript';
import { testApi } from './test-api.ts';

const unknownValue = Symbol('unknown');

/** Read test literals without executing test code or mock implementations. */
function literal(node: ts.Node | undefined, bindings: Map<string, unknown>): unknown {
  if (!node) return unknownValue;
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isNumericLiteral(node)) return Number(node.text);
  if (node.kind === ts.SyntaxKind.NullKeyword) return null;
  if (node.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (node.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (ts.isIdentifier(node)) return bindings.has(node.text) ? bindings.get(node.text) : unknownValue;
  if (ts.isParenthesizedExpression(node)) return literal(node.expression, bindings);
  if (ts.isPrefixUnaryExpression(node) && node.operator === ts.SyntaxKind.MinusToken) {
    const value = literal(node.operand, bindings);
    return typeof value === 'number' ? -value : unknownValue;
  }
  if (ts.isArrayLiteralExpression(node)) {
    const items = node.elements.map((item) => literal(item, bindings));
    return items.includes(unknownValue) ? unknownValue : items;
  }
  if (ts.isObjectLiteralExpression(node)) {
    const entries: [string, unknown][] = [];
    for (const property of node.properties) {
      if (!ts.isPropertyAssignment(property) || !property.name || ts.isComputedPropertyName(property.name)) return unknownValue;
      const key = ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name) ? property.name.text : property.name.getText();
      const value = literal(property.initializer, bindings);
      if (value === unknownValue) return unknownValue;
      entries.push([key, value]);
    }
    return Object.fromEntries(entries);
  }
  return unknownValue;
}

export function testLiteral(node: ts.Node | undefined, bindings: Map<string, unknown>) {
  const value = literal(node, bindings);
  return { known: value !== unknownValue, value: value === unknownValue ? undefined : value };
}

export function scenarioPresentation(body: ts.Block, sf: ts.SourceFile, constants: readonly ts.VariableDeclaration[], serverKey?: string, roles: Record<string, string> = {}) {
  const api = testApi(sf);
  const bindings = new Map<string, unknown>();
  const checks: { label: string; expected: unknown }[] = [];
  let parsing: { functionName: string; connection: string; input: unknown; fallback?: unknown } | undefined;
  for (const constant of constants) bindings.set(constant.name.getText(sf), literal(constant.initializer, bindings));
  for (const statement of body.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        bindings.set(declaration.name.getText(sf), literal(declaration.initializer, bindings));
        const call = declaration.initializer;
        if (call && ts.isCallExpression(call) && ts.isIdentifier(call.expression) && call.arguments[0] && roles[call.arguments[0].getText(sf)] === 'schema') {
          const input = literal(call.arguments[1], bindings);
          if (input !== unknownValue && call.arguments[0] && ts.isIdentifier(call.arguments[0])) {
            const fallback = literal(call.arguments[2], bindings);
            parsing = { functionName: call.expression.text, connection: call.arguments[0].text, input, ...(fallback !== unknownValue ? { fallback } : {}) };
          }
        }
      }
    }
    if (ts.isExpressionStatement(statement) && ts.isCallExpression(statement.expression)) {
      const call = statement.expression;
      if (!/^assert\.(equal|strictEqual|deepEqual|deepStrictEqual)$/.test(api.canonical(call.expression))) continue;
      const expectedBindings = new Map(bindings);
      if (serverKey) expectedBindings.set(serverKey, `선택한 서버 주소 (${serverKey})`);
      const expected = literal(call.arguments[1], expectedBindings);
      if (expected === unknownValue || !call.arguments[0]) continue;
      const actual = call.arguments[0].getText(sf);
      const label = /\.mock\.callCount\(\)/.test(actual) ? '검증 함수 호출 횟수'
        : /\.mock\.calls\[0\]\.arguments\[0\]/.test(actual) ? '검증 함수에 전달한 값' : actual === 'result' ? '반환값' : '검증 항목 ' + (checks.length + 1);
      checks.push({ label, expected });
    }
  }
  return { ...(parsing ? { parsing } : {}), checks };
}
