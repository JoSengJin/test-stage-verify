/** Execute the configured scenario against real collaborators and record its assertions. */
export async function executeConnectedScenario({ code, connections, values, seed }, modules, symbols, renderHook) {
  const checks = [];
  const restores = [];
  const observations = new WeakMap();
  const resources = [];
  const trace = [];
  const sources = new WeakMap();
  const cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
  let checkLabel;
  const equal = (a, b, seen = new Map()) => {
    if (Object.is(a, b)) return true;
    if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
    if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
    // Fail closed for object types whose semantics this browser assertion helper cannot compare.
    if (a instanceof Date) return Object.is(a.getTime(), b.getTime());
    if (a instanceof RegExp) return a.source === b.source && a.flags === b.flags && a.lastIndex === b.lastIndex;
    if (!Array.isArray(a) && Object.getPrototypeOf(a) !== Object.prototype && Object.getPrototypeOf(a) !== null) throw new Error('이 객체 타입의 검증은 assert.equal 또는 속성별 assertion으로 작성하세요.');
    if (seen.has(a)) return seen.get(a) === b;
    if ([...seen.values()].includes(b)) return false;
    seen.set(a, b);
    if (Array.isArray(a) && a.length !== b.length) return false;
    const keys = Reflect.ownKeys(a).filter(key => Object.prototype.propertyIsEnumerable.call(a, key));
    const otherKeys = Reflect.ownKeys(b).filter(key => Object.prototype.propertyIsEnumerable.call(b, key));
    return keys.length === otherKeys.length && keys.every((key) => Object.hasOwn(b, key) && equal(a[key], b[key], seen));
  };
  const check = (ok, actual, expected, message) => {
    checks.push({ passed: ok, actual, expected, message, ...(checkLabel ? { label: checkLabel } : {}) });
    if (!ok) throw new Error(message || '기대 결과와 실제 결과가 다릅니다.');
  };
  const assert = {
    label: label => { checkLabel = label; },
    equal: (a, b, message) => check(Object.is(a, b), a, b, message),
    deepEqual: (a, b, message) => check(equal(a, b), a, b, message),
    ok: (a, message) => check(!!a, a, true, message),
    match: (a, b, message) => check(typeof a === 'string' && b.test(a), a, String(b), message),
    doesNotThrow: (fn) => { fn(); check(true, '예외 없음', '예외 없음'); },
    rejects: async (fn, ...options) => {
      if (options.length) throw new Error('assert.rejects의 오류 조건은 catch 후 assert.match 또는 assert.equal로 명시하세요.');
      try { await (typeof fn === 'function' ? fn() : fn); }
      catch (error) { check(true, String(error), '비동기 예외 발생'); return; }
      check(false, '정상 완료', '비동기 예외 발생');
    },
  };
  assert.strictEqual = assert.equal;
  assert.deepStrictEqual = assert.deepEqual;
  const observeMethod = (owner, key) => {
    const storage = typeof Storage !== 'undefined' && owner instanceof Storage ? owner : null;
    if (storage) owner = Storage.prototype;
    if (typeof owner?.[key] !== 'function') throw new Error('관찰할 실제 메서드가 없습니다: ' + key);
    const existing = observations.get(owner)?.[key];
    if (existing) return existing;
    const original = owner[key];
    const descriptor = Object.getOwnPropertyDescriptor(owner, key);
    const calls = [];
    const observed = function (...args) {
      if (storage && this !== storage) return Reflect.apply(original, this, args);
      const call = { arguments: args };
      calls.push(call);
      try { call.result = Reflect.apply(original, this, args); return call.result; }
      catch (error) { call.error = error; throw error; }
    };
    observed.observed = { calls, callCount: () => calls.length };
    Object.defineProperty(owner, key, { configurable: true, writable: true, value: observed });
    const methods = observations.get(owner) || {};
    methods[key] = observed;
    observations.set(owner, methods);
    restores.push(() => { if (descriptor) Object.defineProperty(owner, key, descriptor); else delete owner[key]; });
    return observed;
  };
  const observeObject = (value, methodNames) => {
    if (!value || typeof value !== 'object') throw new Error('실제 협력자 객체를 선택하세요.');
    // Observe methods on the actual object so SUT calls through global APIs are recorded too.
    const names = new Set(methodNames || []);
    // Zod object schemas can expose safeParse through a lazy getter.
    if (typeof value.safeParse === 'function') names.add('safeParse');
    for (let p = methodNames ? null : value; p && p !== Object.prototype; p = Object.getPrototypeOf(p)) {
      for (const key of Object.getOwnPropertyNames(p)) {
        if (key !== 'constructor' && typeof Object.getOwnPropertyDescriptor(p, key)?.value === 'function') names.add(key);
      }
    }
    for (const key of names) observeMethod(value, key);
    return value;
  };
  const observeFunction = (fn) => {
    if (typeof fn !== 'function') throw new Error('실제 콜백 함수를 입력하세요.');
    const owner = { callback: fn };
    return observeMethod(owner, 'callback');
  };
  const m = Object.assign({}, ...modules);
  const connect = async (key, actual) => {
    const expression = connections[key];
    if (!expression?.trim()) throw new Error('실제 협력자 연결이 필요합니다: ' + key);
    if (expression === '@actual') {
      if (!actual) throw new Error('실제 협력자 구현이 없습니다: ' + key);
      return actual;
    }
    if (expression === 'window.__stageReact') return renderHook?.react || window.__stageReact;
    return new Function('m', 'values', 'modules', 'return (' + expression + ');')(m, values, modules);
  };
  const mountHook = async (hook, props) => {
    if (typeof renderHook !== 'function') throw new Error('이 후보 번들에서 실제 React 렌더러를 불러오지 못했습니다.');
    const handle = await renderHook(hook, props);
    resources.push(() => handle.unmount());
    trace.push({ kind: 'react', action: 'mount', route: props?.route, enabled: props?.enabled });
    const rerender = handle.rerender.bind(handle);
    handle.rerender = async props => { await rerender(props); trace.push({ kind: 'react', action: 'rerender', route: props?.route, enabled: props?.enabled }); };
    return handle;
  };
  const observeEventSource = (Constructor) => {
    if (typeof window === 'undefined' || Constructor !== window.EventSource) throw new Error('실제 브라우저 EventSource를 선택하세요.');
    const calls = [];
    const observed = new Proxy(Constructor, {
      construct(target, args) {
        const source = Reflect.construct(target, args);
        calls.push({ arguments: args, result: source });
        const state = { open: false, messages: [], waiters: [] };
        sources.set(source, state);
        source.addEventListener('open', () => { state.open = true; trace.push({ kind: 'sse', event: 'open', url: source.url }); for (const notify of [...state.waiters]) notify(); });
        source.addEventListener('message', event => { state.messages.push(event); trace.push({ kind: 'sse', event: 'message', data: event.data }); for (const notify of [...state.waiters]) notify(); });
        source.addEventListener('error', () => { trace.push({ kind: 'sse', event: 'error' }); for (const notify of [...state.waiters]) notify(); });
        resources.push(() => source.close());
        return source;
      },
    });
    Object.defineProperty(observed, 'observed', { configurable: true, value: { calls, callCount: () => calls.length } });
    const descriptor = Object.getOwnPropertyDescriptor(window, 'EventSource');
    Object.defineProperty(window, 'EventSource', { configurable: true, writable: true, value: observed });
    restores.push(() => { if (descriptor) Object.defineProperty(window, 'EventSource', descriptor); else delete window.EventSource; delete observed.observed; });
    return observed;
  };
  const waitForSource = (source, event) => new Promise((resolve, reject) => {
    const state = sources.get(source);
    if (!state) { reject(new Error('실제 EventSource 관찰 기록이 없습니다.')); return; }
    const finish = () => {
      if ((event === 'open' && state.open) || (event === 'message' && state.messages.length)) {
        const value = event === 'message' ? state.messages.shift() : undefined;
        cleanup();
        // Native event listeners can have microtask checkpoints between callbacks.
        // Let the candidate's onopen/message handlers finish before asserting their effects.
        setTimeout(() => resolve(value), 0);
      } else if (source.readyState === 2) { cleanup(); reject(new Error('SSE 연결이 닫혔습니다.')); }
    };
    const cleanup = () => { clearTimeout(timer); state.waiters = state.waiters.filter(waiter => waiter !== finish); };
    const timer = setTimeout(() => { cleanup(); reject(new Error('실제 SSE ' + event + ' 수신 시간 초과')); }, 10_000);
    state.waiters.push(finish); finish();
  });
  const receiveSse = async (source, expectedData) => {
    await waitForSource(source, 'open');
    if (values.__emitUrl) {
      const response = await fetch(values.__emitUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ data: expectedData }) });
      if (!response.ok) throw new Error('실제 검증 서버의 SSE 메시지 발행 실패');
    }
    const event = await waitForSource(source, 'message');
    if (event.data !== expectedData) throw new Error('수신한 실제 SSE 데이터가 테스트 시나리오의 입력과 다릅니다.');
  };
  try {
    if (/\bmock\s*\./.test(code) || Object.values(connections).some((s) => /\bmock\s*\./.test(s))) throw new Error('mock 호출을 실제 협력자 연결로 변경하세요.');
    if (typeof sessionStorage !== 'undefined') {
      sessionStorage.clear();
      for (const [key, value] of Object.entries(seed || {})) sessionStorage.setItem(key, String(value));
    }
    const names = symbols.map((s) => s.name);
    const args = symbols.map((s) => modules[s.module][s.exportName]);
    const result = await new Function(...names, 'm', 'connect', 'observeObject', 'observeFunction', 'observeMethod', 'assert', 'values', 'renderHook', 'mountHook', 'observeEventSource', 'waitForSource', 'receiveSse', 'return (async () => {\n' + code + '\n})();')(...args, m, connect, observeObject, observeFunction, observeMethod, assert, values, renderHook, mountHook, observeEventSource, waitForSource, receiveSse);
    return { status: checks.length ? 'passed' : 'failed', checks, result, trace, reason: checks.length ? '기대 결과 검증 완료' : '실행된 기대 결과 검증이 없습니다.' };
  } catch (error) {
    return { status: 'failed', checks, trace, reason: String(error?.stack || error) };
  } finally {
    for (const dispose of resources.reverse()) dispose();
    for (const restore of restores.reverse()) restore();
    if (cryptoDescriptor) Object.defineProperty(globalThis, 'crypto', cryptoDescriptor);
    else delete globalThis.crypto;
  }
}
