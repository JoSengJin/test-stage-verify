// 배포 후보 실행 자식 프로세스. 컨슈머 샌드박스(cwd)에 설치된 패키지를 공개 지정자로 import해서
// 실행 모델을 수행한다. 검증 대상 기능을 복사하지 않고 공개 API만 호출한다.
// 주의: 프로세스 분리는 시간 제한·취소·상태 격리를 위한 것이며 보안 격리가 아니다.
import assertLoose from 'node:assert';
import assertStrict from 'node:assert/strict';
import dc from 'node:diagnostics_channel';
import { mock } from 'node:test';
import type {
  ArgRef, CallEvent, CheckResult, ConnectionMode, ExecOutcome, NetEvidence, Scenario, Step, Subject, TypeSchema, Value,
} from '../model.ts';
import { conforms, decodeValue, encodeValue, redactHeaders, redactText, schemaText } from '../util.ts';

export interface MockRoute { method: string; path?: string; pathPrefix?: string; status: number; body?: Value; delayMs?: number; headers?: Record<string, string> }

export type ChildJob =
  | { type: 'scenario'; entryUrl: string; scenario: Scenario; mode: 'doubles' }
  | {
      type: 'consumer';
      entryUrl: string;
      mode: 'mock' | 'stage';
      routes: MockRoute[];
      setup: { export: string; args: Value[] };
      operation: { method: string; args: Value[]; mutation: boolean; returns?: TypeSchema; returnsText?: string };
      /** 원본 테스트에서 유지할 오류 검증(입력 동일 + 협력 객체 미호출 관찰 시) */
      originalErrorChecks: { id: string; op: 'rejects' | 'throws'; module: string; matcher?: any; source: string; loc?: any }[];
      expect?: { resolves?: boolean; rejects?: { name?: string; props?: Record<string, Value> }; minDurationMs?: number };
      followUp?: { method: string; args: Value[]; expect: { path: string; equalsResult?: string; equalsInput?: [number, string] }[] };
    };

const events: CallEvent[] = [];
const network: NetEvidence[] = [];
const logs: string[] = [];
let seq = 0;
const t0 = performance.now();
const secrets = (process.env.STAGE_SECRET_VALUES ?? '').split('\u0000').filter(Boolean);
const now = () => Math.round((performance.now() - t0) * 1000) / 1000;
const assertFor = (m: string) => (m === 'node:assert/strict' ? assertStrict : assertLoose) as any;

function log(msg: string) { logs.push(redactText(`[${now()}ms] ${msg}`, secrets)); }

