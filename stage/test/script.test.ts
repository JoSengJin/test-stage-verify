// 스크립트 SUT(빌드 스크립트): 인식, 샌드박스 실행(fs 연산 기록·산출물·치환 잔여), 배포 exports 런타임 import 검증.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { analyzeTestFile } from '../src/analysis/analyze.ts';
import { runScriptSandbox } from '../src/exec/script-run.ts';
import { classifyNodeError, expandExports, judge, verifyExports } from '../src/exec/exports-verify.ts';
import { HERE } from './helpers.ts';

const w = (file: string, text: string) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); };

/** 하위 패키지 하나(@mini/a)를 mini-fw 하나로 통합하는 작은 프로젝트. 실제 bundle.mjs를 그대로 쓴다. */
function makeProject(root: string) {
  w(path.join(root, 'package.json'), JSON.stringify({ name: 'mini-fw', version: '1.0.0', files: ['a'], dependencies: {} }));
  w(path.join(root, 'packages/a/package.json'), JSON.stringify({ name: '@mini/a', main: './dist/index.js', types: './dist/index.d.ts', exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' }, './*': './dist/*/index.js' } }));
  w(path.join(root, 'packages/a/dist/index.js'), 'export const a = 1;\n');
  w(path.join(root, 'packages/a/dist/index.d.ts'), 'export declare const a = 1;\n');
  w(path.join(root, 'packages/a/dist/util/index.js'), "import { a } from '../index';\nexport const u = a + 1;\n");
  w(path.join(root, 'packages/a/dist/broken/index.js'), "import 'nonexistent-pkg-xyz';\nexport const b = 1;\n");
  w(path.join(root, 'packages/a/dist/browser/index.js'), 'window.x = 1;\nexport const w = 1;\n');
  w(path.join(root, 'packages/a/dist/self/index.js'), "import '@mini/a';\nexport const s = 1;\n");
  w(path.join(root, 'packages/a/dist/legacy.cjs'), "require('@mini/a');\n");
  fs.copyFileSync(path.join(HERE, 'fixtures/script-case/bundle.mjs'), path.join(root, 'scripts/bundle.mjs').replace(/^/, (fs.mkdirSync(path.join(root, 'scripts'), { recursive: true }), '')));
}

describe('스크립트 SUT 인식', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-script-detect-'));
  after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('new URL(…, import.meta.url)로 가리킨 스크립트를 import()로 실행하는 테스트를 인식한다', () => {
    makeProject(tmp);
    const test = path.join(tmp, 'scripts/tests/bundle.test.mjs');
    w(test, `import { registerHooks } from 'node:module';
import { test } from 'node:test';
const BUNDLE_URL = new URL('../bundle.mjs', import.meta.url).href;
registerHooks({ resolve(specifier, context, nextResolve) { if (specifier === 'node:fs') return { url: 'virtual:fs', shortCircuit: true }; return nextResolve(specifier, context); } });
let n = 0;
test('실행', async () => { await import(\`\${BUNDLE_URL}?case=\${n++}\`); });
`);
    const a = analyzeTestFile({ testFile: test, projectRoot: tmp });
    assert.equal(a.script?.file, path.join('scripts', 'bundle.mjs'));
    assert.deepEqual(a.script?.replaces, ['node:fs']);
  });

  it('스크립트를 import()로 실행하지 않거나 파일이 없으면 인식하지 않는다', () => {
    const t1 = path.join(tmp, 'scripts/tests/no-import.test.mjs');
    w(t1, "import { test } from 'node:test';\nconst URL_ = new URL('../bundle.mjs', import.meta.url).href;\ntest('x', () => URL_);\n");
    assert.equal(analyzeTestFile({ testFile: t1, projectRoot: tmp }).script, undefined);
    const t2 = path.join(tmp, 'scripts/tests/missing.test.mjs');
    w(t2, "import { test } from 'node:test';\nconst U = new URL('../nope.mjs', import.meta.url).href;\ntest('x', async () => { await import(U); });\n");
    assert.equal(analyzeTestFile({ testFile: t2, projectRoot: tmp }).script, undefined);
  });
});

describe('스크립트 샌드박스 실행과 exports 런타임 검증', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-script-run-'));
  const project = path.join(tmp, 'project');
  let dist = '';
  before(() => makeProject(project));
  after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  it('샌드박스에서 실제로 실행하고 fs 변경 연산을 순서대로 기록하며 원본 저장소는 바꾸지 않는다', async () => {
    const r = await runScriptSandbox({ projectRoot: project, scriptRel: 'scripts/bundle.mjs', sandboxRoot: path.join(tmp, 'sbx'), log: () => {} });
    assert.equal(r.exitCode, 0, r.error);
    assert.deepEqual(r.mutations.slice(0, 3).map((m) => m.op), ['rmSync', 'mkdirSync', 'cpSync']);
    assert.ok(r.mutations.some((m) => m.op === 'writeFileSync' && m.args.startsWith('<root>/dist/package.json')));
    assert.ok(r.readCounts.readFileSync > 0);
    assert.equal(fs.existsSync(path.join(project, 'dist')), false, '원본 저장소에 dist가 생기면 안 됨');
    assert.ok(r.distDir && fs.existsSync(path.join(r.distDir, 'package.json')));
    assert.equal(r.diff.baselineExists, false);
    assert.ok(r.diff.added.includes('package.json'));
    // .cjs는 스크립트가 치환하지 않으므로 하위 패키지 이름이 남는다 — 치환 잔여로 드러나야 한다.
    assert.deepEqual(r.leftovers.map((l) => l.file), [path.join('a', 'legacy.cjs')]);
    dist = r.distDir!;
  });

  it('스크립트가 실패하면(산출물 없음) 오류와 함께 실패로 돌려준다', async () => {
    const bad = path.join(tmp, 'bad');
    makeProject(bad);
    fs.rmSync(path.join(bad, 'packages/a/dist'), { recursive: true });
    const r = await runScriptSandbox({ projectRoot: bad, scriptRel: 'scripts/bundle.mjs', sandboxRoot: path.join(tmp, 'sbx'), log: () => {} });
    assert.equal(r.exitCode, 1);
    assert.match(r.error ?? '', /빌드 산출물이 없습니다/);
  });

  it('exports 패턴(./a/*)을 설치된 파일 구조에서 항목으로 펼친다', () => {
    const consumer = path.join(tmp, 'consumer');
    fs.cpSync(dist, path.join(consumer, 'node_modules', 'mini-fw'), { recursive: true });
    w(path.join(consumer, 'package.json'), '{"type":"module"}');
    const keys = expandExports(path.join(consumer, 'node_modules', 'mini-fw'), 'mini-fw').map((e) => e.key);
    assert.deepEqual(keys, ['.', './a', './a/broken', './a/browser', './a/self', './a/util']);
  });

  it('항목마다 Node 직접 import·번들러 해석·평가를 실제로 수행하고 결과를 구분한다', async () => {
    const consumer = path.join(tmp, 'consumer');
    const r = await verifyExports({ consumerDir: consumer, pkgName: 'mini-fw' });
    const by = Object.fromEntries(r.items.map((i) => [i.key, i]));
    assert.equal(r.total, 6);
    assert.equal(by['./a'].verdict, 'pass');
    assert.equal(by['./a'].node.status, 'ok');
    // 확장자 없는 상대 import: Node 단독은 불가, 번들러 해석에서는 정상
    assert.equal(by['./a/util'].node.status, 'bundler-required');
    assert.equal(by['./a/util'].bundle.status, 'ok');
    assert.equal(by['./a/util'].verdict, 'pass');
    // 선언되지 않은 의존성: 번들러 해석 단계에서 실패
    assert.equal(by['./a/broken'].verdict, 'fail');
    assert.match(by['./a/broken'].reason, /nonexistent-pkg-xyz/);
    // 브라우저 전용 코드: 번들은 되지만 Node 평가에서 실패 → 환경 차이로 보고 사람이 확인
    assert.equal(by['./a/browser'].bundle.status, 'ok');
    assert.equal(by['./a/browser'].verdict, 'needs-review');
    assert.deepEqual(r.counts, { pass: by['.'].verdict === 'pass' ? 4 : 3, 'needs-review': 1, fail: 1 });
  });
});

describe('exports 판정 규칙', () => {
  const ok = { status: 'ok' } as const;
  it('번들러 해석 실패는 항상 실패, 브라우저 전역 오류는 확인 필요, 그 밖의 평가 오류는 실패', () => {
    assert.equal(judge({ node: ok, bundle: { status: 'failed', detail: 'x' }, run: { status: 'skipped' } }).verdict, 'fail');
    assert.equal(judge({ node: ok, bundle: ok, run: { status: 'failed', detail: 'ReferenceError: window is not defined' } }).verdict, 'needs-review');
    assert.equal(judge({ node: ok, bundle: ok, run: { status: 'failed', detail: 'TypeError: x is not a function' } }).verdict, 'fail');
    assert.equal(judge({ node: { status: 'failed', detail: 'boom' }, bundle: ok, run: ok }).verdict, 'pass');
  });
  it('Node 직접 import 오류: 내부 확장자 없는 import는 번들러 전제, 패키지 누락은 실패', () => {
    assert.equal(classifyNodeError('ERR_UNSUPPORTED_DIR_IMPORT', "Directory import '/x/y' is not supported"), 'bundler-required');
    assert.equal(classifyNodeError('ERR_MODULE_NOT_FOUND', "Cannot find module '/x/y/z' imported from /x/y.js"), 'bundler-required');
    assert.equal(classifyNodeError('ERR_MODULE_NOT_FOUND', "Cannot find package '@eslint/js' imported from /x/y.js"), 'failed');
  });
});
