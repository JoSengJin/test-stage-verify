// 가상 화면 세션: 연결 프로필 스냅샷, 실제 호출 프록시, 번들 빌드, 요청 기록.
// 가상 화면(iframe)은 브라우저 안에서 돌기 때문에 실제 서버 호출은 반드시 이 프록시를 거친다.
// 프록시가 허용 호스트·변경 요청 허용 여부를 검사하고, 환경변수로 참조한 헤더 값을 서버에서만 채운다.
import crypto from 'node:crypto';
import type http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HttpError } from '../exec/runs.ts';
import type { MockRoute } from '../exec/child.ts';
import { checkTarget, type Profile } from '../profiles.ts';
import { redactHeaders, redactText } from '../util.ts';

export interface ProxyLogEntry {
  seq: number;
  at: string;
  mode: 'mock' | 'stage';
  method: string;
  url: string;
  status?: number;
  durationMs?: number;
  /** 보내지 않은 이유(허용 호스트·변경 요청 차단, 환경변수 미설정 등) */
  blocked?: string;
  error?: string;
  requestHeaders: Record<string, string>;
  requestBody?: string;
}

export interface PgSession {
  id: string;
  root: string;
  profile: Profile;
  mode: 'mock' | 'stage';
  mockRoutes: MockRoute[];
  log: ProxyLogEntry[];
  createdAt: string;
  /** 마지막으로 빌드한 화면 번들 */
  js?: string;
}

// 화면 안의 실행 오류·처리되지 않은 거부를 부모(스테이지 UI) 기록으로 보낸다. iframe은 부모와 격리되어 직접 읽을 수 없다.
const GUARD = `window.addEventListener('error',function(e){parent.postMessage({stage:true,kind:'error',name:'실행 오류',detail:String(e.message)+' (줄 '+e.lineno+')'},'*')});window.addEventListener('unhandledrejection',function(e){parent.postMessage({stage:true,kind:'error',name:'처리되지 않은 거부',detail:String(e.reason&&e.reason.message||e.reason)},'*')});`;

/** origin: 스테이지 서버 주소. srcdoc처럼 location.origin을 쓸 수 없는 문맥에서도 프록시 주소를 만들 수 있게 전역으로 둔다. */
export const frameHtml = (js: string, origin: string) => `<!doctype html><meta charset="utf-8"><div id="root"></div><script>window.__STAGE_ORIGIN__=${JSON.stringify(origin).replace(/</g, '\\u003c')};${GUARD}</script><script>${js.replace(/<\/script/gi, '<\\/script')}</script>`;

const TOOL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const MAX_SESSIONS = 30;
const MAX_BODY = 5_000_000;
const SKIP_REQUEST_HEADERS = /^(x-stage-session|host|connection|content-length|origin|referer|accept-encoding|cookie|keep-alive|transfer-encoding|upgrade|te|trailer|proxy-.*|sec-.*|access-control-.*)$/i;
const SKIP_RESPONSE_HEADERS = /^(connection|content-encoding|content-length|transfer-encoding|keep-alive|set-cookie|access-control-.*)$/i;

export const CORS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
  'access-control-expose-headers': '*',
};

export class PlaygroundManager {
  sessions = new Map<string, PgSession>();
  env: NodeJS.ProcessEnv;
  constructor(env: NodeJS.ProcessEnv = process.env) { this.env = env; }

  create(root: string, profile: Profile, mode: 'mock' | 'stage', mockRoutes: MockRoute[]): PgSession {
    const s: PgSession = { id: crypto.randomBytes(16).toString('hex'), root, profile: structuredClone(profile), mode, mockRoutes, log: [], createdAt: new Date().toISOString() };
    this.sessions.set(s.id, s);
    while (this.sessions.size > MAX_SESSIONS) this.sessions.delete(this.sessions.keys().next().value!);
    return s;
  }

  get(id: string): PgSession {
    const s = this.sessions.get(id);
    if (!s) throw new HttpError(404, '가상 화면 세션 없음(만료됐거나 서버가 다시 시작됨)');
    return s;
  }

  /** 세션 프로필의 환경변수 참조 헤더를 서버에서 채운다. 값이 없으면 보내지 않고 이유를 돌려준다. */
  private resolveHeaders(p: Profile): { headers: Record<string, string>; secrets: string[] } | { missing: string } {
    const headers: Record<string, string> = {};
    const secrets: string[] = [];
    for (const [k, v] of Object.entries(p.headers)) {
      if ('env' in v) {
        const val = this.env[v.env];
        if (!val) return { missing: v.env };
        headers[k] = (v.prefix ?? '') + val;
        secrets.push(val, headers[k]);
      } else headers[k] = v.value;
    }
    return { headers, secrets };
  }

  async proxy(req: http.IncomingMessage, res: http.ServerResponse, id: string, rest: string) {
    const s = this.get(id);
    const method = (req.method ?? 'GET').toUpperCase();
    const out = (status: number, body: Buffer | string, headers: Record<string, string> = {}) => {
      res.writeHead(status, { ...CORS, ...headers });
      res.end(body);
    };
    const json = (status: number, obj: unknown) => out(status, JSON.stringify(obj), { 'content-type': 'application/json; charset=utf-8' });
    const entry: ProxyLogEntry = { seq: s.log.length + 1, at: new Date().toISOString(), mode: s.mode, method, url: rest, requestHeaders: {} };
    s.log.push(entry);
    const t0 = performance.now();
    const hdrs: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) if (!SKIP_REQUEST_HEADERS.test(k) && typeof v === 'string') hdrs[k] = v;
    let body: Buffer | undefined;
    if (method !== 'GET' && method !== 'HEAD') {
      const chunks: Buffer[] = [];
      let n = 0;
      for await (const c of req) { n += c.length; if (n > MAX_BODY) { entry.blocked = '요청 본문이 너무 큼'; return json(413, { message: entry.blocked }); } chunks.push(c as Buffer); }
      body = Buffer.concat(chunks);
    }

