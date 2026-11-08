import ts from 'typescript';

/** Keep calculation helpers in the scenario; translate the Node UTF-8 SHA-256 chain to Web Crypto. */
export function calculationHelper(name: string, helper: ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression, sf: ts.SourceFile) {
  const hashImports = new Set<string>();
  for (const statement of sf.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteralLike(statement.moduleSpecifier) || !['node:crypto', 'crypto'].includes(statement.moduleSpecifier.text)) continue;
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamedImports(bindings)) for (const binding of bindings.elements) {
      if ((binding.propertyName || binding.name).text === 'createHash') hashImports.add(binding.name.text);
    }
  }
  const edits: { start: number; end: number; text: string }[] = [];
  const scan = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'digest' && node.arguments.length === 1 && ts.isStringLiteralLike(node.arguments[0]) && node.arguments[0].text === 'hex') {
      const update = node.expression.expression;
      if (ts.isCallExpression(update) && ts.isPropertyAccessExpression(update.expression) && update.expression.name.text === 'update' && (update.arguments.length === 1 || (update.arguments.length === 2 && ts.isStringLiteralLike(update.arguments[1]) && ['utf8', 'utf-8'].includes(update.arguments[1].text)))) {
        const hash = update.expression.expression;
        if (ts.isCallExpression(hash) && ts.isIdentifier(hash.expression) && hashImports.has(hash.expression.text) && hash.arguments.length === 1 && ts.isStringLiteralLike(hash.arguments[0]) && hash.arguments[0].text === 'sha256') {
          edits.push({ start: node.getStart(sf), end: node.end, text: `Array.from(new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(${update.arguments[0].getText(sf)}))), byte => byte.toString(16).padStart(2, '0')).join('')` });
          return;
        }
      }
    }
    ts.forEachChild(node, scan);
  };
  if (!helper.body) return { code: '', asynchronous: false };
  scan(helper.body);
  let body = helper.body.getText(sf);
  for (const edit of edits.sort((a, b) => b.start - a.start)) body = body.slice(0, edit.start - helper.body.getStart(sf)) + edit.text + body.slice(edit.end - helper.body.getStart(sf));
  if (!ts.isBlock(helper.body)) body = `{ return (${body}); }`;
  const asynchronous = edits.length > 0 || !!helper.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword);
  return { code: `${asynchronous ? 'async ' : ''}function ${name}(${helper.parameters.map(parameter => parameter.getText(sf)).join(', ')}) ${body}`, asynchronous };
}
