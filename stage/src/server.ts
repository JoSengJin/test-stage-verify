// 스테이지 서버: UI 정적 파일, 분석·실행 API, SSE 상태 전달. node:http만 사용한다.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeTestFile } from './analysis/analyze.ts';
import { listProjectFiles } from './analysis/project.ts';
import { HttpError, RunManager } from './exec/runs.ts';
import { buildReport, reportHtml } from './report.ts';
import { Store } from './store.ts';
import { checkTarget, normalizeProfileDoc } from './profiles.ts';
import { buildLiveConsole, liveConsoleHtml, liveFrameHtml } from './exec/real-env.ts';
import { exportStage3Component } from './exec/code-export.ts';
import { connectedScenarios, connectedConsoleHtml, runConnectedNode } from './exec/connected-scenarios.ts';
import { ScenarioTargets } from './exec/scenario-targets.ts';
import { wireModuleContracts } from './exec/module-contracts.ts';
import { CORS, PlaygroundManager, frameHtml } from './playground/manager.ts';
import { generateHookSource, isPlayable } from './playground/source.ts';
import { EXEC_LABEL, LINK_LABEL, MODE_LABEL, RULES_VERSION, SUPPORT_LABEL, FRAMEWORK_VERSION, type AnalysisResult } from './model.ts';
import { sha256 } from './util.ts';
import { hostAllowed, isSafeConnectionExpression, originAllowed } from './gate.ts';

const UI_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui');
const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

export interface ServerOptions {
  projects: string[]; dataDir: string; port: number; host?: string; env?: NodeJS.ProcessEnv; concurrency?: number;
  /** 서버 재시작 요청 처리(감독 프로세스가 있을 때만 제공). 응답을 보낸 뒤 호출된다. */
  restart?: () => void;
}

