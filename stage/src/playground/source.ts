// 3단계 가상 화면 코드 생성. 테스트가 공개 API(Hook)를 호출한 지점의 메타정보로, 대체 객체 없이 실제 모듈을 호출하는
// 작은 React 화면 코드를 만든다. 사용자는 이 코드를 화면에서 고치며 동작을 확인한다.
import type { Value, WiringCall, WiringOption } from '../model.ts';

/** Hook(use로 시작하는 공개 API)만 가상 화면으로 만들 수 있다. */
export const isPlayable = (call: Pick<WiringCall, 'sut'>) => /^use[A-Z]/.test(call.sut);

function lit(v: Value, indent = 2): string {
  if (v && typeof v === 'object' && !Array.isArray(v) && (v as any).$stage === 'undefined') return 'undefined';
  if (Array.isArray(v)) return `[${v.map((x) => lit(x, indent)).join(', ')}]`;
  if (v && typeof v === 'object') {
    const entries = Object.entries(v as Record<string, Value>);
    if (!entries.length) return '{}';
    const pad = ' '.repeat(indent + 2);
    return `{ ${entries.map(([k, x]) => `${/^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k)}: ${lit(x, indent + 2)}`).join(', ')} }`.replace(/\n/g, `\n${pad}`);
  }
  return JSON.stringify(v);
}

const oneLine = (s: string) => s.replace(/\s+/g, ' ').slice(0, 160);

function optionLine(o: WiringOption): string {
  switch (o.kind) {
    case 'literal': return `${o.key}: ${lit(o.value)},`;
    case 'function': return `${o.key}: ${o.source},`;
    case 'double':
      if (o.key === 'client') return 'client,';
      // 콜백은 호출 순서·인자를 화면에 기록하는 스파이로 둔다. 값을 돌려줘야 하는 대체 함수(mapRequest 등)는 자동으로 만들지 않는다.
      if (/^on[A-Z]/.test(o.key)) return `${o.key}: spy('${o.key}'),`;
      return `// ${o.key}: 원본 테스트는 대체 객체를 넘겼습니다 — 필요하면 직접 작성하세요 (${oneLine(o.source)})`;
    default: return `// ${o.key}: 해석하지 못한 옵션입니다 (${oneLine(o.source)})`;
  }
}

export interface SourceInput {
  call: WiringCall;
  testTitle: string;
  /**
   * 프록시 세션 id. 실제 클라이언트는 경로를 baseUrl에 URL 규칙으로 붙이므로(앞이 /인 경로는 baseUrl의 경로를 버린다)
   * 세션을 경로가 아니라 헤더(x-stage-session)로 식별한다.
   */
  sessionId: string;
}

export function generateHookSource({ call, testTitle, sessionId }: SourceInput): string {
  const hasClient = call.collaborators.some((k) => k.option === 'client');
  const pathArg = call.path !== undefined ? JSON.stringify(call.path) : 'undefined';
  const lines = call.options.map(optionLine).map((l) => `    ${l}`);
  if (!hasClient) lines.unshift('    client,');
  const opts = lines.length ? `, {\n${lines.join('\n')}\n  }` : '';
  const title = oneLine(testTitle).replace(/\*\//g, '* /');
  return `// 테스트: ${title}
// 원본 테스트가 대체 객체로 넘기던 client를 실제 클라이언트로 바꿨습니다. 요청은 스테이지 서버 프록시를 거쳐
// 선택한 연결 프로필의 서버로 나갑니다. 코드를 고치면 오른쪽 화면에 바로 반영됩니다.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { createApiClient } from 'base-framework/lib/http';
import { ${call.sut} } from '${call.specifier}';

const report = (kind, name, detail) => window.parent.postMessage({ stage: true, kind, name, detail, at: Date.now() }, '*');
const plain = (v) => {
  try { return JSON.parse(JSON.stringify(v, (_k, x) => (x instanceof Error ? { name: x.name, message: x.message, status: x.status } : typeof x === 'function' ? '[함수]' : x))); } catch { return String(v); }
};
const spy = (name) => (...args) => { report('callback', name, plain(args)); };

const client = createApiClient({
  baseUrl: window.__STAGE_ORIGIN__ || location.origin,
  defaultHeaders: { 'x-stage-session': ${JSON.stringify(sessionId)} },
});

function Screen() {
  const api = ${call.sut}(${pathArg}${opts});
  const [body, setBody] = React.useState('{}');
  const actions = Object.entries(api).filter(([, v]) => typeof v === 'function');
  const state = Object.fromEntries(Object.entries(api).filter(([, v]) => typeof v !== 'function'));
  const run = async (name, fn) => {
    try {
      const out = await (name === 'send' ? fn(JSON.parse(body || '{}')) : fn());
      report('result', name, plain(out));
    } catch (e) {
      report('error', name, plain(e));
    }
  };
  return (
    <main style={{ font: '14px system-ui', padding: 12 }}>
      <textarea value={body} onChange={(e) => setBody(e.target.value)} rows={3} style={{ width: '100%', font: '12px ui-monospace, monospace' }} />
      <div style={{ margin: '8px 0', display: 'flex', gap: 8 }}>
        {actions.map(([name, fn]) => <button key={name} onClick={() => run(name, fn)}>{name}</button>)}
      </div>
      <pre style={{ background: '#f5f6fa', padding: 8, overflow: 'auto' }}>{JSON.stringify(plain(state), null, 2)}</pre>
    </main>
  );
}

createRoot(document.getElementById('root')).render(<Screen />);
`;
}