// ---- 네트워크: 가로채기(mock) / 관찰(stage) / 차단(doubles) ----
function installNetwork(mode: ConnectionMode, routes: MockRoute[]) {
  const realFetch = globalThis.fetch;
  if (mode === 'stage') {
    // 가로채기 해제: fetch를 바꾸지 않는다. undici diagnostics_channel로 실제 요청 발생만 관찰한다.
    const map = new WeakMap<object, NetEvidence>();
    const started = new WeakMap<NetEvidence, number>();
    dc.subscribe('undici:request:create', (m: any) => {
      const r = m.request;
      const headers: Record<string, string> = {};
      const h = r.headers;
      if (Array.isArray(h)) for (let i = 0; i < h.length; i += 2) headers[String(h[i]).toLowerCase()] = String(h[i + 1]);
      const ev: NetEvidence = { seq: ++seq, at: new Date().toISOString(), mode, method: r.method, url: `${r.origin}${r.path}`, intercepted: false, requestHeaders: redactHeaders(headers), source: 'undici:request:create (실제 소켓 요청 생성)' };
      started.set(ev, performance.now());
      map.set(r, ev);
      network.push(ev);
    });
    dc.subscribe('undici:request:headers', (m: any) => {
      const ev = map.get(m.request);
      if (ev) { ev.status = m.response.statusCode; ev.durationMs = Math.round(performance.now() - (started.get(ev) ?? performance.now())); ev.source += ' → undici:request:headers(응답 수신)'; }
    });
    dc.subscribe('undici:request:error', (m: any) => {
      const ev = map.get(m.request);
      if (ev) { ev.error = redactText(String(m.error?.message ?? m.error), secrets); ev.source += ' → undici:request:error'; }
    });
    return;
  }
  globalThis.fetch = (async (input: any, init?: any) => {
    const req = new Request(input, init);
    const url = new URL(req.url);
    const headers: Record<string, string> = {};
    req.headers.forEach((v, k) => { headers[k] = v; });
    let body: Value;
    const text = req.body ? await req.text() : '';
    try { body = text ? JSON.parse(text) : undefined; } catch { body = text; }
    const ev: NetEvidence = { seq: ++seq, at: new Date().toISOString(), mode, method: req.method, url: url.toString(), intercepted: mode === 'mock', blocked: mode === 'doubles', requestHeaders: redactHeaders(headers), requestBody: body === undefined ? undefined : encodeValue(body), source: mode === 'mock' ? 'globalThis.fetch 가로채기(외부로 나가지 않음)' : 'globalThis.fetch 차단(대체 객체 모드)' };
    network.push(ev);
    if (mode === 'doubles') { ev.error = '대체 객체 모드에서 예기치 않은 네트워크 요청'; throw new TypeError('stage: network is disabled in doubles mode'); }
    const route = routes.find((r) => r.method.toUpperCase() === req.method && (r.path ? r.path === url.pathname : r.pathPrefix ? url.pathname.startsWith(r.pathPrefix) : false));
    if (!route) { ev.error = '일치하는 mock 경로 없음'; throw new TypeError(`stage: no mock route for ${req.method} ${url.pathname}`); }
    const start = performance.now();
    if (route.delayMs) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, route.delayMs);
        req.signal.addEventListener('abort', () => { clearTimeout(timer); ev.error = `요청 취소(${req.signal.reason?.name ?? 'abort'})`; reject(req.signal.reason); }, { once: true });
      });
    }
    ev.status = route.status;
    ev.durationMs = Math.round(performance.now() - start);
    return new Response(route.body === undefined ? null : JSON.stringify(route.body), { status: route.status, headers: { 'content-type': 'application/json', ...(route.headers ?? {}) } });
  }) as typeof fetch;
  void realFetch;
}

// ---- 대체 객체(협력 객체) ----
function buildDoubles(sc: Scenario, resolveCtor: (n: string) => any) {
  const doubles: Record<string, any> = {};
  for (const d of sc.doubles) {
    const make = (name: string, behavior: any) => mock.fn((...args: any[]) => {
      events.push({ seq: ++seq, at: now(), kind: 'double-call', name: `${d.varName}${name === '()' ? '' : '.' + name}`, args: args.map((a) => encodeValue(a)) });
      switch (behavior.kind) {
        case 'returns': return decodeValue(behavior.value, resolveCtor);
        case 'resolves': return Promise.resolve().then(() => decodeValue(behavior.value, resolveCtor));
        case 'rejects': return Promise.resolve().then(() => { throw decodeValue(behavior.value, resolveCtor); });
        case 'throws': throw decodeValue(behavior.value, resolveCtor);
        default: return undefined;
      }
    });
    if (d.shape === 'function') doubles[d.id] = make('()', d.methods['()'].behavior);
    else {
      const obj: any = {};
      for (const [m, spec] of Object.entries(d.methods)) obj[m] = make(m, spec.behavior);
      doubles[d.id] = obj;
    }
  }
  return doubles;
}

function hasUnknown(v: any): boolean {
  if (Array.isArray(v)) return v.some(hasUnknown);
  if (v && typeof v === 'object') return v.$stage === 'unknown' || Object.values(v).some(hasUnknown);
  return false;
}

