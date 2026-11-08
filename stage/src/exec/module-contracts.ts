import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import type { ProjectInfo, WiringCall } from '../model.ts';

export interface FactoryContract {
  hook: boolean;
  schema?: { kind: string; coerce: boolean };
  fields?: { nameKey: string; typeKey: string; types: string[] };
  methods: string[];
  callableWithoutArguments: boolean;
  httpClient?: boolean;
}

export function resolveModule(file: string, specifier: string) {
  if (!specifier.startsWith('.')) return undefined;
  const base = path.resolve(path.dirname(file), specifier);
  return [base, base + '.js', base + '.mjs', base + '.ts', path.join(base, 'index.js')].find(candidate => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
}

/** Read exports and their reachable implementation calls without loading or invoking the module. */
export function moduleContracts(file: string, cache = new Map<string, Map<string, FactoryContract>>()) {
  if (cache.has(file)) return cache.get(file)!;
  const output = new Map<string, FactoryContract>();
  cache.set(file, output);
  if (!fs.existsSync(file)) return output;
  const source = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const declarationFile = file.replace(/\.(m?js|ts)$/, '.d.ts');
  const declarations = fs.existsSync(declarationFile) ? ts.createSourceFile(declarationFile, fs.readFileSync(declarationFile, 'utf8'), ts.ScriptTarget.Latest, true) : source;
  const imports = new Map<string, { module: string; name: string }>();
  const functions = new Map<string, ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression>();
  const signatures = new Map<string, ts.FunctionDeclaration | ts.FunctionTypeNode>();
  const types = new Map<string, ts.InterfaceDeclaration | ts.TypeAliasDeclaration>();
  const libraryTypes = new Map<string, string>();
  const exports = new Map<string, string>();
  for (const statement of declarations.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteralLike(statement.moduleSpecifier) && statement.moduleSpecifier.text === 'zod') {
      const bindings = statement.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) for (const binding of bindings.elements) libraryTypes.set(binding.name.text, (binding.propertyName || binding.name).text);
      if (bindings && ts.isNamespaceImport(bindings)) libraryTypes.set(bindings.name.text, '*');
      if (statement.importClause?.name) libraryTypes.set(statement.importClause.name.text, '*');
    }
    if (ts.isFunctionDeclaration(statement) && statement.name) signatures.set(statement.name.text, statement);
    if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.type && ts.isFunctionTypeNode(declaration.type)) signatures.set(declaration.name.text, declaration.type);
    }
    if (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) types.set(statement.name.text, statement);
  }
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteralLike(statement.moduleSpecifier)) {
      const bindings = statement.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) for (const binding of bindings.elements) imports.set(binding.name.text, { module: statement.moduleSpecifier.text, name: (binding.propertyName || binding.name).text });
      if (bindings && ts.isNamespaceImport(bindings)) imports.set(bindings.name.text, { module: statement.moduleSpecifier.text, name: '*' });
      if (statement.importClause?.name) imports.set(statement.importClause.name.text, { module: statement.moduleSpecifier.text, name: 'default' });
    }
    const exported = ts.canHaveModifiers(statement) && ts.getModifiers(statement)?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword);
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      functions.set(statement.name.text, statement);
      if (exported) exports.set(statement.name.text, statement.name.text);
    }
    if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.initializer && (ts.isArrowFunction(declaration.initializer) || ts.isFunctionExpression(declaration.initializer))) {
        functions.set(declaration.name.text, declaration.initializer);
        if (exported) exports.set(declaration.name.text, declaration.name.text);
      }
    }
    if (ts.isExportDeclaration(statement)) {
      const remote = statement.moduleSpecifier && ts.isStringLiteralLike(statement.moduleSpecifier) ? resolveModule(file, statement.moduleSpecifier.text) : undefined;
      if (statement.exportClause && ts.isNamedExports(statement.exportClause)) for (const binding of statement.exportClause.elements) {
        const local = (binding.propertyName || binding.name).text;
        if (remote) { const contract = moduleContracts(remote, cache).get(local); if (contract) output.set(binding.name.text, contract); }
        else exports.set(binding.name.text, local);
      }
      else if (remote) for (const [name, contract] of moduleContracts(remote, cache)) output.set(name, contract);
    }
  }
  const unwrapType = (type: ts.TypeNode | undefined, visited = new Set<string>()): ts.TypeNode | ts.InterfaceDeclaration | undefined => {
    if (!type) return undefined;
    if (ts.isTypeOperatorNode(type)) return unwrapType(type.type, visited);
    if (ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName)) {
      if (visited.has(type.typeName.text)) return undefined;
      const target = types.get(type.typeName.text);
      if (target && ts.isTypeAliasDeclaration(target)) return unwrapType(target.type, new Set(visited).add(type.typeName.text));
      if (target) return target;
    }
    return type;
  };
  const fieldContract = (signature: ts.FunctionDeclaration | ts.FunctionTypeNode | undefined) => {
    if (!signature || !signature.parameters.slice(1).every(parameter => !!parameter.questionToken || !!parameter.initializer)) return undefined;
    const parameter = unwrapType(signature?.parameters[0]?.type);
    const element = parameter && ts.isArrayTypeNode(parameter) ? unwrapType(parameter.elementType) : undefined;
    if (!element || !ts.isInterfaceDeclaration(element)) return undefined;
    const properties = element.members.filter(ts.isPropertySignature).filter(property => !property.questionToken);
    const names = properties.filter(property => property.type?.kind === ts.SyntaxKind.StringKeyword);
    const discriminators = properties.flatMap(property => {
      const type = unwrapType(property.type);
      if (!type || !ts.isUnionTypeNode(type) || !type.types.every(item => ts.isLiteralTypeNode(item) && ts.isStringLiteralLike(item.literal))) return [];
      return [{ key: ts.isStringLiteralLike(property.name) ? property.name.text : property.name.getText(declarations), values: type.types.map(item => ((item as ts.LiteralTypeNode).literal as ts.StringLiteral).text) }];
    });
    if (names.length !== 1 || discriminators.length !== 1) return undefined;
    return { nameKey: ts.isStringLiteralLike(names[0].name) ? names[0].name.text : names[0].name.getText(declarations), typeKey: discriminators[0].key, types: discriminators[0].values };
  };
  const analyzed = new Map<string, FactoryContract>();
  const analyze = (name: string, visiting = new Set<string>()): FactoryContract => {
    if (analyzed.has(name)) return analyzed.get(name)!;
    const fn = functions.get(name);
    const result: FactoryContract = { hook: false, methods: [], callableWithoutArguments: false };
    if (!fn || visiting.has(name)) return result;
    const active = new Set(visiting).add(name);
    const signature = signatures.get(name);
    result.callableWithoutArguments = (signature?.parameters || fn.parameters).every(parameter => !!parameter.questionToken || !!parameter.initializer);
    const fields = fieldContract(signature);
    const merge = (contract: FactoryContract | undefined) => {
      if (!contract) return;
      result.hook ||= contract.hook;
      if (contract.schema) result.schema = { ...contract.schema };
    };
    const scan = (node: ts.Node) => {
      ts.forEachChild(node, scan);
      if (ts.isCallExpression(node)) {
        const parts: string[] = [];
        let root = node.expression;
        while (ts.isPropertyAccessExpression(root)) { parts.unshift(root.name.text); root = root.expression; }
        const binding = ts.isIdentifier(root) ? imports.get(root.text) : undefined;
        const member = parts.at(-1) || binding?.name;
        if (binding?.module === 'react' && member && (member === 'use' || /^use[A-Z]/.test(member))) result.hook = true;
        if (binding?.module === 'zod') {
          const kind = member!;
          if (['string', 'number', 'object', 'boolean', 'array', 'date'].includes(kind)) result.schema = { kind, coerce: parts.includes('coerce') };
        }
        if (ts.isIdentifier(node.expression)) {
          if (functions.has(node.expression.text)) merge(analyze(node.expression.text, active));
          else if (binding) { const remote = resolveModule(file, binding.module); if (remote) merge(moduleContracts(remote, cache).get(binding.name)); }
        }
      }
      if (ts.isReturnStatement(node) && node.expression && ts.isObjectLiteralExpression(node.expression)) result.methods = node.expression.properties.filter(property => ts.isPropertyAssignment(property) || ts.isMethodDeclaration(property)).map(property => property.name.getText(source));
    };
    if (fn.body) scan(fn.body);
    if (signature?.type) {
      const type = unwrapType(signature.type);
      const parts = type && ts.isTypeReferenceNode(type) ? type.typeName.getText(declarations).split('.') : [];
      const imported = libraryTypes.get(parts[0]);
      const typeName = imported === '*' || imported === 'z' ? parts.at(-1)! : imported || '';
      const members = type && (ts.isTypeLiteralNode(type) || ts.isInterfaceDeclaration(type)) ? type.members : [];
      const structural = members.some(member => member.name?.getText(declarations) === 'safeParse');
      const returnedMethods = members.filter(member => ts.isMethodSignature(member) || (ts.isPropertySignature(member) && member.type && ts.isFunctionTypeNode(member.type))).map(member => member.name?.getText(declarations) || '');
      if (returnedMethods.length) result.methods = returnedMethods;
      const options = unwrapType(signature.parameters[0]?.type);
      const optionMembers = options && (ts.isInterfaceDeclaration(options) || ts.isTypeLiteralNode(options)) ? options.members.map(member => member.name?.getText(declarations)) : [];
      result.httpClient = result.callableWithoutArguments && returnedMethods.includes('get') && returnedMethods.includes('post') && optionMembers.includes('baseUrl') && optionMembers.includes('defaultHeaders');
      if (!/^Zod/.test(typeName) && !structural) result.schema = undefined;
      const kind = ({ ZodObject: 'object', ZodString: 'string', ZodNumber: 'number', ZodBoolean: 'boolean', ZodArray: 'array', ZodDate: 'date' } as Record<string, string>)[typeName];
      if (result.schema && kind) result.schema.kind = kind;
    }
    if (result.schema && fields && result.schema.kind === 'object') result.fields = fields;
    analyzed.set(name, result);
    return result;
  };
  for (const [exported, local] of exports) output.set(exported, analyze(local));
  return output;
}

