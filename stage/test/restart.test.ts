// 서버 재시작: API, 감독 프로세스(종료 코드 75 → 재시작), 코드 변경 감시(--watch), 부모 종료 시 자식 정리.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createStageServer } from '../src/server.ts';
import { HERE } from './helpers.ts';

const CLI = path.join(HERE, '..', 'src', 'cli.ts');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise<number>((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as net.AddressInfo).port; s.close(() => resolve(p)); }); });
const meta = async (port: number) => { try { return (await (await fetch(`http://127.0.0.1:${port}/api/meta`)).json()) as any; } catch { return null; } };
async function until<T>(fn: () => Promise<T | null | false>, ms = 15000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) throw new Error('시간 초과'); await sleep(150); }
}

describe('재시작 API', () => {
  it('감독 프로세스가 있으면 응답 후 재시작 콜백을 부르고, 없으면 409로 거절한다', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-restart-'));
    let called = 0;
    const withRestart = createStageServer({ projects: [], dataDir, port: 0, restart: () => { called++; } });
    const without = createStageServer({ projects: [], dataDir, port: 0 });
    await Promise.all([withRestart.listen(), without.listen()]);
    const base = (s: typeof withRestart) => `http://127.0.0.1:${(s.server.address() as net.AddressInfo).port}`;
    const m1 = await (await fetch(`${base(withRestart)}/api/meta`)).json() as any;
    assert.equal(m1.canRestart, true);
    assert.ok(m1.startedAt);
    assert.equal(((await (await fetch(`${base(without)}/api/meta`)).json()) as any).canRestart, false);
    const r = await fetch(`${base(withRestart)}/api/restart`, { method: 'POST' });
    assert.equal(r.status, 202);
    assert.equal(((await r.json()) as any).restarting, true);
    await until(async () => called === 1);
    const r2 = await fetch(`${base(without)}/api/restart`, { method: 'POST' });
    assert.equal(r2.status, 409);
    assert.match(((await r2.json()) as any).error, /감독 프로세스/);
    withRestart.server.close(); without.server.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
});

describe('감독 프로세스', () => {
  it('화면의 재시작 요청으로 새 프로세스가 같은 포트에 다시 뜨고, 감독을 종료하면 서버도 사라진다', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-sup-'));
    const port = await freePort();
    const sup = spawn(process.execPath, [CLI, '--port', String(port), '--data', dataDir], { stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    sup.stdout.on('data', (d) => { log += d; });
    try {
      const first = await until(() => meta(port));
      assert.equal(first.canRestart, true);
      const r = await fetch(`http://127.0.0.1:${port}/api/restart`, { method: 'POST' });
      assert.equal(r.status, 202);
      const second = await until(async () => { const m = await meta(port); return m && m.startedAt !== first.startedAt ? m : null; });
      assert.ok(second.startedAt > first.startedAt);
      assert.match(log, /서버를 다시 시작합니다/);
      sup.kill('SIGTERM');
      await until(async () => (await meta(port)) === null, 10000);
    } finally {
      sup.kill('SIGKILL');
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('--watch는 stage/src 파일이 바뀌면 자동으로 다시 시작한다', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-watch-'));
    const port = await freePort();
    const sup = spawn(process.execPath, [CLI, '--watch', '--port', String(port), '--data', dataDir], { stdio: ['ignore', 'pipe', 'pipe'] });
    let log = '';
    sup.stdout.on('data', (d) => { log += d; });
    const touched = path.join(HERE, '..', 'src', 'util.ts');
    try {
      const first = await until(() => meta(port));
      const now = new Date();
      fs.utimesSync(touched, now, now); // 내용은 그대로, 변경 시각만 갱신
      const second = await until(async () => { const m = await meta(port); return m && m.startedAt !== first.startedAt ? m : null; });
      assert.ok(second);
      assert.match(log, /코드 변경 감지: util\.ts/);
    } finally {
      sup.kill('SIGKILL');
      await sleep(300);
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it('감독 없이(STAGE_NO_SUPERVISOR) 시작하면 재시작을 제공하지 않는다', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'stage-nosup-'));
    const port = await freePort();
    const p = spawn(process.execPath, [CLI, '--port', String(port), '--data', dataDir], { env: { ...process.env, STAGE_NO_SUPERVISOR: '1' }, stdio: 'ignore' });
    try {
      const m = await until(() => meta(port));
      assert.equal(m.canRestart, false);
    } finally {
      p.kill('SIGKILL');
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
