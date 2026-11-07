// 스크립트 SUT 인식. 테스트가 공개 API가 아니라 스크립트 파일을 실행해 검증하는 유형(빌드 스크립트 등)을 찾는다.
//   const URL_VAR = new URL('../bundle.mjs', import.meta.url).href   ← 대상 파일
//   await import(`${URL_VAR}?case=1`)                                 ← import 시점에 실행되는 스크립트
//   registerHooks({ resolve(spec) { if (spec === 'node:fs') ... } }) ← 협력자를 대체 객체로 바꾼 내장 모듈
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import type { ScriptTarget } from '../model.ts';

const SCRIPT_EXT = new Set(['.mjs', '.js', '.cjs', '.ts', '.mts']);

const unwrap = (e: ts.Expression): ts.Expression => {
  let cur = e;
  while (ts.isParenthesizedExpression(cur) || ts.isAwaitExpression(cur) || ts.isAsExpression(cur) || ts.isNonNullExpression(cur)) cur = cur.expression;
  return cur;
};

/** new URL('<상대 경로>', import.meta.url) [.href] 에서 상대 경로를 꺼낸다. */
function urlRelative(init: ts.Expression): string | undefined {
  let e = unwrap(init);
  if (ts.isPropertyAccessExpression(e) && e.name.text === 'href') e = unwrap(e.expression);
  if (!ts.isNewExpression(e) || !ts.isIdentifier(e.expression) || e.expression.text !== 'URL') return undefined;
  const [rel, base] = e.arguments ?? [];
  if (!rel || !ts.isStringLiteralLike(rel) || !base || !/import\s*\.\s*meta\s*\.\s*url/.test(base.getText())) return undefined;
  return rel.text;
}

export function detectScriptTarget(sf: ts.SourceFile, testFile: string, projectRoot: string | undefined): ScriptTarget | undefined {
  if (!projectRoot) return undefined;
  // 이름 → 상대 경로
  const urlVars = new Map<string, string>();
  const collect = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
      const rel = urlRelative(n.initializer);
      if (rel) urlVars.set(n.name.text, rel);
    }
    ts.forEachChild(n, collect);
  };
  collect(sf);
  if (!urlVars.size) return undefined;

  // 그 이름을 쓰는 동적 import()가 있어야 스크립트를 실행하는 테스트로 본다.
  let used: string | undefined;
  const findImport = (n: ts.Node) => {
    if (!used && ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword && n.arguments[0]) {
      const text = n.arguments[0].getText(sf);
      for (const name of urlVars.keys()) if (new RegExp(`\\b${name}\\b`).test(text)) used = name;
    }
    ts.forEachChild(n, findImport);
  };
  findImport(sf);
  if (!used) return undefined;

  const abs = path.resolve(path.dirname(testFile), urlVars.get(used)!);
  if (!SCRIPT_EXT.has(path.extname(abs)) || !fs.existsSync(abs) || !abs.startsWith(path.resolve(projectRoot) + path.sep)) return undefined;

  const replaces = [...new Set([...sf.getFullText().matchAll(/specifier\s*===\s*['"](node:[a-z_/]+)['"]/g)].map((m) => m[1]))];
  const file = path.relative(projectRoot, abs);
  return {
    file,
    replaces,
    evidence: `new URL('${urlVars.get(used)}', import.meta.url)로 가리킨 스크립트를 import()로 실행${replaces.length ? `, ${replaces.join(', ')}을(를) 모듈 훅으로 대체 객체로 교체` : ''}`,
  };
}