// ---- 시나리오 실행(2단계: 배포 후보 공개 API + 테스트 대체 객체) ----
async function runScenario(job: Extract<ChildJob, { type: 'scenario' }>): Promise<ExecOutcome> {
  const sc = job.scenario;
  installNetwork('doubles', []);
  const api = (await import(job.entryUrl)).default;
  const targetExport = (id: string) => sc.targets.find((t) => t.id === id)?.publicApi.exportName;
  const resolveCtor = (name: string) => {
    if (typeof api[name] !== 'function') throw new Error(`배포 후보 공개 API에 '${name}'이(가) 없음`);
    return api[name];
  };
  const doubles = buildDoubles(sc, resolveCtor);
  const instances: Record<string, any> = {};
  const results: Record<string, { value?: any; error?: any; promise?: Promise<any>; threw?: boolean; done: boolean }> = {};
  const checks: CheckResult[] = [];
  const argVal = (a: ArgRef) => a.kind === 'double' ? doubles[a.id] : a.kind === 'doubleMethod' ? doubles[a.id][a.method] : decodeValue(a.value, resolveCtor);
  const subjectVal = (s: Subject): any => {
    if (s.kind === 'result') {
      let v = results[s.step]?.value;
      for (const k of s.path) v = v?.[k];
      return v;
    }
    const d = doubles[s.double];
    const fn = s.method === '()' ? d : d?.[s.method];
    if (!fn?.mock) throw new Error(`대체 객체 ${s.double}.${s.method} 없음`);
    if (s.kind === 'callCount') return fn.mock.callCount();
    if (s.kind === 'callArgs') return fn.mock.calls[s.call]?.arguments;
    return fn.mock.calls[s.call]?.arguments?.[s.arg];
  };
  let status: ExecOutcome['status'] = 'passed';
  let fatal: any;

  for (const step of sc.steps) {
    try {
      await runStep(step);
    } catch (e: any) {
      status = 'failed';
      fatal = e;
      log(`단계 ${step.id} 중단: ${e?.message}`);
      break;
    }
  }

  async function runStep(step: Step) {
    if (step.kind === 'construct') {
      const name = targetExport(step.target)!;
      const C = api[name];
      if (typeof C !== 'function') {
        checks.push({ id: `${step.id}:contract`, label: `공개 export '${name}' 존재`, status: 'fail', reason: `배포 후보의 공개 API에 '${name}'이(가) 없음(계약 불일치)`, origin: 'public-contract', loc: step.loc });
        throw new Error(`contract: ${name} missing`);
      }
      events.push({ seq: ++seq, at: now(), kind: 'action', name: `new ${name}`, args: step.args.map((a) => a.kind === 'value' ? a.value : { $stage: 'double', id: a.id }) });
      instances[step.instance] = new C(...step.args.map(argVal));
      return;
    }
    if (step.kind === 'call') {
      if (step.args.some((a) => a.kind === 'value' && hasUnknown(a.value))) throw new Error('연결 필요 인자가 있어 실행하지 않음');
      const self = step.instance ? instances[step.instance] : undefined;
      const fn = step.instance ? self?.[step.method!] : api[targetExport(step.target!)!];
      const label = step.instance ? `.${step.method}` : targetExport(step.target!)!;
      if (typeof fn !== 'function') {
        checks.push({ id: `${step.id}:contract`, label: `공개 동작 '${label}' 존재`, status: 'fail', reason: `배포 후보에서 '${label}'이(가) 함수가 아님(계약 불일치)`, origin: 'public-contract', loc: step.loc });
        throw new Error(`contract: ${label} missing`);
      }
      const args = step.args.map(argVal);
      events.push({ seq: ++seq, at: now(), kind: 'action', name: label, args: step.args.map((a) => a.kind === 'value' ? a.value : { $stage: 'double', id: a.id }) });
      const start = performance.now();
      const r: any = { done: false };
      results[step.id] = r;
      try {
        const out = fn.apply(self, args);
        if (step.awaited) { r.value = await out; r.done = true; }
        else if (out && typeof out.then === 'function') { r.promise = out; out.catch(() => {}); }
        else { r.value = out; r.done = true; }
      } catch (e) {
        r.error = e; r.threw = true; r.done = true;
      }
      events.push({ seq: ++seq, at: now(), kind: 'action-result', name: label, result: r.done && !r.threw ? encodeValue(r.value) : undefined, error: r.threw ? encodeValue(r.error) : undefined, durationMs: Math.round(performance.now() - start) });
      if (r.threw && step.awaited) throw r.error; // await한 호출의 예외는 원본 테스트에서도 실패
      return;
    }
    const c = step.check;
    if (c.kind === 'unsupported') {
      checks.push({ id: c.id, label: c.source, status: 'not-run', reason: `미지원 assertion: ${c.reason}`, origin: 'original-test', loc: c.loc });
      status = 'failed';
      return;
    }
    if (c.kind === 'compare') {
      const expected = c.expected === undefined ? undefined : decodeValue(c.expected, resolveCtor);
      if (hasUnknown(c.expected)) { checks.push({ id: c.id, label: c.source, status: 'not-run', reason: '기대값이 연결 필요 상태', origin: 'original-test', loc: c.loc }); status = 'failed'; return; }
      const actual = subjectVal(c.subject);
      try {
        const A = assertFor(c.module);
        if (c.op === 'ok') A.ok(actual); else A[c.op](actual, expected);
        checks.push({ id: c.id, label: c.source, status: 'pass', expected: c.expected, actual: encodeValue(actual), reason: `${c.module}.${c.op} 통과`, origin: 'original-test', loc: c.loc });
      } catch (e: any) {
        checks.push({ id: c.id, label: c.source, status: 'fail', expected: c.expected, actual: encodeValue(actual), reason: redactText(e.message, secrets), origin: 'original-test', loc: c.loc });
        status = 'failed';
      }
      return;
    }
    // error
    const r = results[c.step];
    const matcher = c.matcher === undefined ? undefined
      : c.matcher.kind === 'ctor' ? resolveCtor(targetExport(c.matcher.target)!)
      : c.matcher.kind === 'builtin' ? (globalThis as any)[c.matcher.name]
      : decodeValue(c.matcher.value, resolveCtor);
    const A = assertFor(c.module);
    try {
      if (c.op === 'rejects') {
        const p = r?.promise ?? (r?.threw ? Promise.reject(r.error) : Promise.resolve(r?.value));
        await (matcher === undefined ? A.rejects(p) : A.rejects(p, matcher));
      } else {
        const thrower = () => { if (r?.threw) throw r.error; };
        matcher === undefined ? A.throws(thrower) : A.throws(thrower, matcher);
      }
      checks.push({ id: c.id, label: c.source, status: 'pass', reason: `${c.module}.${c.op} 통과`, origin: 'original-test', loc: c.loc });
    } catch (e: any) {
      checks.push({ id: c.id, label: c.source, status: 'fail', reason: redactText(e.message, secrets), origin: 'original-test', loc: c.loc });
      status = 'failed';
    }
  }

  if (sc.teardown.some((t) => t.kind === 'restoreMocks')) mock.restoreAll();
  if (status === 'passed' && checks.length === 0) { status = 'failed'; log('실행한 검증이 0개 — 통과로 처리하지 않음'); }
  if (network.length) { status = 'failed'; log('대체 객체 모드에서 네트워크 요청이 발생함'); }
  return { status, checks, events, network, logs, error: fatal ? encodeValue(fatal) : undefined };
}

