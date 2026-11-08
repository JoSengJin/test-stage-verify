/** Choices refer to real exported implementations. They never synthesize a parsing result. */
export function collaboratorChoices(module, scenario, key) {
  const choices = [];
  const parsing = scenario.presentation?.parsing;
  const role = scenario.connectionRoles?.[key];
  const schema = parsing?.connection === key || role === 'schema';
  if (role === 'console') return [
    { label: '실제 Node 콘솔 출력 · 원본 테스트 실행 환경', expression: 'console', environment: 'node' },
    { label: '실제 브라우저 콘솔 출력', expression: 'console', environment: 'browser' },
  ];
  const native = {
    react: { label: '프로젝트에 설치된 실제 React', expression: 'window.__stageReact' },
    logger: { label: '실제 브라우저 콘솔에 로그 출력', expression: 'console' },
    'local-storage': { label: '브라우저의 실제 로컬 저장소', expression: 'window.localStorage' },
    'session-storage': { label: '브라우저의 실제 세션 저장소', expression: 'window.sessionStorage' },
    'event-source': { label: '브라우저의 실제 EventSource', expression: 'window.EventSource' },
    http: { label: '클라이언트의 실제 HTTP 전송 계층', expression: '@actual' },
    uuid: { label: '실제 암호학적 UUID 생성기', expression: 'globalThis.crypto' },
    clock: { label: '실제 현재 시각', expression: 'Date' },
    random: { label: '실제 난수 생성기', expression: 'Math' },
    callback: { label: '수신한 내용을 실제 콘솔에 기록', expression: 'console.info.bind(console)' },
  };
  if (native[role]) return [native[role]];
  if (schema) {
    const input = parsing?.input;
    for (const factory of scenario.factories || []) {
      if (!factory.schema) continue;
      if (factory.fields) {
        if (!input || typeof input !== 'object' || Array.isArray(input)) continue;
        const types = factory.fields.types;
        const fields = Object.entries(input).map(([name, value]) => ({ name, type: typeof value === 'number' && types.includes('number') ? 'number' : typeof value === 'string' && types.includes('text') ? 'text' : typeof value === 'string' && types.includes('string') ? 'string' : '' }));
        choices.push({ key: factory.expression, label: '항목별 검증 · ' + factory.name, expression: '', factory: factory.expression, legacyFactory: factory.legacyExpression, fieldContract: factory.fields, fields });
      } else if (factory.callableWithoutArguments) {
        const labels = { number: factory.schema.coerce ? '숫자 변환 검증' : '숫자 자료형 검증', string: '문자열 검증', boolean: '참·거짓 검증', date: '날짜 검증', object: '객체 검증', array: '배열 검증' };
        choices.push({ key: factory.expression, label: (labels[factory.schema.kind] || '검증 규칙') + ' · ' + factory.name, expression: factory.expression + '()', legacyExpression: factory.legacyExpression + '()' });
      }
    }
    for (const [name, value] of Object.entries(module)) {
      if (value && typeof value.safeParse === 'function') choices.push({ label: '배포된 검증 규칙 · ' + name, expression: 'm[' + JSON.stringify(name) + ']', legacyExpression: 'm.' + name });
    }
  } else {
    const kind = scenario.connectionKinds?.[key];
    if (kind === 'function') choices.push({ label: '전달된 내용을 브라우저 콘솔에 기록', expression: 'console.info.bind(console)' });
    else {
      choices.push({ label: '브라우저 세션 저장소', expression: 'window.sessionStorage' });
      choices.push({ label: '브라우저 로컬 저장소', expression: 'window.localStorage' });
      choices.push({ label: '실제 콘솔 출력', expression: 'console' });
      for (const factory of scenario.factories || []) if (!factory.schema && factory.methods.length && factory.callableWithoutArguments) choices.push({ label: '배포 객체 생성 · ' + factory.name, expression: factory.expression + '()' });
      for (const [name, value] of Object.entries(module)) {
        if (value && typeof value === 'object') choices.push({ label: '배포된 객체 · ' + name, expression: 'm[' + JSON.stringify(name) + ']' });
      }
    }
  }
  return choices.sort((a, b) => Number(!!b.fields) - Number(!!a.fields));
}