export function createStageServer(o: ServerOptions) {
  const startedAt = new Date().toISOString();
  const store = new Store(o.dataDir);
  const pg = new PlaygroundManager(o.env ?? process.env);
  const clients = new Set<http.ServerResponse>();
  const targets = new ScenarioTargets();
  const rm = new RunManager({
    store, env: o.env, concurrency: o.concurrency,
    onChange: (run) => { const msg = `event: run\ndata: ${JSON.stringify(run)}\n\n`; for (const c of clients) c.write(msg); },
  });
  // 프로젝트는 시작 옵션(선택)과 화면에서 등록한 저장 목록을 합친다. 화면 등록은 저장되어 재시작 후에도 유지된다.
  const projects: string[] = [];
  for (const p of [...o.projects, ...store.loadProjects()]) { const r = path.resolve(p); if (!projects.includes(r)) projects.push(r); }
  const persist = () => store.saveProjects(projects);
  const upgradeAnalysis = (analysis: AnalysisResult | undefined) => {
    const calls = analysis?.wiring?.tests.flatMap(test => test.calls) ?? [];
    if (analysis?.project && calls.some(call => call.hook === undefined)) wireModuleContracts(analysis.project, path.join(analysis.project.root, analysis.input.linkedPath || analysis.input.fileName), calls);
    return analysis;
  };

  function linkDrop(fileName: string, content: string) {
    const sha = sha256(content);
    const sameName: string[] = [];
    for (const root of projects) {
      for (const f of listProjectFiles(root)) {
        if (sha256(fs.readFileSync(f)) === sha) return { root, file: f, evidence: `내용 sha256 일치: ${path.relative(root, f)} (프로젝트 ${root})` };
        if (path.basename(f) === path.basename(fileName)) sameName.push(path.relative(root, f));
      }
    }
    return { sha, evidence: sameName.length ? `같은 이름 파일(${sameName.join(', ')})은 있으나 내용이 다름 — 드롭한 파일이 프로젝트 작업본과 다름` : '등록된 프로젝트에 같은 내용의 파일이 없음' };
  }

  async function body(req: http.IncomingMessage, limit = 2_000_000): Promise<any> {
    let raw = '';
    for await (const c of req) { raw += c; if (raw.length > limit) throw new HttpError(413, '요청이 너무 큼'); }
    try { return raw ? JSON.parse(raw) : {}; } catch { throw new HttpError(400, 'JSON 형식 아님'); }
  }

  const send = (res: http.ServerResponse, status: number, data: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(data));
  };

  // 판정·실행 API 보호: 허용된 Host(DNS rebinding 방어)와, 상태 변경 요청의 허용된 Origin(교차 출처 위조 방어)만 받는다.
  const extraHosts = String((o.env ?? process.env).STAGE_ALLOWED_HOSTS ?? '').split(',');
  const liveBundles = new Map<string, string>();
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean);
    try {
      if (!hostAllowed(req.headers.host, extraHosts)) throw new HttpError(403, '허용되지 않은 Host입니다. localhost로 접속하거나 STAGE_ALLOWED_HOSTS에 등록하세요.');
      if (req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS' && typeof req.headers['x-stage-session'] !== 'string' && !originAllowed(req.headers.origin, extraHosts)) throw new HttpError(403, '허용되지 않은 Origin의 상태 변경 요청입니다.');
      // 가상 화면의 실제 호출 프록시: 세션 헤더가 있는 요청은 경로·메서드와 관계없이(스테이지 자신의 경로와 같아도) 프록시가 받는다.
      const pgSession = req.headers['x-stage-session'];
      if (typeof pgSession === 'string') return await pg.proxy(req, res, pgSession, req.url ?? '/');
      if (req.method === 'OPTIONS' && /x-stage-session/i.test(String(req.headers['access-control-request-headers'] ?? ''))) {
        res.writeHead(204, { ...CORS, 'access-control-allow-headers': String(req.headers['access-control-request-headers']) });
        return res.end();
      }
      if (req.method === 'GET' && !url.pathname.startsWith('/api/')) {
        const f = path.join(UI_DIR, url.pathname === '/' ? 'index.html' : path.normalize(url.pathname).replace(/^(\.\.[/\\])+/, ''));
        if (!f.startsWith(UI_DIR) || !fs.existsSync(f)) return send(res, 404, { error: 'not found' });
        res.writeHead(200, { 'content-type': MIME[path.extname(f)] ?? 'application/octet-stream' });
        return res.end(fs.readFileSync(f));
      }
      if (req.method === 'GET' && url.pathname === '/api/meta') {
        return send(res, 200, {
          frameworkVersion: FRAMEWORK_VERSION, rulesVersion: RULES_VERSION, projects, labels: { EXEC_LABEL, LINK_LABEL, MODE_LABEL, SUPPORT_LABEL },
          stageTarget: rm.stageTarget(projects[0] ? rm.stageConfig(projects[0]) : undefined),
          concurrency: rm.concurrency, timeouts: rm.timeouts,
          // 재시작 여부 판단용: 서버 시작 시각이 바뀌면 새 프로세스다.
          startedAt, canRestart: !!o.restart,
        });
      }
      if (req.method === 'POST' && url.pathname === '/api/restart') {
        if (!o.restart) throw new HttpError(409, '감독 프로세스 없이 시작되어 재시작할 수 없음 — npm run stage 로 시작하세요');
        const active = [...rm.runs.values()].flatMap((r) => r.jobs).filter((j) => j.status === 'queued' || j.status === 'running').length;
        send(res, 202, { restarting: true, interruptedJobs: active });
        // 응답이 나간 뒤 종료한다. 진행 중이던 작업은 다음 시작 때 "서버 재시작으로 중단됨"으로 기록된다.
        res.on('finish', () => setTimeout(() => o.restart!(), 100));
        return;
      }
      if (url.pathname === '/api/projects' && (req.method === 'POST' || req.method === 'DELETE')) {
        const b = await body(req);
        if (typeof b.path !== 'string' || !b.path.trim()) throw new HttpError(400, 'path 필요');
        const root = path.resolve(b.path.trim());
        if (req.method === 'DELETE') {
          const i = projects.indexOf(root);
          if (i < 0) throw new HttpError(404, '등록되지 않은 프로젝트');
          projects.splice(i, 1); persist();
        } else {
          if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new HttpError(400, `디렉터리가 없음: ${root}`);
          if (!fs.existsSync(path.join(root, 'package.json'))) throw new HttpError(400, `package.json이 없음: ${root}`);
          if (!projects.includes(root)) { projects.push(root); persist(); }
        }
        return send(res, 200, { projects, stageTarget: rm.stageTarget(projects[0] ? rm.stageConfig(projects[0]) : undefined) });
      }
      // ---- 가상 화면: 세션 생성, 번들, 화면 HTML, 요청 기록 ----
      if (req.method === 'POST' && url.pathname === '/api/playground') {
        const b = await body(req);
        const root = path.resolve(String(b.project ?? ''));
        if (!projects.includes(root)) throw new HttpError(404, '등록되지 않은 프로젝트');
        const doc = store.loadProfileDoc(root);
        const profile = doc.profiles.find((p) => p.name === (b.profile ?? doc.active));
        if (!profile) throw new HttpError(404, '프로필 없음');
        const mode = b.binding === 'double' ? 'mock' : profile.mode;
        const s = pg.create(root, profile, mode, rm.stageConfig(root)?.mock?.routes ?? []);
        let source: string | undefined;
        let playable = false;
        if (b.analysisId) {
          const analysis = upgradeAnalysis(rm.analyses.get(String(b.analysisId)));
          const test = analysis?.wiring?.tests.find((t) => t.id === b.testId);
          const call = test?.calls.find((c) => c.id === b.callId);
          if (!call || !test) throw new HttpError(404, '호출 지점 없음');
          playable = isPlayable(call);
          if (playable) source = generateHookSource({ call, testTitle: test.path.join(' › '), sessionId: s.id });
        }
        return send(res, 201, { id: s.id, mode, profile: profile.name, check: mode === 'stage' ? checkTarget(profile) : { ok: true }, playable, source });
      }
      if (parts[0] === 'api' && parts[1] === 'playground' && parts[2]) {
        if (req.method === 'GET' && parts[3] === 'log') return send(res, 200, pg.get(parts[2]).log);
        if (req.method === 'GET' && parts[3] === 'frame') {
          const js = pg.get(parts[2]).js;
          if (!js) throw new HttpError(404, '아직 빌드된 화면이 없음');
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
          return res.end(frameHtml(js, `http://${req.headers.host}`));
        }
        if (req.method === 'POST' && parts[3] === 'bundle') return send(res, 200, await pg.bundle(parts[2], (await body(req)).code));
      }
      if (url.pathname === '/api/profiles' && (req.method === 'GET' || req.method === 'PUT')) {
        const b = req.method === 'PUT' ? await body(req) : {};
        const root = path.resolve(String(req.method === 'PUT' ? b.project ?? '' : url.searchParams.get('project') ?? ''));
        if (!projects.includes(root)) throw new HttpError(404, '등록되지 않은 프로젝트');
        const doc = req.method === 'PUT' ? normalizeProfileDoc(b.doc) : store.loadProfileDoc(root);
        if (req.method === 'PUT') store.saveProfileDoc(root, doc);
        return send(res, 200, { doc, checks: Object.fromEntries(doc.profiles.map((p) => [p.name, checkTarget(p)])) });
      }
      if (req.method === 'GET' && url.pathname === '/api/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
        res.write(': connected\n\n');
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return;
      }
      if (req.method === 'POST' && url.pathname === '/api/analyze') {
        const b = await body(req);
        if (typeof b.fileName !== 'string' || typeof b.content !== 'string') throw new HttpError(400, 'fileName, content 필요');
        const link = linkDrop(b.fileName, b.content);
        let a;
        if ('root' in link && link.root) a = analyzeTestFile({ testFile: link.file, projectRoot: link.root, fileName: b.fileName, linked: true, linkEvidence: link.evidence });
        else {
          // 프로젝트 연결이 없으면 드롭한 내용만으로 분석한다(import 해석 불가 항목이 표시됨). 실행은 하지 않는다.
          const f = store.dropFile(sha256(b.content), b.fileName);
          fs.writeFileSync(f, b.content);
          a = analyzeTestFile({ testFile: f, fileName: b.fileName, linked: false, linkEvidence: link.evidence });
        }
        rm.addAnalysis(a);
        return send(res, 200, a);
      }
      if (parts[0] === 'api' && parts[1] === 'analyses' && parts[2] && req.method === 'GET') {
        const a = upgradeAnalysis(rm.analyses.get(parts[2]));
        return a ? send(res, 200, a) : send(res, 404, { error: '분석 없음' });
      }
      if (req.method === 'GET' && url.pathname === '/api/runs') {
        return send(res, 200, [...rm.runs.values()].map((r) => ({ id: r.id, createdAt: r.createdAt, rerunOf: r.rerunOf, testFile: r.testFile, stages: r.stages.map((s) => s.status), candidate: r.candidate?.id })).reverse());
      }
      if (req.method === 'POST' && url.pathname === '/api/runs') {
        const b = await body(req);
        return send(res, 201, rm.createRun(String(b.analysisId)));
      }
      if (parts[0] === 'api' && parts[1] === 'runs' && parts[2]) {
        const id = parts[2];
        const run = rm.runs.get(id);
        if (!run) throw new HttpError(404, '실행 없음');
        if (req.method === 'GET' && parts.length === 3) return send(res, 200, run);
        if (req.method === 'POST' && parts[3] === 'cancel') return send(res, 200, rm.cancel(id));
        if (req.method === 'POST' && parts[3] === 'rerun') return send(res, 201, rm.rerun(id));
        if (req.method === 'POST' && parts[3] === 'interactions') {
          const b = await body(req);
          if (b.mode !== 'stage' && b.mode !== 'mock') throw new HttpError(400, 'mode는 stage 또는 mock');
          if (!Array.isArray(b.args)) throw new HttpError(400, 'args 배열 필요');
          const job = rm.interact(id, { scenarioId: String(b.scenarioId), stepId: b.stepId, mode: b.mode, args: b.args, routes: Array.isArray(b.routes) ? b.routes : undefined });
          job.catch(() => {});
          const settled = await Promise.race([job, new Promise((r) => setTimeout(() => r(null), 50))]);
          return send(res, 202, settled ?? { accepted: true });
        }
        if (req.method === 'POST' && parts[3] === 'exports-check') {
          const job = rm.checkExports(id);
          job.catch(() => {});
          const settled = await Promise.race([job, new Promise((r) => setTimeout(r, 50))]);
          return send(res, 202, settled ?? { accepted: true });
        }
        if (req.method === 'POST' && parts[3] === 'replay') {
          const job = rm.replay(id);
          job.catch(() => {});
          const settled = await Promise.race([job, new Promise((r) => setTimeout(r, 50))]);
          return send(res, 202, settled ?? { accepted: true });
        }
        // ---- 실제 함수 직접 실행: 배포 후보 번들을 격리된 origin의 프레임에서 실제 window.sessionStorage로 실행 ----
        if (req.method === 'GET' && parts[3] === 'live' && parts[4]) {
          const live = run.realEnv?.live;
          const sc = live?.scenarios[parts[4]];
          if (!live || !sc) throw new HttpError(404, '직접 실행할 수 있는 시나리오 없음');
          const html = await liveFrameHtml({ runId: id, sc, scenarioId: parts[4], argsText: url.searchParams.get('args') ?? undefined, seedText: url.searchParams.get('seed') ?? undefined });
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
          return res.end(html);
        }
        if (req.method === 'GET' && parts[3] === 'live-console') {
          const live = run.realEnv?.live;
          if (!live?.console) throw new HttpError(404, '직접 호출할 배포 후보 모듈 없음');
          if (run.connected && run.connected.definition.presentationVersion !== 7) {
            const testFile = path.join(run.project.root, run.testFile.path);
            if (sha256(fs.readFileSync(testFile)) !== run.connected.definition.sourceHash) throw new HttpError(409, '테스트 파일이 변경되었습니다. 배포 후보를 다시 실행하세요.');
            const fromDir = rm.analyses.get(run.analysisId)?.project?.packageDir ?? run.project.root;
            const updated = connectedScenarios(testFile, fromDir, live.console.packageDir);
            for (const scenario of updated.scenarios) {
              if (run.connected.definition.scenarios.find(old => old.id === scenario.id)?.code !== scenario.code) delete run.connected.results[scenario.id];
            }
            run.connected.definition = { ...run.connected.definition, scenarios: updated.scenarios, presentationVersion: updated.presentationVersion };
          }
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
          return res.end(run.connected ? connectedConsoleHtml({ runId: id, jobId: run.connected.jobId, definition: run.connected.definition, saved: run.connected.results }) : liveConsoleHtml({ runId: id, symbols: live.console.symbols, hint: url.searchParams.get('hint') ?? undefined }));
        }
        if (parts[3] === 'connected-targets') {
          if (!run.connected || run.stages[2].status !== 'running') throw new HttpError(409, '3단계 실제 연결을 진행 중인 실행이 아닙니다.');
          if (req.method === 'POST' && !parts[4]) {
            const data = await body(req);
            const scenario = run.connected.definition.scenarios.find(s => s.id === data.scenarioId);
            if (!scenario?.network) throw new HttpError(400, '서버 연결 시나리오가 없습니다.');
            const origin = `http://${req.headers.host}`;
            return send(res, 201, await targets.create(id, scenario.network, origin));
          }
          if (req.method === 'POST' && parts[4] && parts[5] === 'emit') {
            const data = await body(req);
            if (typeof data.data !== 'string') throw new HttpError(400, 'SSE 데이터는 문자열이어야 합니다.');
            targets.emit(id, parts[4], data.data);
            return send(res, 200, { sent: true });
          }
          if (req.method === 'DELETE' && parts[4]) return send(res, 200, targets.close(id, parts[4]));
          throw new HttpError(404, '검증 서버 작업 없음');
        }
        if (req.method === 'POST' && parts[3] === 'connected-scenario') {
          const data = await body(req);
          if (data.type === 'node') {
            const configured = run.connected;
            const live = run.realEnv?.live;
            if (!configured || !live?.console || configured.jobId !== data.jobId || run.stages[2].status !== 'running' || !configured.definition.scenarios.some((s) => s.id === data.scenarioId)) throw new HttpError(409, '실행할 실제 협력자 시나리오가 없습니다.');
            if (typeof data.input?.code !== 'string' || !data.input.connections || !data.input.values) throw new HttpError(400, '실제 연결 구성이 잘못되었습니다.');
            // 서버가 직접 실행하는 경로이므로 임의 코드를 받지 않는다: 코드는 분석이 만든 원본과 같아야 하고, 연결식은 모듈·전역 API 참조/호출만 허용한다.
            const original = configured.definition.scenarios.find((s) => s.id === data.scenarioId)!;
            if (data.input.code !== original.code) throw new HttpError(403, '서버(Node)에서는 수정된 검증 코드를 실행하지 않습니다. 원본 코드로 실행하세요.');
            for (const expression of Object.values(data.input.connections)) if (!isSafeConnectionExpression(String(expression))) throw new HttpError(403, `서버에서 실행할 수 없는 연결식입니다: ${String(expression).slice(0, 80)}`);
            const result = await runConnectedNode({ dir: live.dir, console: live.console, scenario: configured.definition, input: data.input, signal: AbortSignal.timeout(65_000) });
            return send(res, 200, { result });
          }
          rm.recordConnected(id, data, { userAgent: String(req.headers['user-agent'] ?? '') });
          return send(res, 200, { results: run.connected?.results, connected: run.connected });
        }
        if (req.method === 'GET' && parts[3] === 'live-console.js') {
          const live = run.realEnv?.live;
          if (!live?.console) throw new HttpError(404, '직접 호출할 배포 후보 모듈 없음');
          // 같은 실행의 번들은 모듈이 바뀌지 않으므로 한 번만 만든다(요청마다 esbuild를 돌리지 않음).
          let f = liveBundles.get(live.dir);
          if (!f || !fs.existsSync(f)) { f = await buildLiveConsole(live.dir, live.console); liveBundles.set(live.dir, f); }
          res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
          return res.end(fs.readFileSync(f));
        }
        if (req.method === 'GET' && parts[3] === 'live-file' && parts[4]) {
          const live = run.realEnv?.live;
          if (!live || !/^C\d+\.js$/.test(parts[4])) throw new HttpError(404, '파일 없음');
          res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-store' });
          return res.end(fs.readFileSync(path.join(live.dir, parts[4])));
        }
        if (req.method === 'POST' && parts[3] === 'export-code') {
          if (!['passed', 'failed'].includes(run.stages[2].status)) throw new HttpError(409, '3단계 판정을 확정한 뒤 내보낼 수 있습니다.');
          const drafts = await body(req);
          if (drafts.console !== undefined && typeof drafts.console !== 'string') throw new HttpError(400, 'console은 코드 문자열이어야 합니다.');
          if (drafts.scenarios !== undefined && (!drafts.scenarios || typeof drafts.scenarios !== 'object' || Array.isArray(drafts.scenarios) || Object.entries(drafts.scenarios).some(([id, value]: [string, any]) => !Object.hasOwn(run.realEnv?.live?.scenarios ?? {}, id) || !value || typeof value.args !== 'string' || typeof value.seed !== 'string'))) throw new HttpError(400, '시나리오 입력값이 올바르지 않습니다.');
          const playground: { code: string; sessionId: string }[] = [];
          if (drafts.playground !== undefined && (!drafts.playground || typeof drafts.playground !== 'object' || Array.isArray(drafts.playground))) throw new HttpError(400, '가상 화면 코드가 올바르지 않습니다.');
          for (const [sessionId, code] of Object.entries(drafts.playground ?? {})) {
            const session = pg.get(sessionId);
            if (session.root !== run.project.root || typeof code !== 'string') throw new HttpError(400, '가상 화면의 프로젝트 또는 코드가 올바르지 않습니다.');
            playground.push({ code, sessionId });
          }
          const { source, extension } = await exportStage3Component({ live: run.realEnv?.live, drafts, playground, projectRoot: run.project.root, connected: run.connected });
          res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8', 'content-disposition': `attachment; filename="Stage3Verification.${extension}"`, 'cache-control': 'no-store' });
          return res.end(source);
        }
        if (req.method === 'POST' && parts[3] === 'complete-stage3') {
          const b = await body(req);
          const by = typeof b.operator === 'string' ? b.operator.trim() : '';
          if (by.length < 2) throw new HttpError(400, '확정자 이름(operator)을 2자 이상 입력하세요. 누가 판정했는지가 보고서에 기록됩니다.');
          if (b.confirm !== true) throw new HttpError(400, '확정 확인(confirm)이 필요합니다.');
          return send(res, 200, rm.completeStage3(id, { by, userAgent: String(req.headers['user-agent'] ?? '') }));
        }
        if (req.method === 'POST' && parts[3] === 'manual') return send(res, 201, rm.addManual(id, await body(req)));
        if (req.method === 'GET' && parts[3] === 'report') {
          const a = rm.analyses.get(run.analysisId)!;
          const r = buildReport(run, a);
          if (url.searchParams.get('format') === 'html') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(reportHtml(r)); }
          return send(res, 200, r);
        }
      }
      send(res, 404, { error: 'no route' });
    } catch (e: any) {
      if (e instanceof HttpError) return send(res, e.status, { error: e.message });
      send(res, 500, { error: String(e?.message ?? e) });
    }
  });
  server.on('close', () => targets.dispose());
  return { server, rm, store, listProjects: () => [...projects], listen: () => new Promise<void>((r) => server.listen(o.port, o.host ?? '127.0.0.1', () => r())) };
}