// ---- 컨슈머 경로 실행(2단계 mock 변형 / 3단계 사용자 조작) ----
async function runConsumer(job: Extract<ChildJob, { type: 'consumer' }>): Promise<ExecOutcome> {
  installNetwork(job.mode, job.routes);
  const api = (await import(job.entryUrl)).default;
  const checks: CheckResult[] = [];
  const setupFn = api[job.setup.export];
  if (typeof setupFn !== 'function') {
    checks.push({ id: 'setup', label: `컨슈머 초기화 ${job.setup.export}`, status: 'fail', reason: `배포 후보 공개 API에 '${job.setup.export}' 없음`, origin: 'public-contract' });
    return { status: 'failed', checks, events, network, logs, linkVerdict: 'functional-failure', verdictReason: '초기화 진입점 없음' };
  }
  const resolveCtor = (n: string) => api[n];
  const client = setupFn(...decodeValue(job.setup.args, resolveCtor));
  log(`컨슈머 초기화: ${job.setup.export}(설정) — 인증값은 기록하지 않음`);
  const op = client?.[job.operation.method];
  if (typeof op !== 'function') {
    checks.push({ id: 'operation', label: `공개 동작 ${job.operation.method}`, status: 'fail', reason: '초기화 결과에 해당 메서드가 없음(계약 불일치)', origin: 'public-contract' });
    return { status: 'failed', checks, events, network, logs, linkVerdict: 'functional-failure', verdictReason: '공개 동작 없음' };
  }
  const args = decodeValue(job.operation.args, resolveCtor);
  events.push({ seq: ++seq, at: now(), kind: 'action', name: job.operation.method, args: job.operation.args as Value[] });
  const start = performance.now();
  let value: any; let error: any; let threw = false;
  try { value = await op.apply(client, args); } catch (e) { error = e; threw = true; }
  const durationMs = Math.round(performance.now() - start);
  events.push({ seq: ++seq, at: now(), kind: 'action-result', name: job.operation.method, result: threw ? undefined : encodeValue(value), error: threw ? encodeValue(error) : undefined, durationMs });

  // 원본 오류 검증(유지 조건을 만족한 경우만 부모가 넘김)
  for (const c of job.originalErrorChecks) {
    const A = assertFor(c.module);
    const matcher = c.matcher === undefined ? undefined : c.matcher.kind === 'builtin' ? (globalThis as any)[c.matcher.name] : c.matcher.kind === 'ctor' ? api[c.matcher.exportName] : decodeValue(c.matcher.value, resolveCtor);
    try {
      const p = threw ? Promise.reject(error) : Promise.resolve(value);
      await (matcher === undefined ? A.rejects(p) : A.rejects(p, matcher));
      checks.push({ id: c.id, label: c.source, status: 'pass', reason: '원본 테스트 오류 검증 통과(입력 동일, 협력 객체 미호출 경로)', origin: 'original-test', loc: c.loc });
    } catch (e: any) {
      checks.push({ id: c.id, label: c.source, status: 'fail', reason: redactText(e.message, secrets), origin: 'original-test', loc: c.loc });
    }
  }
  // 공개 타입 계약(성공 반환값)
  if (!threw && job.operation.returns) {
    const errs = conforms(value, job.operation.returns);
    checks.push({ id: 'contract:return', label: `반환값이 공개 타입 ${job.operation.returnsText ?? schemaText(job.operation.returns)}을(를) 만족`, status: errs.length ? 'fail' : 'pass', actual: encodeValue(value), reason: errs.length ? errs.join('; ') : '배포 후보 .d.ts에서 얻은 반환 타입 구조 검사 통과', origin: 'public-contract' });
  }
  // 설정에 선언된 기대(mock 변형)
  const ex = job.expect;
  if (ex?.resolves) checks.push({ id: 'expect:resolves', label: '정상 완료', status: threw ? 'fail' : 'pass', reason: threw ? `예외: ${error?.name}: ${error?.message}` : '정상 완료', origin: 'stage-config' });
  if (ex?.rejects) {
    let ok = threw && (!ex.rejects.name || error?.name === ex.rejects.name);
    if (ok && ex.rejects.props) for (const [k, v] of Object.entries(ex.rejects.props)) if (error?.[k] !== v) ok = false;
    checks.push({ id: 'expect:rejects', label: `거부: ${JSON.stringify(ex.rejects)}`, status: ok ? 'pass' : 'fail', actual: threw ? encodeValue(error) : encodeValue(value), reason: ok ? '기대한 오류로 거부됨' : '기대한 오류가 아님', origin: 'stage-config' });
  }
  if (ex?.minDurationMs !== undefined) checks.push({ id: 'expect:duration', label: `소요 ≥ ${ex.minDurationMs}ms`, status: durationMs >= ex.minDurationMs ? 'pass' : 'fail', actual: durationMs, reason: `${durationMs}ms`, origin: 'stage-config' });
  // 후속 조회(업무 조건)
  if (job.followUp && !threw) {
    try {
      const fArgs = job.followUp.args.map((a: any) => (a && typeof a === 'object' && '$result' in a ? value?.[a.$result] : decodeValue(a)));
      events.push({ seq: ++seq, at: now(), kind: 'action', name: `${job.followUp.method}(후속 조회)`, args: fArgs.map((x: any) => encodeValue(x)) });
      const detail = await client[job.followUp.method](...fArgs);
      events.push({ seq: ++seq, at: now(), kind: 'action-result', name: job.followUp.method, result: encodeValue(detail) });
      for (const e of job.followUp.expect) {
        const actual = detail?.[e.path];
        const expected = e.equalsResult !== undefined ? value?.[e.equalsResult] : e.equalsInput ? args[e.equalsInput[0]]?.[e.equalsInput[1]] : undefined;
        checks.push({ id: `followup:${e.path}`, label: `후속 조회 ${job.followUp.method}.${e.path} = ${e.equalsResult ? '결과.' + e.equalsResult : '입력.' + e.equalsInput?.join('.')}`, status: actual === expected ? 'pass' : 'fail', expected: encodeValue(expected), actual: encodeValue(actual), reason: actual === expected ? '일치' : '불일치', origin: 'stage-config' });
      }
    } catch (e: any) {
      checks.push({ id: 'followup', label: `후속 조회 ${job.followUp.method}`, status: 'fail', reason: `후속 조회 실패: ${redactText(String(e?.message), secrets)}`, origin: 'stage-config', actual: encodeValue(e) });
    }
  }

  const failed = checks.some((c) => c.status === 'fail');
  const passedAny = checks.some((c) => c.status === 'pass');
  const status: ExecOutcome['status'] = !failed && passedAny ? 'passed' : 'failed';
  if (!passedAny) log('적용 가능한 자동 검증이 없어 통과로 판정하지 않음');
  const out: ExecOutcome = { status, checks, events, network, logs, returned: threw ? undefined : encodeValue(value), error: threw ? encodeValue(error) : undefined, durationMs };
  if (job.mode === 'stage') Object.assign(out, verdict(threw, error, failed, passedAny, job.operation.mutation));
  return out;
}

