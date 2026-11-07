import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { projectInfo } from '../src/analysis/project.ts';

const mk = (rootPkg: object, distPkg?: object) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-distpkg-'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(rootPkg));
  if (distPkg) {
    fs.mkdirSync(path.join(root, 'dist'));
    fs.writeFileSync(path.join(root, 'dist', 'package.json'), JSON.stringify(distPkg));
  }
  return root;
};

test('루트에 exports·main이 없으면 dist/package.json의 exports를 공개 진입점으로 쓴다', () => {
  const root = mk({ name: 'pkg', version: '1.0.0' }, { name: 'pkg', version: '1.0.0', exports: { '.': './index.js', './lib': './lib/index.js' } });
  const p = projectInfo(root);
  assert.equal(p.packageDir, path.join(root, 'dist'));
  assert.deepEqual(p.publicEntries.map((e) => [e.specifier, e.distFile]), [['pkg', path.join(root, 'dist/index.js')], ['pkg/lib', path.join(root, 'dist/lib/index.js')]]);
  fs.rmSync(root, { recursive: true, force: true });
});

test('루트에 exports가 있으면 dist는 보지 않는다', () => {
  const root = mk({ name: 'pkg', version: '1.0.0', exports: './a.js' }, { name: 'pkg', exports: './b.js' });
  const p = projectInfo(root);
  assert.equal(p.packageDir, undefined);
  assert.equal(p.publicEntries[0].distFile, path.join(root, 'a.js'));
  fs.rmSync(root, { recursive: true, force: true });
});

test('dist/package.json이 없거나 exports가 없으면 기존처럼 비어 있다', () => {
  const root = mk({ name: 'pkg', version: '1.0.0' }, { name: 'pkg' });
  const p = projectInfo(root);
  assert.equal(p.packageDir, undefined);
  assert.deepEqual(p.publicEntries, []);
  fs.rmSync(root, { recursive: true, force: true });
});
