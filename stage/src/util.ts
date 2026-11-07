import crypto from 'node:crypto';
import type { TypeSchema, Value } from './model.ts';

export function sha256(data: string | Buffer | Uint8Array): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

export function newId(prefix: string): string {
  const t = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  return `${prefix}-${t}-${crypto.randomBytes(3).toString('hex')}`;
}

export const SECRET_HEADER = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token)$/i;

/** 증거·로그에서 비밀값을 제거한다. 값 자체를 알고 있는 경우 문자열 치환도 수행한다. */
export function redactText(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) if (s && s.length >= 4) out = out.split(s).join('[REDACTED]');
  return out;
}

export function redactHeaders(h: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) out[k] = SECRET_HEADER.test(k) ? '[REDACTED]' : v;
  return out;
}

const isTag = (v: any, t: string) => v !== null && typeof v === 'object' && !Array.isArray(v) && v.$stage === t;

/** 태그된 JSON → 실제 값. ctorResolver는 공개 export를 찾아준다(자식 프로세스에서만 제공). */
export function decodeValue(v: Value, ctorResolver?: (exportName: string) => any): any {
  if (Array.isArray(v)) return v.map((x) => decodeValue(x, ctorResolver));
  if (v === null || typeof v !== 'object') return v;
  const o = v as any;
  if (isTag(o, 'undefined')) return undefined;
  if (isTag(o, 'regexp')) return new RegExp(o.source, o.flags);
  if (isTag(o, 'error')) {
    const E = (globalThis as any)[o.name] && typeof (globalThis as any)[o.name] === 'function' ? (globalThis as any)[o.name] : Error;
    const e = new E(o.message);
    if (E === Error && o.name && o.name !== 'Error') e.name = o.name;
    Object.assign(e, decodeValue(o.props ?? {}, ctorResolver));
    return e;
  }
  if (isTag(o, 'construct')) {
    if (!ctorResolver) throw new Error(`construct 값(${o.export})은 실행 환경에서만 만들 수 있음`);
    const C = ctorResolver(o.export);
    return new C(...decodeValue(o.args ?? [], ctorResolver));
  }
  const out: any = {};
  for (const [k, x] of Object.entries(o)) out[k] = decodeValue(x, ctorResolver);
  return out;
}

/** 실제 값 → 태그된 JSON(표시·저장용). 순환·깊이를 제한한다. */
export function encodeValue(v: any, depth = 0, seen = new WeakSet<object>()): Value {
  if (v === undefined) return { $stage: 'undefined' };
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return v;
  if (typeof v === 'number') return Number.isFinite(v) ? v : { $stage: 'number', text: String(v) };
  if (typeof v === 'bigint') return { $stage: 'bigint', text: v.toString() };
  if (typeof v === 'function') return { $stage: 'function', name: v.name || '(anonymous)' };
  if (typeof v === 'symbol') return { $stage: 'symbol', text: v.toString() };
  if (depth > 6) return { $stage: 'truncated' };
  if (seen.has(v)) return { $stage: 'circular' };
  seen.add(v);
  if (v instanceof Error) {
    const props: any = {};
    for (const k of Object.keys(v)) if (k !== 'name' && k !== 'message' && k !== 'stack') props[k] = encodeValue((v as any)[k], depth + 1, seen);
    if ((v as any).cause !== undefined) props.cause = encodeValue((v as any).cause, depth + 1, seen);
    return { $stage: 'error', name: v.name, message: v.message, ...(Object.keys(props).length ? { props } : {}) };
  }
  if (v instanceof RegExp) return { $stage: 'regexp', source: v.source, flags: v.flags };
  if (Array.isArray(v)) return v.slice(0, 200).map((x) => encodeValue(x, depth + 1, seen));
  const proto = Object.getPrototypeOf(v);
  if (proto !== Object.prototype && proto !== null) {
    const ctor = proto?.constructor?.name ?? 'Object';
    const fields: any = {};
    for (const k of Object.keys(v)) fields[k] = encodeValue(v[k], depth + 1, seen);
    return { $stage: 'object', ctor, fields };
  }
  const out: any = {};
  for (const k of Object.keys(v)) out[k] = encodeValue(v[k], depth + 1, seen);
  return out;
}

/** 값이 타입 스키마를 만족하는지 검사한다(공개 타입 계약 검증). 위반 경로 목록을 돌려준다. */
export function conforms(v: any, s: TypeSchema, p = '$'): string[] {
  switch (s.kind) {
    case 'any': case 'unknown': case 'ref': return [];
    case 'string': case 'number': case 'boolean':
      return typeof v === s.kind ? [] : [`${p}: ${s.kind} 기대, ${describe(v)}`];
    case 'null': return v === null ? [] : [`${p}: null 기대, ${describe(v)}`];
    case 'undefined': case 'void': return v === undefined ? [] : [`${p}: undefined 기대, ${describe(v)}`];
    case 'never': return [`${p}: 값이 존재하면 안 됨`];
    case 'literal': return v === s.value ? [] : [`${p}: ${JSON.stringify(s.value)} 기대, ${describe(v)}`];
    case 'union': {
      for (const o of s.options) if (conforms(v, o, p).length === 0) return [];
      return [`${p}: ${s.options.map(schemaText).join(' | ')} 중 하나 기대, ${describe(v)}`];
    }
    case 'array': {
      if (!Array.isArray(v)) return [`${p}: 배열 기대, ${describe(v)}`];
      return v.flatMap((x, i) => conforms(x, s.element, `${p}[${i}]`));
    }
    case 'function': return typeof v === 'function' ? [] : [`${p}: 함수 기대, ${describe(v)}`];
    case 'object': {
      if (v === null || typeof v !== 'object') return [`${p}: 객체 기대, ${describe(v)}`];
      const errs: string[] = [];
      for (const [k, prop] of Object.entries(s.props)) {
        if (!(k in v)) { if (!prop.optional) errs.push(`${p}.${k}: 필수 속성 없음`); continue; }
        if (prop.optional && v[k] === undefined) continue;
        errs.push(...conforms(v[k], prop.schema, `${p}.${k}`));
      }
      return errs;
    }
  }
}

function describe(v: any): string {
  if (v === null) return 'null 받음';
  if (Array.isArray(v)) return '배열 받음';
  return `${typeof v} ${typeof v === 'object' ? '' : JSON.stringify(v)} 받음`.replace(/\s+받음/, ' 받음');
}

export function schemaText(s: TypeSchema): string {
  switch (s.kind) {
    case 'literal': return JSON.stringify(s.value);
    case 'union': return s.options.map(schemaText).join(' | ');
    case 'array': return `${schemaText(s.element)}[]`;
    case 'object': return s.name ?? `{ ${Object.entries(s.props).map(([k, p]) => `${k}${p.optional ? '?' : ''}: ${schemaText(p.schema)}`).join('; ')} }`;
    case 'function': case 'ref': return s.text;
    default: return s.kind;
  }
}
