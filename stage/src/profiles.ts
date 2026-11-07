// 연결 프로필: 3단계에서 대체 객체(mock)를 걷어내고 실제 서버로 호출할 때의 연결 설정을 화면에서 전환한다.
// 비밀 값은 저장하지 않는다(환경변수 이름만 저장). 운영 서버 오호출을 막기 위해 Stage 모드는 허용 호스트 목록에 있는 대상만 통과시킨다.
import { HttpError } from './exec/runs.ts';

/** env: 환경변수 값을 서버에서 채움(prefix가 있으면 앞에 붙임. 예: Authorization = Bearer $TOKEN). 값 자체는 저장하지 않는다. */
export type HeaderRef = { env: string; prefix?: string } | { value: string };

export interface Profile {
  name: string;
  /** mock: 대체 객체·가로채기 응답, stage: 실제 서버 */
  mode: 'mock' | 'stage';
  baseUrl?: string;
  /** Stage 모드에서 호출을 허용하는 호스트(host 또는 host:port) */
  allowedHosts: string[];
  timeoutMs?: number;
  /** POST/PUT/PATCH/DELETE 허용 여부. 꺼져 있으면 변경 요청은 보내지 않는다. */
  allowMutations: boolean;
  headers: Record<string, HeaderRef>;
}

export interface ProfileDoc {
  active: string;
  profiles: Profile[];
  /** "<호출 id>.<옵션 이름>" → real(실물) | double(테스트 대체 객체 유지) */
  bindings: Record<string, 'real' | 'double'>;
}

export type TargetCheck = { ok: true; host?: string } | { ok: false; reason: string };

export const defaultProfileDoc = (): ProfileDoc => ({
  active: 'mock',
  profiles: [
    { name: 'mock', mode: 'mock', allowedHosts: [], allowMutations: true, headers: {} },
    { name: 'stage', mode: 'stage', allowedHosts: [], allowMutations: false, headers: {} },
  ],
  bindings: {},
});

const SECRET_HEADER = /authorization|token|key|secret|cookie|password/i;
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const bad = (msg: string): never => { throw new HttpError(400, msg); };

export function normalizeProfileDoc(input: any): ProfileDoc {
  if (!input || typeof input !== 'object') bad('프로필 문서 형식 아님');
  if (!Array.isArray(input.profiles) || input.profiles.length === 0 || input.profiles.length > 20) bad('profiles는 1~20개');
  const names = new Set<string>();
  const profiles: Profile[] = input.profiles.map((p: any): Profile => {
    const name = typeof p?.name === 'string' ? p.name.trim() : '';
    if (!name || name.length > 40) bad('프로필 이름은 1~40자');
    if (names.has(name)) bad(`프로필 이름 중복: ${name}`);
    names.add(name);
    if (p.mode !== 'mock' && p.mode !== 'stage') bad(`${name}: mode는 mock 또는 stage`);
    let baseUrl: string | undefined;
    if (p.baseUrl !== undefined && p.baseUrl !== '') {
      let u: URL;
      try { u = new URL(String(p.baseUrl)); } catch { return bad(`${name}: baseUrl이 URL이 아님`); }
      if (u.protocol !== 'http:' && u.protocol !== 'https:') bad(`${name}: baseUrl은 http(s)만`);
      if (u.username || u.password) bad(`${name}: baseUrl에 계정 정보를 넣을 수 없음(헤더의 환경변수 참조 사용)`);
      baseUrl = u.href.replace(/\/$/, '');
    }
    const allowedHosts: string[] = [];
    if (p.allowedHosts !== undefined) {
      if (!Array.isArray(p.allowedHosts) || p.allowedHosts.length > 20) bad(`${name}: allowedHosts는 20개 이하 배열`);
      for (const h of p.allowedHosts) {
        const v = String(h).trim().toLowerCase();
        if (!v) continue;
        if (!/^[a-z0-9.-]+(:\d{1,5})?$/.test(v)) bad(`${name}: 허용 호스트 형식 오류(host 또는 host:port): ${v}`);
        if (!allowedHosts.includes(v)) allowedHosts.push(v);
      }
    }
    let timeoutMs: number | undefined;
    if (p.timeoutMs !== undefined && p.timeoutMs !== null && p.timeoutMs !== '') {
      timeoutMs = Number(p.timeoutMs);
      if (!Number.isFinite(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000) bad(`${name}: timeoutMs는 100~120000`);
    }
    const headers: Profile['headers'] = {};
    for (const [k, v] of Object.entries<any>(p.headers ?? {})) {
      if (!HEADER_NAME.test(k)) bad(`${name}: 헤더 이름 형식 오류: ${k}`);
      if (typeof v?.env === 'string' && v.env) {
        if (!ENV_NAME.test(v.env)) bad(`${name}: 환경변수 이름 형식 오류: ${v.env}`);
        if (v.prefix !== undefined && (typeof v.prefix !== 'string' || v.prefix.length > 40 || /[\r\n]/.test(v.prefix))) bad(`${name}: 헤더 접두어는 40자 이하 한 줄 문자열`);
        headers[k] = v.prefix ? { env: v.env, prefix: v.prefix } : { env: v.env };
      } else if (typeof v?.value === 'string') {
        if (SECRET_HEADER.test(k)) bad(`${name}: ${k}는 비밀 값일 수 있어 직접 저장하지 않음 — 환경변수 이름으로 지정`);
        headers[k] = { value: v.value };
      } else bad(`${name}: 헤더 ${k}는 {env} 또는 {value}`);
    }
    return { name, mode: p.mode, baseUrl, allowedHosts, timeoutMs, allowMutations: p.allowMutations === true, headers };
  });
  const active = typeof input.active === 'string' && names.has(input.active) ? input.active : profiles[0].name;
  const bindings: ProfileDoc['bindings'] = {};
  const entries = Object.entries<any>(input.bindings ?? {});
  if (entries.length > 1000) bad('bindings가 너무 많음');
  for (const [k, v] of entries) {
    if (v !== 'real' && v !== 'double') bad(`bindings 값은 real 또는 double: ${k}`);
    bindings[k] = v;
  }
  return { active, profiles, bindings };
}

/** 전송 직전 점검. Stage 모드는 baseUrl이 있고 호스트가 허용 목록에 있어야 한다. */
export function checkTarget(p: Profile): TargetCheck {
  if (p.mode === 'mock') return { ok: true };
  if (!p.baseUrl) return { ok: false, reason: 'baseUrl 미설정' };
  const u = new URL(p.baseUrl);
  if (p.allowedHosts.length === 0) return { ok: false, reason: '허용 호스트가 비어 있음 — 호출 대상을 허용 목록에 추가해야 함' };
  const host = u.host.toLowerCase();
  if (!p.allowedHosts.includes(host) && !p.allowedHosts.includes(u.hostname.toLowerCase())) return { ok: false, reason: `${host}는 허용 호스트 목록에 없음` };
  return { ok: true, host };
}
