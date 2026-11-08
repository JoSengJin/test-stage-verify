import ts from 'typescript';

/** Local names come from imports. node:test and node:assert remain the supported protocols. */
export function testApi(source: ts.SourceFile) {
  const tests = new Set<string>();
  const mocks = new Set<string>();
  const assertions = new Set<string>();
  for (const statement of source.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteralLike(statement.moduleSpecifier)) continue;
    const module = statement.moduleSpecifier.text;
    if (/^(node:)?test$/.test(module) && statement.importClause?.name) tests.add(statement.importClause.name.text);
    if (/^(node:)?assert(\/strict)?$/.test(module) && statement.importClause?.name) assertions.add(statement.importClause.name.text);
    const bindings = statement.importClause?.namedBindings;
    if (bindings && ts.isNamespaceImport(bindings)) {
      if (/^(node:)?test$/.test(module)) { tests.add(bindings.name.text + '.test'); tests.add(bindings.name.text + '.it'); mocks.add(bindings.name.text + '.mock'); }
      if (/^(node:)?assert(\/strict)?$/.test(module)) assertions.add(bindings.name.text);
    }
    if (bindings && ts.isNamedImports(bindings)) for (const binding of bindings.elements) {
      const name = (binding.propertyName || binding.name).text;
      if (/^(node:)?test$/.test(module) && ['test', 'it'].includes(name)) tests.add(binding.name.text);
      if (/^(node:)?test$/.test(module) && name === 'mock') mocks.add(binding.name.text);
      if (/^(node:)?assert$/.test(module) && name === 'strict') assertions.add(binding.name.text);
    }
  }
  // Some analysis fixtures supply assertion globals through the test harness.
  if (!assertions.size) assertions.add('assert');
  const canonical = (expression: ts.Expression) => {
    if (!ts.isPropertyAccessExpression(expression)) return expression.getText(source);
    if (mocks.has(expression.expression.getText(source))) return 'mock.' + expression.name.text;
    if (assertions.has(expression.expression.getText(source))) return 'assert.' + expression.name.text;
    return expression.getText(source);
  };
  return { tests, mocks, assertions, canonical };
}
