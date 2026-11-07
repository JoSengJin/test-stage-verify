import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStageServer } from '../src/server.ts';
import { SAMPLE } from './helpers.ts';

test('프로젝트 없이 시작해 화면 API로 등록·저장·해제한다', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-proj-'));
  const start = async () => { const s = createStageServer({ projects: [], dataDir, port: 0 }); await s.listen(); return s; };
  const call = async (s: Awaited<ReturnType<typeof start>>, method: string, body?: unknown) => {
    const port = (s.server.address() as any).port;
    const r = await fetch(`http://127.0.0.1:${port}/api/projects`, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, json: await r.json() as any };
  };
  let s = await start();
  assert.equal((await call(s, 'POST', { path: path.join(dataDir, 'nope') })).status, 400);
  assert.equal((await call(s, 'POST', { path: dataDir })).status, 400); // package.json 없음
  const ok = await call(s, 'POST', { path: SAMPLE });
  assert.deepEqual(ok.json.projects, [SAMPLE]);
  s.server.close();
  s = await start(); // 재시작 후에도 유지
  assert.deepEqual(s.listProjects(), [SAMPLE]);
  assert.deepEqual((await call(s, 'DELETE', { path: SAMPLE })).json.projects, []);
  assert.equal((await call(s, 'DELETE', { path: SAMPLE })).status, 404);
  s.server.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});
