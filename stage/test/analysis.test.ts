// 분석 사례 회귀 검증. 규칙을 바꾸면 이 테스트가 기존 사례의 분석 결과 변화를 드러낸다.
// 의도한 변경이면 UPDATE_SNAPSHOTS=1 로 기대 모델을 다시 만들고 diff를 검토해 커밋한다.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { HERE, SAMPLE, SAMPLE_TEST, analyzeCase, stableModel } from './helpers.ts';
import { tokenizeScript, detectRunner } from '../src/analysis/project.ts';

const CASES = path.join(HERE, 'fixtures', 'cases');
const EXPECTED = path.join(HERE, 'fixtures', 'expected');

function snapshot(name: string, value: unknown) {
  const file = path.join(EXPECTED, `${name}.json`);
  const json = JSON.stringify(value, null, 2) + '\n';
  if (process.env.UPDATE_SNAPSHOTS === '1' || !fs.existsSync(file)) {
    fs.writeFileSync(file, json);
    return;
  }
  assert.deepStrictEqual(JSON.parse(json), JSON.parse(fs.readFileSync(file, 'utf8')), `${name}: 분석 결과가 기대 실행 모델과 다름`);
}

describe('대표 사례: examples/order-client 런던파 테스트', () => {
  const a = analyzeCase(SAMPLE_TEST);

  it('기대 실행 모델과 일치한다(스냅샷)', () => snapshot('order-service', stableModel(a)));

  it('네 시나리오 모두 자동 실행 가능하고 공개 API에 대응한다', () => {
    assert.equal(a.status, 'auto');
    assert.equal(a.scenarios.length, 4);
    for (const sc of a.scenarios) {
      assert.equal(sc.support.status, 'auto', sc.title);
      for (const t of sc.targets) assert.equal(t.publicApi.status, 'mapped');
      assert.equal(sc.consumerLink?.status, 'linked');
    }
  });

  it('import를 테스트 도구·대상 소스로 구분한다', () => {
    const roles = Object.fromEntries(a.imports.map((i) => [i.specifier, i.role]));
    assert.deepEqual(roles, {
      'node:test': 'test-tool',
      'node:assert/strict': 'test-tool',
      '../src/internal/order-service.ts': 'target-source',
      '../src/errors.ts': 'target-source',
    });
  });

  it('beforeEach 준비, 대체 객체 동작, 호출 횟수·인자 검증을 모델로 옮긴다', () => {
    const sc = a.scenarios[0];
    assert.deepEqual(sc.steps.map((s) => s.kind), ['construct', 'call', 'check', 'check', 'check', 'check']);
    assert.equal(sc.doubles[0].collaboratorOf?.type, 'HttpClient');
    assert.deepEqual(sc.doubles[0].methods.post.behavior, { kind: 'resolves', value: { id: 'ord-1001', sku: 'SKU-1', quantity: 2, status: 'created' } });
    const subjects = sc.steps.flatMap((s) => (s.kind === 'check' && s.check.kind === 'compare' ? [s.check.subject.kind] : []));
    assert.deepEqual(subjects, ['result', 'callCount', 'callArgs', 'callCount']);
  });

  it('오류 대체값을 공개 export 생성자로 표현한다', () => {
    const sc = a.scenarios[2];
    const failing = sc.doubles.find((d) => d.varName === 'failingHttp')!;
    assert.deepEqual(failing.methods.post.behavior, { kind: 'rejects', value: { $stage: 'construct', export: 'HttpError', sourceExport: 'HttpError', args: [503, 'order backend unavailable'] } });
  });
});

const CASE_EXPECT: Record<string, { status: string; rules: string[] }> = {
  'contract-mismatch.case.ts': { status: 'contract-mismatch', rules: ['contract/double-extra', 'contract/method-missing'] },
  'dynamic-import.case.ts': { status: 'auto', rules: [] },
  'no-target.case.ts': { status: 'no-target', rules: ['target/none'] },
  'partial.case.ts': { status: 'partial', rules: ['arg/unknown'] },
  'unmapped.case.ts': { status: 'partial', rules: ['public/map'] },
  'unsupported.case.ts': { status: 'unsupported', rules: ['hook/once', 'stmt/kind', 'assert/unsupported'] },
  'vitest.case.ts': { status: 'unsupported', rules: ['tool/unknown', 'test/none'] },
};

describe('판정 분류 사례(규칙 확장 회귀)', () => {
  for (const [file, exp] of Object.entries(CASE_EXPECT)) {
    it(`${file} → ${exp.status}`, () => {
      const a = analyzeCase(path.join(CASES, file));
      assert.equal(a.status, exp.status);
      const rules = new Set([...a.findings, ...a.scenarios.flatMap((s) => s.support.findings)].map((f) => f.ruleId));
      for (const r of exp.rules) assert.ok(rules.has(r), `${file}: 규칙 ${r} 근거가 없음 (${[...rules].join(', ')})`);
      for (const f of [...a.findings, ...a.scenarios.flatMap((s) => s.support.findings)]) {
        assert.ok(f.ruleId && f.message, '모든 판단에 규칙 ID와 근거가 있어야 함');
      }
      assert.equal(a.rulesVersion.length > 0, true);
      snapshot(file.replace(/\.case\.ts$/, ''), stableModel(a));
    });
  }

  it('모든 사례 파일에 기대 판정이 정의돼 있다(누락 방지)', () => {
    assert.deepEqual(fs.readdirSync(CASES).sort(), Object.keys(CASE_EXPECT).sort());
  });

  it('미지원 assertion을 검증 단계에서 빼지 않고 unsupported check로 남긴다', () => {
    const a = analyzeCase(path.join(CASES, 'unsupported.case.ts'));
    const checks = a.scenarios[0].steps.filter((s) => s.kind === 'check');
    assert.ok(checks.some((s) => s.kind === 'check' && s.check.kind === 'unsupported'));
  });
});

describe('프로젝트 문맥', () => {
  it('드롭 파일이 프로젝트와 연결되지 않으면 부족한 정보를 표시한다', async () => {
    const { analyzeTestFile } = await import('../src/analysis/analyze.ts');
    const a = analyzeTestFile({ testFile: path.join(CASES, 'contract-mismatch.case.ts') });
    assert.equal(a.input.linkStatus, 'not-linked');
    assert.ok(a.findings.some((f) => f.ruleId === 'project/link'));
  });

  it('러너 인식: node --test만 지원하고 나머지는 근거와 함께 미지원', () => {
    assert.equal(detectRunner({ scripts: { test: 'node --test "test/**/*.test.ts"' } }).kind, 'node-test');
    assert.equal(detectRunner({ scripts: { test: 'vitest run' } }).kind, 'unknown');
    assert.equal(detectRunner({ scripts: { test: 'node --test && echo hi' } }).kind, 'unknown');
    assert.equal(detectRunner({}).kind, 'unknown');
    assert.deepEqual(tokenizeScript('node --test "a b.ts"'), ['node', '--test', 'a b.ts']);
  });

  it('공개 entry를 tsconfig outDir/rootDir로 소스에 대응시킨다', () => {
    const a = analyzeCase(SAMPLE_TEST);
    const e = a.project!.publicEntries[0];
    assert.equal(path.relative(SAMPLE, e.sourceFile!), path.join('src', 'index.ts'));
    assert.equal(e.specifier, '@sample/order-client');
  });
});
