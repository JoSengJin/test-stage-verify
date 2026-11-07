// node --test 사용자 정의 reporter: 이벤트를 NDJSON으로 기록한다(1단계 결과 원본 보존용).
export default async function* stageReporter(source) {
  for await (const e of source) {
    if (!['test:pass', 'test:fail', 'test:diagnostic', 'test:summary', 'test:stderr', 'test:stdout'].includes(e.type)) continue;
    const d = e.data ?? {};
    const err = d.details?.error;
    const cause = err?.cause ?? err;
    yield JSON.stringify({
      type: e.type,
      name: d.name,
      nesting: d.nesting,
      file: d.file,
      line: d.line,
      column: d.column,
      testType: d.details?.type,
      durationMs: d.details?.duration_ms,
      skip: d.skip,
      todo: d.todo,
      message: d.message,
      counts: d.counts,
      success: d.success,
      error: err ? {
        failureType: err.failureType,
        message: String(cause?.message ?? err.message ?? ''),
        code: cause?.code,
        operator: cause?.operator,
        expected: safe(cause?.expected),
        actual: safe(cause?.actual),
      } : undefined,
    }) + '\n';
  }
}
function safe(v) {
  try { return v === undefined ? undefined : JSON.parse(JSON.stringify(v)); } catch { return String(v); }
}