export function initConnectedConsole(options, executeConnectedScenario, collaboratorChoices) {
  const $ = id => document.getElementById(id);
  const module = window.__stageM || {};
  const drafts = Object.fromEntries(Object.entries(options.saved || {}).map(([id, saved]) => [id, { ...saved.input, seed: JSON.stringify(saved.input.seed || {}) }]));
  const results = Object.fromEntries(Object.entries(options.saved || {}).map(([id, saved]) => [id, saved.result]));
  let selected = options.definition.scenarios[0]?.id;
  let revision = 0;
  let busy = false;
  let sequence = Date.now() * 1000;
  const current = () => options.definition.scenarios.find(scenario => scenario.id === selected);
  const send = data => parent.postMessage({ connectedScenario: true, runId: options.runId, jobId: options.jobId, sequence: ++sequence, ...data }, '*');
  const text = value => JSON.stringify(value, null, 2) ?? String(value);
  // 끝나지 않는 시나리오(응답 없는 서버 등)가 화면을 영원히 잠그지 않도록 시간 제한을 둔다.
  const RUN_TIMEOUT_MS = 60000;
  const withTimeout = promise => { let timer; return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('시간 제한(' + RUN_TIMEOUT_MS / 1000 + '초)을 넘었습니다. 시나리오가 끝나지 않았습니다. 이 페이지를 새로고침해 정리한 뒤 다시 실행하세요.')), RUN_TIMEOUT_MS); })]).finally(() => clearTimeout(timer)); };
  const edited = () => !!current() && $('code').value !== current().code;
  const row = (label, value) => {
    const item = document.createElement('div');
    const title = document.createElement('dt'); title.textContent = label;
    const content = document.createElement('dd'); content.textContent = value;
    item.append(title, content);
    return item;
  };
  function save() {
    if (!selected) return;
    drafts[selected] = {
      code: $('code').value,
      environment: $('environment').value,
      seed: $('seed').value,
      connections: Object.fromEntries([...document.querySelectorAll('[data-connection]')].map(el => [el.dataset.connection, el.value])),
      values: Object.fromEntries([...document.querySelectorAll('[data-value]')].map(el => [el.dataset.value, el.value])),
      selections: Object.fromEntries([...document.querySelectorAll('[data-choice]')].map(el => [el.dataset.choice, { choice: el.value, key: collaboratorChoices(module, current(), el.dataset.choice)[Number(el.value)]?.key, fields: [...document.querySelectorAll('[data-field-owner]')].filter(field => field.dataset.fieldOwner === el.dataset.choice).map(field => ({ name: field.dataset.fieldName, type: field.value })) }])),
      networkMode: document.querySelector('[data-network-mode]')?.value,
    };
  }
  function readiness() {
    const network = current()?.network;
    const mode = document.querySelector('[data-network-mode]')?.value;
    const fields = [...document.querySelectorAll('[data-connection], [data-value]')].filter(field => !network || field.dataset.value !== network.valueKey || mode === 'external');
    const missing = fields.find(field => !field.value.trim());
    $('run').disabled = busy || !selected || !!missing || (!!network && !mode);
    if (busy) { $('next').textContent = '선택한 실제 협력자로 검증하고 있습니다.'; return; }
    if (edited()) { $('next').textContent = '경고: 기대 결과 검증 코드가 원본과 다릅니다. 이 상태의 통과는 배포 판정 근거로 인정되지 않습니다. 개발자 설정에서 원래 코드로 되돌리세요.'; return; }
    if (network && !mode) { $('next').textContent = '실제로 연결할 서버를 선택하세요.'; return; }
    if (!missing && results[selected]?.status === 'passed') {
      const complete = options.definition.scenarios.every(scenario => results[scenario.id]?.status === 'passed');
      $('next').textContent = complete ? '모든 시나리오가 통과했습니다. 아래에서 3단계 판정을 확정할 수 있습니다.' : '이 시나리오는 통과했습니다. 다른 시나리오를 선택해 검증하세요.';
      return;
    }
    $('next').textContent = missing ? (missing.dataset.connection ? (current().presentation?.parsing ? '아래에서 검증 규칙을 선택하세요.' : '아래에서 실제 협력자를 선택하세요.') : '연결할 서버 주소를 입력하세요.') : '구성이 준비되었습니다. 검증 실행을 누르세요.';
  }
  function renderResult(result) {
    $('result').replaceChildren();
    if (!result) { $('status').textContent = ''; $('out').textContent = '실행 대기'; return; }
    $('status').textContent = result.status === 'passed' ? (edited() ? '통과(검증 코드를 수정한 결과 · 배포 판정 근거로 인정되지 않음)' : '기대 결과 통과') : '미통과';
    $('status').dataset.status = result.status;
    const list = document.createElement('dl');
    for (const [index, check] of result.checks.entries()) {
      const label = check.label || current().presentation?.checks[index]?.label || '검증 ' + (index + 1);
      list.append(row((check.passed ? '통과 · ' : '불일치 · ') + label, '기대 ' + text(check.expected) + '\n실제 ' + text(check.actual)));
    }
    $('result').append(list);
    if (result.status !== 'passed') {
      const error = document.createElement('p'); error.textContent = (result.reason || '실행 결과를 확인하세요.').split('\n')[0].replace(/^Error: /, '');
      $('result').append(error);
    }
    $('out').textContent = JSON.stringify(result, (key, value) => typeof value === 'bigint' ? String(value) : value, 2);
  }
  function showFieldSettings(key, choice, savedFields) {
    const host = [...document.querySelectorAll('[data-fields]')].find(el => el.dataset.fields === key);
    host.replaceChildren();
    if (!choice?.fields) return;
    const help = document.createElement('p'); help.className = 'hint'; help.textContent = '각 항목의 자료형을 확인하세요. 초기 자료형은 테스트 입력값에서 가져왔습니다.';
    host.append(help);
    for (const field of choice.fields) {
      const label = document.createElement('label'); label.textContent = field.name;
      const select = document.createElement('select'); select.dataset.fieldOwner = key; select.dataset.fieldName = field.name;
      for (const type of ['', ...choice.fieldContract.types]) {
        const name = ({ number: '숫자', integer: '정수', text: '문자열', string: '문자열', email: '이메일' })[type] || type || '자료형 선택';
        const option = document.createElement('option'); option.value = type; option.textContent = name; select.append(option);
      }
      select.value = savedFields?.find(saved => saved.name === field.name)?.type ?? field.type;
      label.append(select); host.append(label);
    }
  }
  function fieldExpression(key, choice) {
    const fields = [...document.querySelectorAll('[data-field-owner]')].filter(el => el.dataset.fieldOwner === key);
    if (!choice?.factory || fields.some(field => !field.value)) return '';
    const settings = fields.map(field => ({ [choice.fieldContract.nameKey]: field.dataset.fieldName, [choice.fieldContract.typeKey]: field.value }));
    return choice.factory + '(' + JSON.stringify(settings) + ')';
  }
  function applyChoice(select, restore = false) {
    const key = select.dataset.choice;
    const choices = collaboratorChoices(module, current(), key);
    const choice = select.value === '' ? undefined : choices[Number(select.value)];
    const input = [...document.querySelectorAll('[data-connection]')].find(el => el.dataset.connection === key);
    if (select.value === 'custom') { showFieldSettings(key, undefined); $('advanced').open = true; return; }
    if (choice?.environment) $('environment').value = choice.environment;
    showFieldSettings(key, choice, restore ? drafts[selected]?.selections?.[key]?.fields : undefined);
    if (restore && input.value) return;
    if (choice?.fields) input.value = fieldExpression(key, choice);
    else input.value = choice?.expression || '';
  }
  function draw() {
    const scenario = current();
    if (!scenario) { $('next').textContent = '표시할 시나리오가 없습니다. 배포 후보를 다시 실행하세요.'; $('run').disabled = true; return; }
    const draft = drafts[selected];
    $('original').textContent = scenario.original;
    $('code').value = draft?.code ?? scenario.code;
    $('environment').value = draft?.environment ?? (/delete globalThis.window|globalThis.window = undefined/.test(scenario.code) ? 'node' : 'browser');
    $('seed').value = draft?.seed ?? '{}';
    $('advanced').open = false;
    $('adaptations').replaceChildren();
    for (const note of scenario.adaptations || []) { const p = document.createElement('p'); p.className = 'hint'; p.textContent = note; $('adaptations').append(p); }
    $('facts').replaceChildren();
    const parsing = scenario.presentation?.parsing;
    if (parsing) {
      $('facts').append(row('실행할 함수', parsing.functionName), row('테스트 입력값', text(parsing.input)));
      if (Object.hasOwn(parsing, 'fallback')) $('facts').append(row('검증 실패 시 기본값', text(parsing.fallback)));
    }
    const dynamicExpected = scenario.adaptations?.some(note => note.includes('고정 mock 반환값'));
    for (const check of scenario.presentation?.checks || []) $('facts').append(row((dynamicExpected ? '원본 mock 기대값 · ' : '기대 결과 · ') + check.label, text(check.expected)));
    $('connections').replaceChildren(); $('expressions').replaceChildren(); $('values').replaceChildren();
    for (const key of scenario.connections) {
      const expressionLabel = document.createElement('label'); expressionLabel.textContent = '연결식 · ' + key;
      const input = document.createElement('input'); input.dataset.connection = key; input.value = draft?.connections?.[key] ?? '';
      expressionLabel.append(input); $('expressions').append(expressionLabel);
      const roleLabels = { react: 'React 렌더러', logger: '로그 출력', console: '콘솔 출력', clock: '시각', random: '난수', uuid: 'UUID 생성', 'session-storage': '세션 저장소', 'event-source': 'SSE 연결', http: 'HTTP 전송' };
      const label = document.createElement('label'); label.textContent = parsing?.connection === key ? '검증 규칙' : roleLabels[scenario.connectionRoles?.[key]] || '실제 협력자 · ' + key;
      const select = document.createElement('select'); select.dataset.choice = key;
      const placeholder = document.createElement('option'); placeholder.value = ''; placeholder.textContent = parsing?.connection === key ? '적용할 검증 규칙을 선택하세요' : '연결할 실제 대상을 선택하세요'; select.append(placeholder);
      const choices = collaboratorChoices(module, scenario, key);
      for (const [index, choice] of choices.entries()) {
        const option = document.createElement('option'); option.value = String(index); option.textContent = choice.label; select.append(option);
      }
      const custom = document.createElement('option'); custom.value = 'custom'; custom.textContent = '직접 연결 · 개발자 설정'; select.append(custom);
      const savedKey = draft?.selections?.[key]?.key;
      const match = choices.findIndex(choice => (savedKey && (choice.key || choice.expression) === savedKey) || (choice.expression && choice.expression === input.value && (!choice.environment || choice.environment === draft?.environment)) || choice.legacyExpression === input.value || (choice.factory && (input.value.startsWith(choice.factory + '(') || input.value.startsWith(choice.legacyFactory + '('))));
      select.value = match >= 0 ? String(match) : input.value ? 'custom' : '';
      label.append(select);
      const fields = document.createElement('div'); fields.dataset.fields = key;
      $('connections').append(label, fields);
      if (select.value !== 'custom') applyChoice(select, true);
    }
    for (const [key, value] of Object.entries(scenario.values)) {
      const label = document.createElement('label'); label.textContent = /stream/i.test(key) ? '이벤트 스트림 주소' : /url/i.test(key) ? 'HTTP 서버 주소' : key;
      const input = document.createElement('input'); input.dataset.value = key; input.value = draft?.values?.[key] ?? value; input.placeholder = 'https://stage.example.com'; label.append(input); $('values').append(label);
    }
    $('network').replaceChildren();
    if (scenario.network) {
      const label = document.createElement('label'); label.textContent = '연결할 서버';
      const select = document.createElement('select'); select.dataset.networkMode = 'true';
      for (const [value, title] of [['', '실제 연결 대상을 선택하세요'], ['local', '이 컴퓨터의 시나리오 검증 서버'], ['external', '직접 지정한 실제 서버']]) {
        const option = document.createElement('option'); option.value = value; option.textContent = title; select.append(option);
      }
      select.value = draft?.networkMode || ''; label.append(select); $('network').append(label);
      const hint = document.createElement('p'); hint.className = 'hint'; hint.textContent = '시나리오 검증 서버는 테스트에서 읽은 응답·이벤트 데이터로 실제 HTTP/SSE 통신을 재현합니다.'; $('network').append(hint);
      const address = [...document.querySelectorAll('[data-value]')].find(field => field.dataset.value === scenario.network.valueKey);
      address.parentElement.hidden = select.value !== 'external';
    }
    if (!scenario.connections.length && !Object.keys(scenario.values).length) {
      const message = document.createElement('p'); message.textContent = '이 시나리오는 실행 환경의 실제 API를 사용합니다.'; $('connections').append(message);
    }
    renderResult(results[selected]);
    readiness();
  }
  draw();
  $('scenario').onchange = () => { save(); selected = $('scenario').value; draw(); };
  document.addEventListener('input', event => {
    if (event.target.id === 'scenario') return;
    if (event.target.dataset.networkMode) {
      const address = [...document.querySelectorAll('[data-value]')].find(field => field.dataset.value === current().network.valueKey);
      address.parentElement.hidden = event.target.value !== 'external';
    }
    if (event.target.dataset.choice !== undefined) applyChoice(event.target);
    if (event.target.dataset.fieldOwner !== undefined) {
      const key = event.target.dataset.fieldOwner;
      const select = [...document.querySelectorAll('[data-choice]')].find(el => el.dataset.choice === key);
      const choice = collaboratorChoices(module, current(), key)[Number(select.value)];
      const input = [...document.querySelectorAll('[data-connection]')].find(el => el.dataset.connection === key);
      input.value = fieldExpression(key, choice);
    }
    if (event.target.dataset.connection !== undefined) {
      const select = [...document.querySelectorAll('[data-choice]')].find(el => el.dataset.choice === event.target.dataset.connection);
      select.value = 'custom';
    }
    revision++; save(); delete results[selected];
    renderResult(); $('status').textContent = '변경됨 · 재실행 필요';
    readiness(); send({ type: 'invalidate', scenarioId: selected });
  });
  window.addEventListener('message', event => {
    if (event.source !== parent || event.data?.connectedNodeResult?.requestId !== window.pendingRequest) return;
    window.finishNode?.(event.data.connectedNodeResult);
  });
  $('run').onclick = async () => {
    if (busy || $('run').disabled) return;
    save();
    const id = selected, version = revision, draft = drafts[id];
    let localTarget;
    busy = true; $('scenario').disabled = true; $('status').textContent = '실제 협력자로 검증 중'; readiness();
    try {
      const seed = JSON.parse(draft.seed);
      if (!seed || Array.isArray(seed) || typeof seed !== 'object') throw new Error('저장소 초기값은 JSON 객체여야 합니다.');
      const input = { ...draft, values: { ...draft.values }, seed };
      if (current().network && draft.networkMode === 'local') {
        const response = await fetch('/api/runs/' + encodeURIComponent(options.runId) + '/connected-targets', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ scenarioId: id }) });
        const target = await response.json();
        if (!response.ok) throw new Error(target.error);
        localTarget = { ...target, control: '/api/runs/' + encodeURIComponent(options.runId) + '/connected-targets/' + target.id };
        input.values[current().network.valueKey] = target.url;
        if (current().network.kind === 'sse') input.values.__emitUrl = localTarget.control + '/emit';
      }
      send({ type: 'invalidate', scenarioId: id });
      let result;
      if (draft.environment === 'node') {
        const requestId = crypto.randomUUID(); window.pendingRequest = requestId;
        result = await withTimeout(new Promise(resolve => {
          window.finishNode = response => resolve(response.result || { status: 'failed', checks: [], reason: response.error });
          send({ type: 'node', requestId, scenarioId: id, input });
        }));
      } else result = await withTimeout(executeConnectedScenario(input, window.__stageModules, options.definition.symbols, window.__stageRenderHook));
      if (localTarget) {
        const response = await fetch(localTarget.control, { method: 'DELETE' });
        if (!response.ok) throw new Error('실제 서버 통신 기록 조회에 실패했습니다.');
        result.network = { target: 'local', url: localTarget.url, ...await response.json() };
        localTarget = undefined;
      }
      if (revision !== version) result = { ...result, status: 'failed', reason: '실행 중 구성이 변경되었습니다. 재실행하세요.' };
      results[id] = result; renderResult(result);
      if (revision === version) send({ type: 'result', scenarioId: id, input, result });
    } catch (error) {
      renderResult({ status: 'failed', checks: [], reason: String(error.stack || error) });
      send({ type: 'invalidate', scenarioId: id });
    } finally {
      if (localTarget) await fetch(localTarget.control, { method: 'DELETE' }).catch(() => {});
      busy = false; $('scenario').disabled = false; readiness();
    }
  };
}
