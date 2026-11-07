import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeTestFile } from '../src/analysis/analyze.ts';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO = path.resolve(HERE, '..', '..');
export const SAMPLE = path.join(REPO, 'examples', 'order-client');
export const SAMPLE_TEST = path.join(SAMPLE, 'test', 'order-service.test.ts');

export function analyzeCase(file: string, projectRoot = SAMPLE) {
  return analyzeTestFile({ testFile: file, projectRoot });
}

/** 스냅샷 비교용: 실행마다 바뀌는 식별자·시각·절대 경로를 뺀 분석 결과 */
export function stableModel(a: ReturnType<typeof analyzeTestFile>) {
  return { status: a.status, rulesVersion: a.rulesVersion, imports: a.imports, findings: a.findings, scenarios: a.scenarios };
}
