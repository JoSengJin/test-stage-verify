// 운영 게이트 보호 장치: 요청 출처 검사와 서버에서 실행할 연결식 검사.
// 이 도구는 "통과" 판정을 남기므로, 아무 웹페이지나 임의 코드가 판정·실행 API를 호출하지 못하게 막는다.
import ts from 'typescript';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/** Host 헤더의 호스트 이름만 비교한다(포트 제외). 허용: 루프백 + STAGE_ALLOWED_HOSTS(쉼표 구분). DNS rebinding 방어. */
export function hostAllowed(hostHeader: string | undefined, extra: string[] = []): boolean {
  if (!hostHeader) return false;
  const name = hostHeader.startsWith('[') ? hostHeader.slice(0, hostHeader.indexOf(']') + 1) : hostHeader.split(':')[0];
  const lower = name.toLowerCase();
  return LOOPBACK.has(lower) || extra.map((h) => h.trim().toLowerCase()).filter(Boolean).includes(lower);
}

/**
 * 상태를 바꾸는 요청(POST·PUT·DELETE)은 Origin이 없거나(서버·CLI 호출) 허용된 호스트여야 한다.
 * Origin이 'null'(샌드박스 iframe)이거나 다른 사이트면 거부한다. 교차 출처 웹페이지가 판정을 위조하는 것을 막는다.
 */
export function originAllowed(origin: string | undefined, extra: string[] = []): boolean {
  if (origin === undefined) return true;
  try { return hostAllowed(new URL(origin).host, extra); } catch { return false; }
}

const FORBIDDEN_NAMES = new Set(['constructor', '__proto__', 'prototype', 'Function', 'eval', 'process', 'require', 'import', 'child_process']);

/**
 * 서버(Node)에서 `new Function`으로 평가될 연결식이 "배포 모듈/전역 API 참조와 호출"만으로 이뤄졌는지 검사한다.
 * 허용: 식별자, 점·대괄호(문자열 리터럴) 접근, 호출, 리터럴·객체·배열. 금지: 함수·클래스 식, new, 템플릿, 대입, 위험 이름.
 */
export function isSafeConnectionExpression(expression: string): boolean {
  if (typeof expression !== 'string' || expression.length > 2000) return false;
  if (expression === '@actual') return true; // 실행기가 해석하는 예약 토큰(코드로 평가되지 않음)
  const source = ts.createSourceFile('expr.ts', `(${expression});`, ts.ScriptTarget.Latest, true);
  if (source.statements.length !== 1 || !ts.isExpressionStatement(source.statements[0])) return false;
  if ((source as unknown as { parseDiagnostics: unknown[] }).parseDiagnostics.length) return false;
  let ok = true;
  const visit = (n: ts.Node) => {
    if (!ok) return;
    if (ts.isIdentifier(n)) {
      if (FORBIDDEN_NAMES.has(n.text)) ok = false;
    } else if (ts.isElementAccessExpression(n)) {
      if (!ts.isStringLiteralLike(n.argumentExpression) && !ts.isNumericLiteral(n.argumentExpression)) ok = false;
      else if (ts.isStringLiteralLike(n.argumentExpression) && FORBIDDEN_NAMES.has(n.argumentExpression.text)) ok = false;
    } else if (ts.isStringLiteralLike(n) && FORBIDDEN_NAMES.has(n.text) && !(n.parent && ts.isElementAccessExpression(n.parent))) {
      // 일반 문자열 리터럴은 허용한다(예: 'constructor'라는 필드 이름 데이터).
    } else if (
      !(ts.isParenthesizedExpression(n) || ts.isExpressionStatement(n) || ts.isSourceFile(n) || ts.isPropertyAccessExpression(n) || ts.isCallExpression(n)
        || ts.isStringLiteralLike(n) || ts.isNumericLiteral(n) || ts.isObjectLiteralExpression(n) || ts.isArrayLiteralExpression(n) || ts.isPropertyAssignment(n)
        || ts.isShorthandPropertyAssignment(n) || n.kind === ts.SyntaxKind.TrueKeyword || n.kind === ts.SyntaxKind.FalseKeyword || n.kind === ts.SyntaxKind.NullKeyword
        || n.kind === ts.SyntaxKind.EndOfFileToken || ts.isPrefixUnaryExpression(n) || ts.isNonNullExpression(n) || ts.isIdentifier(n)
        || n.kind === ts.SyntaxKind.MinusToken || n.kind === ts.SyntaxKind.ExclamationToken)
    ) ok = false;
    if (ok) ts.forEachChild(n, visit);
  };
  visit(source);
  return ok;
}
