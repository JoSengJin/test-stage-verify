import ts from 'typescript';
import type { TypeSchema } from '../model.ts';

/** TypeScript 타입 → 화면 구성·계약 검증용 스키마. 깊이를 제한하고, 표현할 수 없는 타입은 ref로 남긴다. */
export function toSchema(checker: ts.TypeChecker, t: ts.Type, node: ts.Node, depth = 0): TypeSchema {
  const f = t.flags;
  if (f & ts.TypeFlags.Any) return { kind: 'any' };
  if (f & ts.TypeFlags.Unknown) return { kind: 'unknown' };
  if (f & ts.TypeFlags.StringLiteral) return { kind: 'literal', value: (t as ts.StringLiteralType).value };
  if (f & ts.TypeFlags.NumberLiteral) return { kind: 'literal', value: (t as ts.NumberLiteralType).value };
  if (f & ts.TypeFlags.BooleanLiteral) return { kind: 'literal', value: (t as any).intrinsicName === 'true' };
  if (f & ts.TypeFlags.String) return { kind: 'string' };
  if (f & ts.TypeFlags.Number) return { kind: 'number' };
  if (f & ts.TypeFlags.Boolean) return { kind: 'boolean' };
  if (f & ts.TypeFlags.Null) return { kind: 'null' };
  if (f & ts.TypeFlags.Undefined) return { kind: 'undefined' };
  if (f & ts.TypeFlags.Void) return { kind: 'void' };
  if (f & ts.TypeFlags.Never) return { kind: 'never' };
  if (t.isUnion()) {
    let options = t.types.map((x) => toSchema(checker, x, node, depth));
    const hasT = options.some((o) => o.kind === 'literal' && o.value === true);
    const hasF = options.some((o) => o.kind === 'literal' && o.value === false);
    if (hasT && hasF) options = [...options.filter((o) => !(o.kind === 'literal' && typeof o.value === 'boolean')), { kind: 'boolean' }];
    return options.length === 1 ? options[0] : { kind: 'union', options };
  }
  if (checker.isArrayType(t)) {
    const el = checker.getTypeArguments(t as ts.TypeReference)[0];
    return { kind: 'array', element: el ? toSchema(checker, el, node, depth + 1) : { kind: 'unknown' } };
  }
  if (f & ts.TypeFlags.Object) {
    const props = checker.getPropertiesOfType(t);
    if (t.getCallSignatures().length > 0 && props.length === 0) return { kind: 'function', text: checker.typeToString(t) };
    if (depth > 3) return { kind: 'ref', text: checker.typeToString(t) };
    const out: Record<string, { schema: TypeSchema; optional: boolean }> = {};
    for (const p of props) {
      if (p.name.startsWith('#') || p.name.startsWith('__')) continue;
      const optional = (p.flags & ts.SymbolFlags.Optional) !== 0;
      let pt = checker.getTypeOfSymbolAtLocation(p, node);
      if (optional) pt = checker.getNonNullableType(pt);
      out[p.name] = { schema: toSchema(checker, pt, node, depth + 1), optional };
    }
    const sym = t.aliasSymbol ?? t.getSymbol();
    const name = sym && !sym.name.startsWith('__') ? sym.name : undefined;
    return { kind: 'object', name, props: out };
  }
  return { kind: 'ref', text: checker.typeToString(t) };
}

export function awaitedReturn(checker: ts.TypeChecker, sig: ts.Signature): ts.Type {
  const r = sig.getReturnType();
  return checker.getAwaitedType(r) ?? r;
}