/** 실제 연계 판정. 관찰한 오류·응답 근거로만 분류한다. */
function verdict(threw: boolean, error: any, failed: boolean, passedAny: boolean, mutation: boolean): Pick<ExecOutcome, 'linkVerdict' | 'verdictReason'> {
  const statuses = network.map((n) => n.status).filter((s): s is number => s !== undefined);
  const timeoutLike = threw && (error?.name === 'TimeoutError' || error?.name === 'AbortError');
  if (timeoutLike) {
    return mutation
      ? { linkVerdict: 'outcome-unknown', verdictReason: `변경 요청이 시간 초과(${error?.name}) — 서버 처리 여부 불명. 자동 재전송하지 않음. 후속 조회로 확인 필요` }
      : { linkVerdict: 'environment-blocked', verdictReason: `조회 요청 시간 초과(${error?.name})` };
  }
  if (statuses.some((s) => s === 401 || s === 403 || s === 407)) return { linkVerdict: 'environment-blocked', verdictReason: `인증/권한 거부 응답(${statuses.join(', ')}) 관찰` };
  const netErr = network.find((n) => n.error && n.status === undefined);
  if (threw && (netErr || /fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN/.test(String(error?.message) + String(error?.cause?.code)))) {
    return { linkVerdict: 'environment-blocked', verdictReason: `서버 연결 실패: ${redactText(String(error?.cause?.code ?? error?.message), secrets)}` };
  }
  if (failed) return { linkVerdict: 'functional-failure', verdictReason: '자동 검증 실패' };
  if (!passedAny) return { linkVerdict: undefined, verdictReason: '판정 없음: 적용 가능한 자동 검증이 없음(입력 변경 등) — 통과로 판정하지 않음, 수동 확인 필요' };
  return { linkVerdict: 'pass', verdictReason: `자동 검증 통과(실제 요청 ${network.length}건 관찰)` };
}

process.on('message', async (job: ChildJob) => {
  let out: ExecOutcome;
  try {
    out = job.type === 'scenario' ? await runScenario(job) : await runConsumer(job);
  } catch (e: any) {
    out = { status: 'failed', checks: [], events, network, logs: [...logs, redactText(`실행기 오류: ${e?.stack ?? e}`, secrets)], error: encodeValue(e) };
  }
  out = JSON.parse(redactText(JSON.stringify(out), secrets));
  process.send!({ type: 'result', outcome: out }, () => process.exit(0));
});