    // ---- Mock: stage.config.json의 응답 규칙으로 답한다. 실제 서버로 나가지 않는다. ----
    if (s.mode === 'mock') {
      entry.requestHeaders = redactHeaders(hdrs);
      if (body?.length) entry.requestBody = body.toString('utf8').slice(0, 1000);
      const u = new URL(rest, 'http://mock.invalid');
      const route = s.mockRoutes.find((r) => r.method.toUpperCase() === method && (r.path ? r.path === u.pathname : r.pathPrefix ? u.pathname.startsWith(r.pathPrefix) : false));
      if (!route) { entry.status = 404; entry.error = 'mock 응답 규칙 없음'; return json(404, { message: 'mock 응답 규칙 없음', method, path: u.pathname }); }
      if (route.delayMs) await new Promise((r) => setTimeout(r, route.delayMs));
      entry.status = route.status;
      entry.durationMs = Math.round(performance.now() - t0);
      return out(route.status, JSON.stringify(route.body ?? null), { 'content-type': 'application/json; charset=utf-8', ...(route.headers ?? {}) });
    }

    // ---- Stage: 허용 호스트·변경 요청 허용 여부를 통과한 요청만 실제 서버로 보낸다. ----
    const check = checkTarget(s.profile);
    if (!check.ok) { entry.blocked = `Stage 전송 차단: ${check.reason}`; return json(403, { message: entry.blocked }); }
    if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS' && !s.profile.allowMutations) {
      entry.blocked = `변경 요청(${method})이 이 프로필에서 허용되지 않음`;
      return json(403, { message: entry.blocked });
    }
    const base = new URL(s.profile.baseUrl!);
    let target: URL;
    try { target = new URL(base.href.replace(/\/$/, '') + (rest.startsWith('/') ? rest : `/${rest}`)); } catch { entry.blocked = '요청 주소 형식 오류'; return json(400, { message: entry.blocked }); }
    if (target.host !== base.host || target.protocol !== base.protocol || !target.pathname.startsWith(base.pathname.replace(/\/$/, '') + '/')) {
      entry.blocked = 'baseUrl 밖의 주소로는 보내지 않음';
      return json(403, { message: entry.blocked });
    }
    entry.url = `${target.origin}${target.pathname}${target.search}`;
    const resolved = this.resolveHeaders(s.profile);
    if ('missing' in resolved) { entry.blocked = `환경변수 ${resolved.missing}가 설정되지 않아 보내지 않음`; return json(412, { message: entry.blocked }); }
    const send = { ...hdrs, ...resolved.headers, 'accept-encoding': 'identity' };
    entry.requestHeaders = redactHeaders(send);
    if (body?.length) entry.requestBody = redactText(body.toString('utf8').slice(0, 1000), resolved.secrets);
    try {
      const r = await fetch(target, { method, headers: send, body: body?.length ? new Uint8Array(body) : undefined, redirect: 'manual', signal: AbortSignal.timeout(s.profile.timeoutMs ?? 20_000) });
      const buf = Buffer.from(await r.arrayBuffer());
      entry.status = r.status;
      entry.durationMs = Math.round(performance.now() - t0);
      const rh: Record<string, string> = {};
      r.headers.forEach((v, k) => { if (!SKIP_RESPONSE_HEADERS.test(k)) rh[k] = v; });
      return out(r.status, buf, rh);
    } catch (e: any) {
      entry.error = redactText(String(e?.cause?.code ?? e?.message ?? e), resolved.secrets);
      entry.durationMs = Math.round(performance.now() - t0);
      return json(502, { message: `서버 호출 실패: ${entry.error}` });
    }
  }

  /** 가상 화면 코드를 프로젝트의 node_modules 기준으로 번들한다(브라우저 iframe에서 실행). */
  async bundle(id: string, code: string): Promise<{ js: string } | { errors: { text: string; line?: number; column?: number }[] }> {
    const s = this.get(id);
    if (typeof code !== 'string' || code.length > 200_000) throw new HttpError(400, 'code는 200KB 이하 문자열');
    const { build } = await import('esbuild');
    try {
      const r = await build({
        stdin: { contents: code, resolveDir: s.root, loader: 'jsx', sourcefile: 'stage-screen.jsx' },
        // 프로젝트에 react가 없을 때만 이 도구의 react(19.2.7)로 대신한다. 프로젝트의 node_modules가 항상 먼저다.
        nodePaths: [path.join(TOOL_ROOT, 'node_modules')],
        absWorkingDir: s.root, bundle: true, format: 'iife', platform: 'browser', write: false, logLevel: 'silent', jsx: 'transform',
        define: { 'process.env.NODE_ENV': '"development"' },
        // Next.js용 라이브러리가 읽는 process.env.NEXT_PUBLIC_*가 브라우저에서 ReferenceError를 내지 않도록 빈 환경을 둔다.
        banner: { js: 'var process = { env: { NODE_ENV: "development" } };' },
      });
      s.js = r.outputFiles[0].text;
      return { js: s.js };
    } catch (e: any) {
      const errors = (e?.errors ?? [{ text: String(e?.message ?? e) }]).slice(0, 8).map((x: any) => ({ text: x.text, line: x.location?.line, column: x.location?.column }));
      return { errors };
    }
  }
}
