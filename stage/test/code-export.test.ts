import { it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { build } from 'esbuild';
import { exportStage3Component } from '../src/exec/code-export.ts';

it('React 내보내기는 실제 후보·편집 코드·시나리오 입력을 보존하고 React를 공유한다', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-component-'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ dependencies: { react: '19' } }));
  fs.writeFileSync(path.join(root, 'tsconfig.json'), '{"compilerOptions":{"strict":true,"jsx":"react-jsx"}}');
  fs.writeFileSync(path.join(root, 'api.js'), 'export function echo(value) { return "candidate:" + value; }');
  try {
    const { source, extension } = await exportStage3Component({ projectRoot: root, live: {
      dir: root, console: { projectRoot: root, packageDir: root, modules: ['api.js'], symbols: [] },
      scenarios: { s1: { mod: 0, mods: [0], exportName: 'echo', bindings: [], args: ['"old"'], setup: [] } },
    }, drafts: { console: 'return m.echo("edited");', scenarios: { s1: { args: '"scenario"', seed: '{"saved":"yes"}' } } } });
    assert.equal(extension, 'tsx');
    assert.match(source, /return m.echo\("edited"\)/);
    assert.match(source, /scenario/);
    assert.match(source, /"saved": "yes"/);
    const compiled = await build({ stdin: { contents: source, loader: 'tsx' }, bundle: true, write: false, platform: 'node', format: 'cjs', external: ['react', 'react/*', 'react-dom', 'react-dom/*'], logLevel: 'silent' });
    const module = { exports: {} as any };
    vm.runInNewContext(compiled.outputFiles[0].text, { exports: module.exports, module, require: () => ({}) });
    assert.equal(module.exports.m.echo('x'), 'candidate:x');
    assert.equal(module.exports.__stageModules[0].echo('x'), 'candidate:x');
    assert.equal(typeof module.exports.default, 'function');
    fs.writeFileSync('/tmp/Stage3Verification.tsx', source);
    fs.unlinkSync(path.join(root, 'tsconfig.json'));
    const jsProject = await exportStage3Component({ projectRoot: root, playground: [] });
    assert.equal(jsProject.extension, 'jsx');
    assert.doesNotMatch(jsProject.source, /baseUrl\?: string/);
    fs.writeFileSync(path.join(root, 'package.json'), '{}');
    await assert.rejects(exportStage3Component({ projectRoot: root }), /React 사용/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

it('내보내기 API는 판정 확정 후 프로젝트 형식의 파일로 내려준다', async () => {
  const { createStageServer } = await import('../src/server.ts');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-export-api-'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ dependencies: { react: '19' }, devDependencies: { typescript: '6' } }));
  fs.writeFileSync(path.join(root, 'api.js'), 'export const value = 1;');
  const app = createStageServer({ projects: [], dataDir: path.join(root, 'data'), port: 0 });
  const run = { id: 'export-run', project: { root }, stages: [{}, {}, { status: 'running' }], realEnv: { live: { dir: root, scenarios: {}, console: { projectRoot: root, packageDir: root, modules: ['api.js'], symbols: [] } } } } as any;
  app.rm.runs.set(run.id, run);
  await app.listen();
  const address = app.server.address() as { port: number };
  const url = `http://127.0.0.1:${address.port}/api/runs/${run.id}/export-code`;
  try {
    const blocked = await fetch(url, { method: 'POST', body: '{}' });
    assert.equal(blocked.status, 409);
    await blocked.text();
    run.stages[2].status = 'passed';
    const response = await fetch(url, { method: 'POST', body: JSON.stringify({ console: 'return m.value;' }) });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-disposition')!, /Stage3Verification.tsx/);
    assert.match(await response.text(), /return m.value;/);
  } finally {
    await new Promise<void>((resolve) => app.server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