/** Attach verified Hook and client imports to the legacy playground's analyzed call sites. */
export function wireModuleContracts(project: ProjectInfo | undefined, testFile: string, calls: WiringCall[]) {
  const cache = new Map<string, Map<string, FactoryContract>>();
  const entries = new Map((project?.publicEntries || []).map(entry => [entry.specifier, entry]));
  if (project?.name) {
    const directory = project.packageDir || project.root;
    const packageFile = path.join(directory, 'package.json');
    const exported = fs.existsSync(packageFile) ? JSON.parse(fs.readFileSync(packageFile, 'utf8')).exports : undefined;
    const target = (value: unknown): string | undefined => {
      if (typeof value === 'string') return value;
      if (!value || typeof value !== 'object') return undefined;
      for (const condition of ['import', 'default', 'require']) {
        const resolved = target((value as Record<string, unknown>)[condition]);
        if (resolved) return resolved;
      }
      return undefined;
    };
    for (const call of calls) {
      if (!call.specifier.startsWith(project.name + '/')) continue;
      let specifier = call.specifier;
      while (specifier.length > project.name.length) {
        const subpath = '.' + specifier.slice(project.name.length);
        if (!entries.has(specifier) && exported && typeof exported === 'object') {
          const match = Object.keys(exported).filter(key => key.includes('*') && subpath.startsWith(key.split('*')[0]) && subpath.endsWith(key.split('*')[1])).sort((a, b) => b.length - a.length)[0];
          const template = target(exported[subpath] ?? (match && exported[match]));
          const replacement = match ? subpath.slice(match.indexOf('*'), subpath.length - match.split('*')[1].length) : '';
          const file = template?.startsWith('./') ? path.resolve(directory, template.replaceAll('*', replacement)) : undefined;
          if (file && !path.relative(directory, file).startsWith('..') && fs.existsSync(file) && fs.statSync(file).isFile()) entries.set(specifier, { specifier, subpath, distFile: file, evidence: 'package.json exports' });
        }
        specifier = specifier.slice(0, specifier.lastIndexOf('/'));
      }
    }
  }
  for (const call of calls) {
    const entry = entries.get(call.specifier);
    const file = entry?.distFile || resolveModule(testFile, call.specifier);
    call.hook = !!file && !!moduleContracts(file, cache).get(call.sut)?.hook;
  }
  if (!project || !calls.some(call => call.hook)) return;
  const candidates = [...entries.values()].flatMap(entry => entry.distFile ? [...moduleContracts(entry.distFile, cache)].filter(([, contract]) => contract.httpClient).map(([exportName, contract]) => ({ specifier: entry.specifier, exportName, contract })) : []);
  for (const call of calls.filter(call => call.hook)) {
    const score = (specifier: string) => {
      const left = specifier.split('/'), right = call.specifier.split('/');
      let common = 0;
      while (common < Math.min(left.length, right.length) && left[common] === right[common]) common++;
      return common;
    };
    const ranked = candidates.map(candidate => ({ ...candidate, score: score(candidate.specifier) })).sort((a, b) => b.score - a.score);
    const best = ranked.filter(candidate => candidate.score === ranked[0]?.score).sort((a, b) => a.specifier.length - b.specifier.length);
    if (best[0] && best.every(candidate => candidate.contract === best[0].contract)) call.clientFactory = { specifier: best[0].specifier, exportName: best[0].exportName };
  }
}
