// 스테이지 UI. 실행 상태의 원본은 서버이며, 이 화면은 서버 상태(SSE)를 표시하고 사용자 조작을 서버로 보낸다.
// 화면 구성: 첫 진입(드롭) → 작업 화면(왼쪽 실행 순서 큐 + 오른쪽 단계별 화면: 분석·1단계·2단계·3단계·보고서).
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const j = (v) => esc(JSON.stringify(v, null, 2));
const state = { meta: null, items: [], cur: null, seq: 0, analyzing: false, openJobs: new Set() };

// 오류·안내는 모달(alert)이 아니라 화면에 남는 알림으로 보여준다. 닫을 때까지 유지되고 스크린리더가 읽는다.
function notify(message, kind = 'error') {
  const t = document.getElementById('toast');
  if (!t) return;
  t.className = `toast ${kind}`;
  t.replaceChildren();
  const text = document.createElement('span'); text.textContent = String(message);
  const close = document.createElement('button'); close.type = 'button'; close.className = 'link'; close.textContent = '닫기'; close.onclick = () => t.classList.add('hidden');
  t.append(text, ' ', close);
}

async function api(method, url, body) {
  const r = await fetch(url, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error ?? `HTTP ${r.status}`);
  return data;
}
const L = (k, v) => state.meta?.labels?.[k]?.[v] ?? v;
const badge = (cls, text) => `<span class="badge ${cls}">${esc(text)}</span>`;
const locText = (l) => (l ? `${l.file}:${l.line}:${l.column}` : '');

// ---- 값 표시(타입 보존) ----
function show(v) {
  if (v && typeof v === 'object' && !Array.isArray(v) && v.$stage) {
    switch (v.$stage) {
      case 'undefined': return 'undefined';
      case 'error': return `${v.name}: ${v.message}${v.props ? ' ' + JSON.stringify(v.props) : ''}`;
      case 'construct': return `new ${v.export}(${(v.args ?? []).map(show).join(', ')})`;
      case 'regexp': return `/${v.source}/${v.flags}`;
      case 'function': return `ƒ ${v.name}`;
      case 'object': return `${v.ctor} ${JSON.stringify(v.fields)}`;
      case 'double': return `[대체 객체 ${v.id}]`;
      case 'unknown': return `⟨연결 필요: ${v.reason}⟩`;
      default: return JSON.stringify(v);
    }
  }
  return JSON.stringify(v);
}

// ---- 항목(드롭한 파일 하나 = 큐 한 칸) ----
function newItem(name) {
  const it = { id: ++state.seq, name, file: null, phase: 'waiting', error: null, analysis: null, run: null, step: 'analysis', follow: true, opsEl: document.createElement('div'), opForms: {}, mode: {}, entered: false, delay: 0 };
  state.items.push(it);
  return it;
}
const isTerminal = (s) => !['queued', 'running', 'preparing'].includes(s);
// 실행 상태를 서버에서 다시 읽어 반영한다. SSE 이벤트가 POST 응답보다 먼저 도착해 무시되거나 연결이 끊긴 사이의 변화를 놓쳐도 최종 상태에 수렴하게 한다.
async function refreshRun(it) {
  if (!it.run) return;
  try {
    const run = await api('GET', `/api/runs/${it.run.id}`);
    if (it.run?.id !== run.id || JSON.stringify(it.run) === JSON.stringify(run)) return;
    it.run = run; autoStep(it); renderQueue(); if (state.cur === it) renderDetail();
  } catch { /* 일시적 실패는 다음 주기에 재시도 */ }
}
const runLive = (it) => it.run && it.run.stages.some((s) => !isTerminal(s.status));
setInterval(() => { for (const it of state.items) if (runLive(it)) refreshRun(it); }, 2000);

const activeIdx = (run) => run.stages.findIndex((s) => !isTerminal(s.status));

function itemTone(it) {
  if (it.phase === 'error') return ['bad', '분석 실패'];
  if (it.phase === 'waiting') return ['wait', '대기 중'];
  if (it.phase === 'analyzing') return ['run', '분석 중'];
  const r = it.run;
  if (!r) {
    const linked = it.analysis.input.linkStatus === 'linked';
    return linked ? ['warn', `분석됨 · ${L('SUPPORT_LABEL', it.analysis.status)} · 실행 전`] : ['warn', '프로젝트 연결 없음 · 실행 불가'];
  }
  if (r.cancelled) return ['bad', '취소됨'];
  const bad = r.stages.findIndex((s) => s.status === 'failed' || s.status === 'timeout');
  if (bad >= 0) return ['bad', `${bad + 1}단계 ${L('EXEC_LABEL', r.stages[bad].status)}`];
  const a = activeIdx(r);
  if (a >= 0) {
    const s = r.stages[a];
    if (a === 2 && (s.status === 'preparing' || s.status === 'running')) return ['run', '3단계 · 사용자 조작 대기'];
    return ['run', s.status === 'queued' ? `${a + 1}단계 큐 대기` : `${a + 1}단계 실행 중`];
  }
  return r.stages.every((s) => s.status === 'passed') ? ['ok', '3단계까지 완료'] : ['warn', '완료(일부 미실행)'];
}

// ---- 화면 전환 ----
function autoStep(it) {
  if (!it.follow) return;
  const r = it.run;
  if (!r) { it.step = 'analysis'; return; }
  const bad = r.stages.findIndex((s) => s.status === 'failed' || s.status === 'timeout');
  const a = activeIdx(r);
  it.step = a >= 0 ? `s${a + 1}` : bad >= 0 ? `s${bad + 1}` : 'report';
}
function select(it) { state.cur = it; renderAll(); }

function renderAll() {
  const has = state.items.length > 0;
  $('#home').classList.toggle('hidden', has);
  $('#work').classList.toggle('hidden', !has);
  document.body.classList.toggle('on-home', !has);
  renderQueue();
  if (state.cur) renderDetail();
}

// ---- 실행 순서 큐 ----
function renderQueue() {
  $('#q-count').textContent = state.items.length ? `${state.items.length}개` : '';
  $('#queue').innerHTML = state.items.map((it, i) => {
    const [tone, text] = itemTone(it);
    const pips = it.run ? it.run.stages.map((s) => `<i class="st-${esc(s.status)}" title="${esc(s.title)}: ${esc(L('EXEC_LABEL', s.status))}"></i>`).join('') : '<i></i><i></i><i></i>';
    const enter = !it.entered ? ' enter' : '';
    it.entered = true;
    return `<li class="q t-${tone}${state.cur === it ? ' on' : ''}${it.phase === 'analyzing' ? ' analyzing' : ''}${enter}" data-id="${it.id}" style="--i:${it.delay}" tabindex="0" role="button"><span class="q-no">${i + 1}</span><div><div class="q-name" title="${esc(it.name)}">${esc(it.name)}</div><div class="q-state">${esc(text)}</div></div><span class="pips">${pips}</span></li>`;
  }).join('');
  const ready = state.items.filter(canEnqueue);
  $('#run-all').disabled = !ready.length;
  $('#run-all').textContent = ready.length ? `전체 실행 (${ready.length})` : '전체 실행';
}
const canEnqueue = (it) => it.phase === 'ready' && !it.run && it.analysis?.input.linkStatus === 'linked';
$('#queue').addEventListener('click', (e) => { const li = e.target.closest('.q'); if (li) select(state.items.find((x) => x.id === Number(li.dataset.id))); });
$('#queue').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.target.closest('.q')?.click(); } });
$('#run-all').onclick = async () => {
  $('#run-all').disabled = true;
  for (const it of state.items.filter(canEnqueue)) await enqueue(it);
};

async function enqueue(it) {
  try {
    it.run = await api('POST', '/api/runs', { analysisId: it.analysis.id });
    it.follow = true; autoStep(it);
    loadHistory();
  } catch (e) { notify(e.message); }
  renderAll();
  refreshRun(it);
}

// ---- 드롭·파일 선택: 여러 개를 놓으면 순서대로 쌓이고 하나씩 분석 ----
let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types ?? [])].includes('Files');
document.addEventListener('dragenter', (e) => { if (hasFiles(e)) { dragDepth++; document.body.classList.add('dragging'); } });
document.addEventListener('dragleave', (e) => { if (hasFiles(e) && --dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dragging'); } });
document.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
document.addEventListener('drop', (e) => { if (!hasFiles(e)) return; e.preventDefault(); dragDepth = 0; document.body.classList.remove('dragging'); addFiles([...e.dataTransfer.files]); });
for (const sel of ['#file', '#file2']) $(sel).addEventListener('change', (e) => { addFiles([...e.target.files]); e.target.value = ''; });
for (const sel of ['#drop', '#mini-drop']) {
  $(sel).addEventListener('click', (e) => { if (!e.target.closest('label')) $(sel === '#drop' ? '#file' : '#file2').click(); });
  $(sel).addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $(sel === '#drop' ? '#file' : '#file2').click(); } });
}

function addFiles(files) {
  const ok = files.filter((f) => /\.(m?[jt]sx?)$/.test(f.name));
  if (!ok.length) return;
  ok.forEach((f, i) => { const it = newItem(f.name); it.file = f; it.delay = i; });
  if (!state.cur) state.cur = state.items[0];
  renderAll();
  pump();
}
async function pump() {
  if (state.analyzing) return;
  state.analyzing = true;
  for (let it; (it = state.items.find((x) => x.phase === 'waiting')); ) {
    it.phase = 'analyzing'; renderAll();
    try {
      it.analysis = await api('POST', '/api/analyze', { fileName: it.file.name, content: await it.file.text() });
      it.phase = 'ready';
    } catch (e) { it.phase = 'error'; it.error = e.message; }
    it.file = null;
    renderAll();
  }
  state.analyzing = false;
}

// ---- 첫 화면: 프로젝트·기록 ----
$('#add-project').onclick = () => $('#add-project-help').classList.toggle('hidden');
function renderProjects() {
  const ps = state.meta.projects;
  $('#projects').innerHTML = ps.length
    ? ps.map((p) => `<code>${esc(p)} <button class="link rm-project" data-p="${esc(p)}" type="button" aria-label="등록 해제">×</button></code>`).join('')
    : '<span class="muted small">없음 — 아래에서 등록하세요</span>';
  if (!ps.length) $('#add-project-help').classList.remove('hidden');
}
$('#projects').onclick = async (e) => {
  const b = e.target.closest('.rm-project'); if (!b) return;
  try { Object.assign(state.meta, await api('DELETE', '/api/projects', { path: b.dataset.p })); renderProjects(); } catch (err) { $('#project-err').textContent = err.message; }
};
$('#add-project-help').onsubmit = async (e) => {
  e.preventDefault();
  const inp = $('#project-path');
  try {
    Object.assign(state.meta, await api('POST', '/api/projects', { path: inp.value }));
    inp.value = ''; $('#project-err').textContent = ''; renderProjects();
  } catch (err) { $('#project-err').textContent = err.message; }
};

async function loadHistory() {
  const runs = await api('GET', '/api/runs');
  const html = runs.length ? runs.slice(0, 12).map((r) => `<button class="hist-row" data-open="${esc(r.id)}"><span class="nm" title="${esc(r.testFile.path)}">${esc(r.testFile.path)}</span><span>${r.stages.map((s) => badge('s-' + s, L('EXEC_LABEL', s))).join(' ')}</span><span class="loc">${esc(r.id)}${r.rerunOf ? ' ↻' : ''}</span></button>`).join('') : '';
  $('#history-home').innerHTML = html;
  $('#history-rail').innerHTML = html || '<span class="muted small">없음</span>';
  $('#recent').classList.toggle('hidden', !runs.length);
  for (const b of document.querySelectorAll('[data-open]')) b.onclick = () => openRun(b.dataset.open);
}
async function openRun(id) {
  let it = state.items.find((x) => x.run?.id === id);
  if (!it) {
    const run = await api('GET', `/api/runs/${id}`);
    it = newItem(run.testFile.path);
    it.analysis = await api('GET', `/api/analyses/${run.analysisId}`);
    it.run = run; it.phase = 'ready'; autoStep(it);
  }
  select(it);
}

// ---- 상세: 헤더 + 단계 이동 ----
const STEPS = [
  { key: 'analysis', title: '분석', sub: (it) => (it.analysis ? L('SUPPORT_LABEL', it.analysis.status) : '') },
  { key: 's1', title: '1단계', sub: () => '원본 테스트' },
  { key: 's2', title: '2단계', sub: () => '배포 후보' },
  { key: 's3', title: '3단계', sub: () => 'Stage 연계' },
  { key: 'report', title: '보고서', sub: () => '통합 판단' },
];
function stepStatus(it, key) {
  if (key === 'analysis') return it.analysis ? 's-' + it.analysis.status : 's-not-run';
  if (key === 'report') return it.run ? (it.run.stages.every((s) => s.status === 'passed') ? 's-passed' : 's-not-run') : 's-not-run';
  return 's-' + (it.run?.stages[Number(key[1]) - 1].status ?? 'not-run');
}
function renderStepper(it) {
  $('#stepper').innerHTML = STEPS.map((s) => `<button type="button" data-step="${s.key}" class="${it.step === s.key ? 'on' : ''}" ${s.key !== 'analysis' && !it.run ? 'disabled' : ''} aria-current="${it.step === s.key ? 'step' : 'false'}"><b><i class="dot ${stepStatus(it, s.key)}"></i>${esc(s.title)}</b><span>${esc(s.sub(it))}</span></button>`).join('');
  for (const b of $('#stepper').querySelectorAll('button')) b.onclick = () => { const c = state.cur; c.step = b.dataset.step; c.follow = false; renderDetail(); };
}

function renderDetail() {
  const it = state.cur;
  state.openJobs = new Set([...document.querySelectorAll('details.job[open]')].map((d) => d.dataset.job));
  $('#d-title').textContent = it.name;
  const [, text] = itemTone(it);
  $('#d-sub').textContent = it.run ? `${it.run.id}${it.run.rerunOf ? ` · 재실행 원본 ${it.run.rerunOf}` : ''} · ${text}` : text;
  const r = it.run;
  $('#cancel').classList.toggle('hidden', !r);
  $('#rerun').classList.toggle('hidden', !r);
  if (r) {
    $('#cancel').disabled = !!r.cancelled || r.stages.every((s) => isTerminal(s.status));
    $('#cancel').onclick = async () => { await api('POST', `/api/runs/${r.id}/cancel`); };
    $('#rerun').onclick = async () => {
      const n = newItem(it.name); n.analysis = it.analysis; n.phase = 'ready';
      n.run = await api('POST', `/api/runs/${r.id}/rerun`); n.follow = true; autoStep(n); select(n); loadHistory(); refreshRun(n);
    };
  }
  renderStepper(it);
  for (const s of STEPS) $(`#screen-${s.key}`).classList.toggle('on', s.key === it.step);
  if (it.phase === 'error') { $('#analysis').innerHTML = `<p class="s-fail">분석 실패: ${esc(it.error)}</p>`; $('#an-status').innerHTML = ''; return; }
  if (it.phase !== 'ready') { $('#analysis').innerHTML = `<p class="muted">${it.phase === 'analyzing' ? '분석 중… (TypeScript parser·type checker)' : '앞선 파일의 분석이 끝나면 시작합니다.'}</p>`; $('#an-status').innerHTML = ''; return; }
  renderAnalysis(it);
  if (r) { renderStageScreens(it); renderOps(it); renderReport(it); }
  else for (const k of ['s1', 's2']) $(`#${k}-head`).innerHTML = `<div class="empty">아직 실행하지 않았습니다. 분석 화면에서 실행 큐에 적재하세요.</div>`;
}

// ---- 분석 화면 ----
function findingList(fs) {
  if (!fs.length) return '';
  return `<ul class="small">${fs.map((f) => `<li>${badge('s-' + ({ mismatch: 'contract-mismatch', 'no-target': 'no-target', info: 'not-applicable' }[f.level] ?? f.level), f.level)} <code>${esc(f.ruleId)}</code> ${esc(f.message)} <span class="loc">${esc(locText(f.loc))}</span>${f.evidence ? `<br><code class="muted">${esc(f.evidence)}</code>` : ''}</li>`).join('')}</ul>`;
}

function stepText(st, sc) {
  if (st.kind === 'construct') {
    const t = sc.targets.find((x) => x.id === st.target);
    return `<b>준비</b> new ${esc(t?.publicApi.exportName ?? t?.sourceExport)}(${st.args.map((a) => a.kind === 'double' ? `[대체 ${esc(a.id)}]` : esc(show(a.value))).join(', ')})`;
  }
  if (st.kind === 'call') return `<b>동작</b> ${st.instance ? '.' : ''}${esc(st.method ?? sc.targets.find((x) => x.id === st.target)?.publicApi.exportName)}(${st.args.map((a) => a.kind === 'double' ? `[대체 ${esc(a.id)}]` : esc(show(a.value))).join(', ')}) ${st.awaited ? 'await' : ''} → <code>${esc(st.returnsText)}</code>`;
  const c = st.check;
  if (c.kind === 'unsupported') return `<b>검증</b> ${badge('s-unsupported', '미지원')} <code>${esc(c.source)}</code>`;
  return `<b>검증</b> <code>${esc(c.source)}</code>`;
}

function renderAnalysis(it) {
  const a = it.analysis;
  $('#an-status').innerHTML = badge('s-' + a.status, L('SUPPORT_LABEL', a.status));
  const linkBadge = a.input.linkStatus === 'linked' ? badge('s-pass', '프로젝트 연결됨') : badge('s-partial', '프로젝트 연결 없음');
  const p = a.project;
  const canRun = a.input.linkStatus === 'linked';
  $('#analysis').innerHTML = `
    ${!it.run ? `<div class="row gap confirm" style="margin:0 0 1rem"><button class="btn primary" id="enqueue" ${canRun ? '' : 'disabled'}>실행 큐에 적재 (1→2→3단계)</button>
    <span class="muted small">${canRun ? '자동 실행 가능 시나리오만 2단계에서 실행되고, 나머지는 미실행으로 표시됩니다.' : '프로젝트에 연결되지 않은 파일은 실행할 수 없습니다.'}</span></div>` : ''}
    <div class="small">${linkBadge} <code>${esc(a.input.fileName)}</code> sha256 <code>${esc(a.input.sha256.slice(0, 16))}…</code> · ${esc(a.input.linkEvidence)} · 분석 규칙 <code>${esc(a.rulesVersion)}</code> · 분석 ID <code>${esc(a.id)}</code></div>
    ${p ? `<div class="small">프로젝트 <b>${esc(p.name)}@${esc(p.version)}</b> · git ${esc(p.git?.commit?.slice(0, 10) ?? p.git?.error ?? '-')} ${p.git?.dirty ? badge('s-partial', '작업 트리 변경 있음') : ''} · 러너: ${esc(p.runner?.evidence)}${p.packageDirEvidence ? `<br>배포 단위: <code>${esc(p.packageDir)}</code> — ${esc(p.packageDirEvidence)}` : ''}<br>공개 entry: ${p.publicEntries.map((e) => `<code>${esc(e.specifier)}</code> — ${esc(e.evidence)}`).join('<br>')}</div>` : ''}
    ${a.stageConfig ? `<div class="small">스테이지 힌트: ${a.stageConfig.present ? `<code>stage.config.json</code> sha256 ${esc(a.stageConfig.sha256.slice(0, 12))}…` : '없음(컨슈머 초기화 경로 미연결)'}</div>` : ''}
    ${findingList(a.findings)}
    <h3>import</h3>
    <table><tr><th>지정자</th><th>종류</th><th>역할</th><th>이름</th><th>근거</th></tr>${a.imports.map((i) => `<tr><td><code>${esc(i.specifier)}</code></td><td>${esc(i.kind)}</td><td>${esc(i.role)}</td><td class="small">${esc(i.names.join(', '))}</td><td class="small">${esc(i.evidence)} <span class="loc">${esc(locText(i.loc))}</span></td></tr>`).join('')}</table>
    <h3>시나리오 ${a.scenarios.length}개</h3>
    ${a.scenarios.map((sc) => `
      <div class="card">
        <h4>${badge('s-' + sc.support.status, L('SUPPORT_LABEL', sc.support.status))} ${esc(sc.path.join(' › '))} <span class="loc">${esc(locText(sc.loc))}</span> <span class="muted small">${esc(sc.runKind)}</span></h4>
        <div class="small">대상: ${sc.targets.map((t) => `<code>${esc(t.sourceExport)}</code> (${esc(t.sourceFile)}) → ${t.publicApi.status === 'mapped' ? `공개 <code>${esc(t.publicApi.specifier)}</code>.<code>${esc(t.publicApi.exportName)}</code>` : badge('s-partial', '공개 API 대응 없음')} <span class="muted">${esc(t.publicApi.evidence)}</span>`).join('<br>') || '없음'}</div>
        ${sc.doubles.length ? `<div class="small">대체 객체(협력 관계): ${sc.doubles.map((d) => `<code>${esc(d.varName)}</code>${d.collaboratorOf ? ` → 매개변수 <code>${esc(d.collaboratorOf.param)}: ${esc(d.collaboratorOf.type)}</code>` : ''} { ${Object.entries(d.methods).map(([m, s]) => `${esc(m)}: ${esc(s.behavior.kind)}${'value' in s.behavior ? ' ' + esc(show(s.behavior.value)) : ''}`).join('; ')} }`).join('<br>')}</div>` : ''}
        <ol class="steps small">${sc.steps.map((st) => `<li>${stepText(st, sc)} <span class="loc">${esc(locText(st.loc ?? st.check?.loc))}</span></li>`).join('')}</ol>
        ${sc.teardown.length ? `<div class="small">정리: ${sc.teardown.map((t) => esc(t.kind)).join(', ')}</div>` : ''}
        ${sc.consumerLink ? `<div class="small">컨슈머 연결: ${sc.consumerLink.status === 'linked' ? badge('s-pass', '연결') : badge('s-partial', '미연결')} ${esc(sc.consumerLink.evidence)}</div>` : ''}
        ${findingList(sc.support.findings)}
      </div>`).join('')}`;
  const b = $('#enqueue');
  if (b) b.onclick = () => { b.disabled = true; enqueue(it); };
}

// ---- 1·2단계 화면 ----
function checksTable(checks) {
  if (!checks?.length) return '<p class="muted small">검증 없음</p>';
  return `<table class="small"><tr><th>판정</th><th>검증</th><th>출처</th><th>기대</th><th>실제</th><th>근거</th></tr>${checks.map((c) => `<tr><td>${badge('s-' + c.status, { pass: '통과', fail: '실패', 'not-applicable': '비교 제외', invalidated: '무효(입력 변경)', 'not-run': '미실행' }[c.status])}</td><td><code>${esc(c.label)}</code> <span class="loc">${esc(locText(c.loc))}</span></td><td>${esc({ 'original-test': '원본 테스트', 'public-contract': '공개 계약', 'stage-config': '스테이지 힌트', runtime: '실행' }[c.origin])}</td><td class="mono">${c.expected !== undefined ? esc(show(c.expected)) : ''}</td><td class="mono">${c.actual !== undefined ? esc(show(c.actual)) : ''}</td><td>${esc(c.reason)}</td></tr>`).join('')}</table>`;
}

function outcomeDetail(o) {
  if (!o) return '';
  const net = o.network?.length ? `<h4 class="small">통신 증거 (${o.network.length}건)</h4><table class="small"><tr><th>#</th><th>모드</th><th>요청</th><th>상태</th><th>시간</th><th>헤더(인증값 가림)</th><th>근거</th></tr>${o.network.map((n) => `<tr><td>${n.seq}</td><td>${n.intercepted ? 'mock 가로챔' : n.blocked ? '차단' : '실제 요청'}</td><td class="mono">${esc(n.method)} ${esc(n.url)}${n.requestBody !== undefined ? `<br>${esc(show(n.requestBody))}` : ''}</td><td>${esc(n.status ?? n.error ?? '')}</td><td>${n.durationMs ?? ''}ms</td><td class="mono">${esc(JSON.stringify(n.requestHeaders))}</td><td>${esc(n.source)}</td></tr>`).join('')}</table>` : '<p class="small muted">통신 없음</p>';
  const ev = o.events?.length ? `<h4 class="small">관찰한 호출 순서(실제 실행 이벤트)</h4><ol class="timeline">${o.events.map((e) => `<li>[${e.at}ms] ${esc({ action: '동작', 'double-call': '협력 객체 호출', 'action-result': '결과' }[e.kind])} ${esc(e.name)}${e.args ? `(${e.args.map(show).map(esc).join(', ')})` : ''}${e.result !== undefined ? ` → ${esc(show(e.result))}` : ''}${e.error ? ` ✕ ${esc(show(e.error))}` : ''}${e.durationMs !== undefined ? ` · ${e.durationMs}ms` : ''}</li>`).join('')}</ol>` : '';
  return `${o.linkVerdict ? `<p>실제 연계 결과: ${badge('v-' + o.linkVerdict, L('LINK_LABEL', o.linkVerdict))} ${esc(o.verdictReason)}</p>` : o.verdictReason ? `<p>실제 연계 결과: ${badge('s-partial', '판정 없음')} ${esc(o.verdictReason)}</p>` : ''}
    ${o.returned !== undefined ? `<p class="small">반환값: <code>${esc(show(o.returned))}</code></p>` : ''}${o.error ? `<p class="small s-fail">오류: <code>${esc(show(o.error))}</code></p>` : ''}
    ${checksTable(o.checks)}${ev}${net}${o.logs?.length ? `<pre>${esc(o.logs.join('\n'))}</pre>` : ''}`;
}

function jobView(job) {
  const s1 = job.stage1;
  return `<details class="job" ${state.openJobs?.has(job.id) ? 'open' : ''} data-job="${esc(job.id)}"><summary>${badge('s-' + job.status, L('EXEC_LABEL', job.status))} <span class="muted small">${job.stage}단계</span> ${esc(job.label)} ${job.mode ? `<span class="muted small">[${esc(job.mode)}]</span>` : ''} <span class="muted small">${job.durationMs !== undefined ? job.durationMs + 'ms' : ''} · 제한 ${job.timeoutMs}ms</span></summary>
    <div class="body small">${esc(job.reason ?? '')}
      ${job.input ? `<p>입력: 원본 <code>${esc(job.input.originalArgs.map(show).join(', '))}</code> · 사용자 <code>${esc(job.input.userArgs.map(show).join(', '))}</code> ${job.input.changed ? badge('s-partial', '사용자 변경') : badge('s-pass', '원본과 동일')}${job.input.frameworkArgs.map((f) => `<br>프레임워크 추가 ${esc(f.path)} = <code>${esc(show(f.value))}</code> (${esc(f.reason)})`).join('')}<br>연결: ${esc(L('MODE_LABEL', job.input.connection.mode))} → ${esc(job.input.connection.target)}</p>` : ''}
      ${s1 ? `<p>명령: <code>${esc(s1.command)}</code> · 종료 코드 ${esc(s1.exitCode)}</p><table><tr><th>테스트</th><th>결과</th><th>위치</th><th>오류</th></tr>${s1.tests.map((t) => `<tr><td>${esc(t.name)}</td><td>${badge('s-' + (t.status === 'pass' ? 'pass' : t.status === 'fail' ? 'fail' : 'not-run'), t.status)}</td><td class="loc">${t.line ?? ''}</td><td>${t.error ? `<code>${esc(t.error.message)}</code>` : ''}</td></tr>`).join('')}</table><pre>${esc(s1.output)}</pre>` : ''}
      ${job.logs?.length ? `<pre>${esc(job.logs.join('\n'))}</pre>` : ''}
      ${outcomeDetail(job.outcome)}
    </div></details>`;
}

function stageCard(s) {
  return `<div class="stage-card st-${esc(s.status)}"><b>${esc(s.title)}</b>${badge('s-' + s.status, L('EXEC_LABEL', s.status))}<div class="r small">${esc(s.reason)}</div></div>`;
}

function renderStageScreens(it) {
  const run = it.run;
  run.stages.forEach((s, i) => { if (i < 2) $(`#s${i + 1}-head`).innerHTML = stageCard(s); });
  const c = run.candidate;
  $('#candidate').innerHTML = c ? `<div class="small card"><b>배포 후보</b> <code>${esc(c.id)}</code><br>tarball sha256 <code>${esc(c.tarballSha256)}</code> · integrity <code>${esc(c.npmIntegrity)}</code><br>파일: ${c.files.map((f) => `<code>${esc(f)}</code>`).join(' ')}<br>경계: ${c.boundary.ok ? badge('s-pass', '도구·테스트 미포함') : badge('s-fail', '포함됨')} ${esc(c.boundary.notes.join('; '))}<br>설치 위치(컨슈머 샌드박스): <code>${esc(c.consumerDir)}</code>${run.contract ? `<br>타입 계약: <code>${esc(run.contract.typesFile ?? '-')}</code> ${findingList(run.contract.findings)}` : ''}</div>` : '';
  const jobsOf = (n, pred = () => true) => run.jobs.filter((jb) => jb.stage === n && pred(jb)).map(jobView).join('');
  $('#s1-jobs').innerHTML = jobsOf(1) || '<p class="muted small">실행 기록 없음</p>';
  $('#s2-jobs').innerHTML = jobsOf(2) || '<p class="muted small">실행 기록 없음</p>';
  $('#s3-jobs').innerHTML = jobsOf(3, (jb) => jb.kind !== 'interaction');
}

// ---- 3단계: 생성 화면 ----
function fieldFor(schema, value, original, onChange, name, optional) {
  const wrap = document.createElement('div');
  const isUndef = (v) => v === undefined || (v && v.$stage === 'undefined');
  const mark = (v) => wrap.classList.toggle('changed', JSON.stringify(v ?? null) !== JSON.stringify(isUndef(original) ? null : original ?? null));
  wrap.className = 'field';
  const label = `<label>${esc(name)}${optional ? '?' : ''} <span class="muted">${esc(kindText(schema))}</span></label>`;
  const allLiteral = schema.kind === 'union' && schema.options.every((o) => o.kind === 'literal');
  if (schema.kind === 'string' || schema.kind === 'number') {
    wrap.innerHTML = `${label}<input type="${schema.kind === 'number' ? 'number' : 'text'}" step="any">`;
    const inp = wrap.querySelector('input');
    inp.value = isUndef(value) ? '' : value;
    inp.oninput = () => { const v = inp.value === '' ? undefined : schema.kind === 'number' ? Number(inp.value) : inp.value; onChange(v); mark(v); };
  } else if (schema.kind === 'boolean') {
    wrap.innerHTML = `${label}<input type="checkbox">`;
    const inp = wrap.querySelector('input');
    inp.checked = !!value;
    inp.onchange = () => { onChange(inp.checked); mark(inp.checked); };
  } else if (schema.kind === 'literal' || allLiteral) {
    const opts = schema.kind === 'literal' ? [schema] : schema.options;
    wrap.innerHTML = `${label}<select>${optional ? '<option value="">(없음)</option>' : ''}${opts.map((o, i) => `<option value="${i}">${esc(JSON.stringify(o.value))}</option>`).join('')}</select>`;
    const sel = wrap.querySelector('select');
    const idx = opts.findIndex((o) => o.value === value);
    sel.value = idx >= 0 ? String(idx) : '';
    sel.onchange = () => { const v = sel.value === '' ? undefined : opts[Number(sel.value)].value; onChange(v); mark(v); };
  } else if (schema.kind === 'object') {
    const fs = document.createElement('fieldset');
    fs.innerHTML = `<legend>${esc(name)}${optional ? '?' : ''}: ${esc(schema.name ?? 'object')}</legend>`;
    const obj = value && typeof value === 'object' && !value.$stage ? value : {};
    for (const [k, p] of Object.entries(schema.props)) {
      if (p.schema.kind === 'function') continue;
      fs.appendChild(fieldFor(p.schema, obj[k], original?.[k], (v) => { if (v === undefined) delete obj[k]; else obj[k] = v; emit(); }, k, p.optional));
    }
    // 선택 인자인 객체를 모두 비우면 인자 자체를 생략한다(빈 객체를 보내면 원본 입력과 달라짐).
    function emit() { onChange(optional && Object.keys(obj).length === 0 ? undefined : obj); }
    emit();
    return fs;
  } else if (schema.kind === 'function') {
    wrap.innerHTML = `${label}<span class="s-partial small">함수 인자 — 실행 구성 연결 필요(화면에서 입력 불가)</span>`;
  } else {
    wrap.innerHTML = `${label}<textarea spellcheck="false"></textarea><div class="hint">JSON 편집 (undefined는 {"$stage":"undefined"})</div>`;
    const ta = wrap.querySelector('textarea');
    ta.value = JSON.stringify(value ?? null, null, 2);
    ta.oninput = () => { try { const v = JSON.parse(ta.value); ta.style.outline = ''; onChange(v); mark(v); } catch { ta.style.outline = '2px solid #c02626'; } };
  }
  mark(value);
  return wrap;
}
function kindText(s) {
  if (s.kind === 'literal') return JSON.stringify(s.value);
  if (s.kind === 'union') return s.options.map(kindText).join(' | ');
  if (s.kind === 'object') return s.name ?? 'object';
  if (s.kind === 'array') return kindText(s.element) + '[]';
  return s.text ?? s.kind;
}

// 직접 호출 프레임의 편집값은 같은 실행 항목에 보관해 판정 확정 후에도 내보낸다.
window.addEventListener('message', async (e) => {
  if (e.data?.connectedScenario !== true) return;
  const it = state.items.find(item => item.run?.id === e.data.runId);
  const frame = [...document.querySelectorAll('.console-frame')].find(f => f.contentWindow === e.source);
  if (!it || !frame || (frame.src && e.origin !== new URL(frame.src).origin)) return;
  const data = e.data;
  try {
    const response = await api('POST', `/api/runs/${it.run.id}/connected-scenario`, data);
    if (data.type === 'node') frame.contentWindow.postMessage({ connectedNodeResult: { requestId: data.requestId, result: response.result } }, e.origin);
    else {
      const latest = it.run.connected.sequences?.[data.scenarioId] ?? 0;
      if ((response.connected?.sequences?.[data.scenarioId] ?? 0) < latest) return;
      it.run.connected = response.connected;
      const count = Object.values(response.results).filter(r => r.result.status === 'passed').length;
      const status = document.querySelector('.connected-progress');
      if (status) status.textContent = `실제 협력자 기대 결과 ${count}/${it.run.connected.definition.scenarios.length}개 통과`;
      $('#complete3').disabled = !['running', 'preparing'].includes(it.run.stages[2].status) || count !== it.run.connected.definition.scenarios.length;
    }
  } catch (error) {
    frame.contentWindow.postMessage({ connectedNodeResult: { requestId: data.requestId, error: error.message } }, e.origin);
    if (data.type !== 'node') notify('실행 결과 저장 실패: ' + error.message);
  }
});
window.addEventListener('message', (e) => {
  if (e.data?.stageCode !== true) return;
  const it = state.cur;
  if (!it?.run || e.data.runId !== it.run.id) return;
  const frame = [...document.querySelectorAll('.console-frame, .live-frame')].find((f) => f.contentWindow === e.source);
  if (!frame || (frame.src && e.origin !== new URL(frame.src).origin)) return;
  it.liveDrafts ??= { scenarios: {} };
  if (frame.classList.contains('console-frame') && typeof e.data.code === 'string') it.liveDrafts.console = e.data.code;
  if (frame.dataset.sid === e.data.scenarioId && typeof e.data.args === 'string' && typeof e.data.seed === 'string') it.liveDrafts.scenarios[frame.dataset.sid] = { args: e.data.args, seed: e.data.seed };
});

function renderCodeExport(it) {
  for (const button of document.querySelectorAll('.export-code')) {
    button.disabled = !(it.run?.realEnv?.live || Object.keys(it.playgroundCodes ?? {}).length) || !['passed', 'failed'].includes(it.run.stages[2].status);
    button.onclick = async () => {
      button.disabled = true;
      try {
        const response = await fetch(`/api/runs/${it.run.id}/export-code`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...it.liveDrafts, playground: it.playgroundCodes }) });
        if (!response.ok) throw new Error((await response.json()).error);
        const url = URL.createObjectURL(await response.blob());
        const link = document.createElement('a');
        link.href = url; link.download = response.headers.get('content-disposition')?.match(/filename="([^"]+)"/)?.[1] ?? 'Stage3Verification.tsx';
        link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      } catch (e) { notify(e.message); }
      finally { renderCodeExport(it); }
    };
  }
}

// 프로젝트를 모르는 사람을 위한 게이트 요약: 판정, 검증한 것, 못한 것, 지금 할 일을 보고서와 같은 근거로 보여준다.
const gateCache = new Map();
async function renderGateCard(it) {
  const run = it.run; const host = $('#gate-card');
  const key = JSON.stringify([run.id, run.stages.map((s) => s.status), run.jobs.length, run.manual.length, run.signoff?.at, Object.entries(run.connected?.results ?? {}).map(([k, v]) => [k, v.result.status, v.evidence?.modified])]);
  if (gateCache.get(run.id)?.key !== key) {
    gateCache.set(run.id, { key, report: null });
    try { const r = await api('GET', `/api/runs/${run.id}/report`); if (gateCache.get(run.id)?.key === key) gateCache.get(run.id).report = r; } catch { /* 아래에서 표시 */ }
  }
  const r = gateCache.get(run.id)?.report;
  if (!r) { host.innerHTML = '<p class="muted small">게이트 요약을 불러오는 중…</p>'; return; }
  const tone = { 'within-scope-pass': 'pass', conditional: 'partial', 'hold-failure': 'fail', undecided: 'queued' }[r.decision.code];
  const list = (xs, empty) => xs.length ? `<ul class="small">${xs.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : `<p class="small muted">${empty}</p>`;
  host.innerHTML = `<h3>배포 게이트 요약 ${badge('s-' + tone, r.decision.label)}</h3>
    <p><b>지금 할 일:</b> ${esc(r.summary.nextAction)}</p>
    <div class="cols"><div><b class="small">검증한 것</b>${list(r.summary.verified, '아직 없음')}</div><div><b class="small">검증하지 못한 것</b>${list(r.summary.unverified, '없음')}</div></div>
    ${r.decision.reasons.length ? `<details><summary class="small">판정 사유 ${r.decision.reasons.length}건</summary>${list(r.decision.reasons, '')}</details>` : ''}
    <p class="small muted">${r.evidence.signoff ? `확정: ${esc(r.evidence.signoff.by)} · ${esc(r.evidence.signoff.at)}` : '아직 확정되지 않았습니다.'} · 이 요약은 통합 보고서와 같은 근거입니다.</p>`;
}

function renderOps(it) {
  renderCodeExport(it);
  const run = it.run;
  const a = it.analysis;
  const s3 = run.stages[2];
  const active = s3.status === 'preparing' || s3.status === 'running';
  const open = run.stages[1].status === 'passed' || (run.stages[1].status === 'not-run' && !!run.candidate?.source && run.stages[2].status !== 'not-run');
  $('#s3-locked').classList.toggle('hidden', open);
  $('#s3-body').classList.toggle('hidden', !open);
  if (!open) {
    const s2 = run.stages[1];
    $('#s3-locked').textContent = isTerminal(s2.status) ? `2단계가 통과하지 못해 3단계는 열리지 않습니다. (${s2.reason})` : '2단계를 통과하면 이 화면이 열립니다.';
    return;
  }
  $('#env').innerHTML = `<span><b>실행 환경</b> Node ${esc(run.environment.node)} (${esc(run.environment.platform)}) 자식 프로세스</span><span><b>배포 후보</b> <code>${esc(run.candidate?.id)}</code></span>${a.script || run.replayMode ? '' : `<span><b>Stage 대상</b> <code>${esc(run.environment.stageTarget ?? '설정 없음')}</code></span>`}<span><b>3단계</b> ${badge('s-' + s3.status, L('EXEC_LABEL', s3.status))} ${esc(run.connected && active ? '시나리오별 실제 협력자 연결과 기대 결과를 확인하세요.' : s3.reason)}</span>`;
  const connectedPending = run.connected?.definition.scenarios.filter(scenario => run.connected.results[scenario.id]?.result.status !== 'passed').length;
  const syncComplete = () => { $('#complete3').disabled = !active || !!connectedPending || $('#operator').value.trim().length < 2 || !$('#confirm3').checked; };
  $('#operator').oninput = syncComplete; $('#confirm3').onchange = syncComplete;
  if (!$('#operator').value) try { $('#operator').value = localStorage.getItem('stage.operator') ?? ''; } catch {}
  syncComplete();
  $('#complete3').onclick = async () => {
    try { localStorage.setItem('stage.operator', $('#operator').value.trim()); } catch {}
    try { await api('POST', `/api/runs/${run.id}/complete-stage3`, { operator: $('#operator').value.trim(), confirm: $('#confirm3').checked }); $('#confirm3').checked = false; } catch (e) { notify(e.message); }
  };
  renderGateCard(it);
  const sp = $('#script-panel');
  $('#complete3-hint').textContent = run.connected ? '모든 시나리오에서 실제 협력자를 연결하고 기대 결과를 확인하면 판정을 확정할 수 있습니다.' : run.replayMode ? '원본 테스트를 배포 후보 파일로 재실행한 최신 결과로 판정합니다. 브라우저 API에 의존하는 테스트는 mock 결과만으로 통과시키지 않고, 실제 브라우저 검증이 일치해야 통과합니다. 배포본이 한 번도 로드되지 않았거나 배포물에 없는 파일이 있어도 실패입니다.' : a.script ? '배포 exports 런타임 import 검증의 최신 결과와 치환 잔여로 판정합니다. 확인 필요 항목은 사람이 확인해 기록합니다.' : 'Stage 모드 조작의 시나리오별 최신 결과로만 판정합니다. Mock 조작은 별도로 보고합니다.';
  if (run.replayMode) {
    $('#wiring').replaceChildren(); $('#playground').replaceChildren(); $('#ops').replaceChildren();
    renderReplayPanel(it, sp, active);
    $('#manual-list').innerHTML = manualHtml(run);
    return;
  }
  if (a.script) {
    // 스크립트 SUT: 연결 구성·가상 화면·조작 카드 대신 스크립트 실행 결과와 exports 런타임 검증 화면을 보여준다.
    $('#wiring').replaceChildren(); $('#playground').replaceChildren(); $('#ops').replaceChildren();
    renderScriptPanel(it, sp, active);
    $('#manual-list').innerHTML = manualHtml(run);
    return;
  }
  sp.replaceChildren();
  ensureWiring(it);
  ensurePlayground(it);
  const host = $('#ops');
  if (host.firstChild !== it.opsEl) host.replaceChildren(it.opsEl);
  const el = it.opsEl;
  const linked = a.scenarios.filter((sc) => sc.support.status === 'auto' && sc.consumerLink?.status === 'linked');
  const others = a.scenarios.filter((sc) => !linked.includes(sc));
  for (const sc of linked) {
    let card = el.querySelector(`[data-sc="${sc.id}"]`);
    if (!card) {
      card = document.createElement('div');
      card.className = 'card';
      card.dataset.sc = sc.id;
      el.appendChild(card);
      buildOpCard(it, card, sc);
    }
    card.querySelector('.run-btn').disabled = !active;
    const hist = run.jobs.filter((jb) => jb.kind === 'interaction' && jb.scenarioId === sc.id).reverse();
    card.querySelector('.history').innerHTML = hist.length ? hist.map(jobView).join('') : '<p class="muted small">처리 이력 없음</p>';
  }
  let note = el.querySelector('.others');
  if (!note) { note = document.createElement('div'); note.className = 'others small muted'; el.appendChild(note); }
  note.innerHTML = others.length ? `조작 화면을 만들지 않은 시나리오: ${others.map((sc) => `${esc(sc.title)} (${esc(L('SUPPORT_LABEL', sc.support.status))}${sc.consumerLink && sc.consumerLink.status !== 'linked' ? `, ${esc(sc.consumerLink.evidence)}` : ''})`).join('; ')}` : '';
  $('#manual-list').innerHTML = manualHtml(run);
}

const manualHtml = (run) => run.manual.map((m) => `<li>${esc(m.at)} ${badge(m.verdict === 'issue' ? 's-fail' : 's-not-applicable', { confirmed: '확인함', issue: '문제 발견', note: '메모' }[m.verdict])} ${esc(m.target)}: ${esc(m.note)}</li>`).join('');

// ---- 스크립트 SUT(빌드 스크립트): 샌드박스 실행 결과 + 배포 exports 런타임 import 검증 ----
const NODE_LABEL = { ok: ['s-pass', 'Node import 성공'], 'bundler-required': ['s-partial', 'Node 단독 불가'], failed: ['s-failed', 'Node import 실패'], skipped: ['s-not-applicable', 'Node —'] };
const STEP_LABEL = { ok: ['s-pass', '성공'], failed: ['s-failed', '실패'], skipped: ['s-not-applicable', '—'] };
const VERDICT_LABEL = { pass: ['s-pass', '통과'], 'needs-review': ['s-partial', '확인 필요'], fail: ['s-failed', '실패'] };

function renderScriptPanel(it, host, active) {
  const run = it.run;
  const a = it.analysis;
  const sc = run.script;
  const ec = run.exportsCheck;
  if (!it.sp) it.sp = { filter: 'all', open: new Set(['exports']) };
  const st = it.sp;
  if (host.dataset.run !== run.id) { host.dataset.run = run.id; host.replaceChildren(); }
  const running = run.jobs.some((j) => j.kind === 'exports' && (j.status === 'queued' || j.status === 'running'));
  const muts = sc?.mutations ?? [];
  const d = sc?.diff;
  const card = (label, value, sub) => `<div class="metric"><div class="small muted">${esc(label)}</div><div class="mv">${esc(value)}</div><div class="small muted">${esc(sub ?? '')}</div></div>`;
  const rows = (ec?.items ?? []).filter((i) => st.filter === 'all' || i.verdict === st.filter);
  const filterBtn = (k, label) => `<button class="sp-filter ${st.filter === k ? 'on' : ''}" data-f="${k}" type="button">${label}</button>`;
  const section = (id, title, body) => `<details class="job" data-sec="${id}" ${st.open.has(id) ? 'open' : ''}><summary>${title}</summary><div class="body">${body}</div></details>`;
  const mutTable = `<table class="wt">${muts.map((m) => `<tr><td class="muted">${m.seq}</td><td><code>${esc(m.op)}</code></td><td><code>${esc(m.args)}</code>${m.error ? ` ${badge('s-failed', m.error)}` : ''}</td><td class="muted">${m.ms}ms</td></tr>`).join('')}</table>
    <p class="small muted">읽기 연산(횟수만 기록): ${Object.entries(sc?.readCounts ?? {}).map(([k, v]) => `<code>${esc(k)}</code> ${v}회`).join(', ') || '없음'}${sc?.truncated ? ' · 변경 연산이 많아 일부만 기록' : ''}</p>`;
  const list = (items, mark, cls) => items.map((f) => `<div class="small ${cls}"><code>${mark} ${esc(f)}</code></div>`).join('');
  const diffBody = d ? (d.total === 0
    ? `<p class="small muted">${d.baselineExists ? '프로젝트의 기존 dist와 비교해 차이가 없습니다.' : '비교할 기존 dist가 없어 새로 만들어진 산출물 전체가 추가로 표시됩니다.'}</p>`
    : `<p class="small muted">${d.baselineExists ? '프로젝트의 기존 dist와 비교' : '기존 dist 없음 — 전부 새로 생성'}한 변화 ${d.total}개${d.total > 300 ? '(목록은 종류별 300개까지)' : ''}</p>${list(d.added, '+', 'add')}${list(d.changed, '~', 'chg')}${list(d.removed, '−', 'del')}`) : '';
  const leftBody = sc?.leftovers.length
    ? `<p class="small">${badge('s-failed', '치환 잔여')} 배포본에 하위 패키지 이름이 그대로 남은 파일입니다. 배포 후 import가 깨질 수 있습니다.</p><table class="wt">${sc.leftovers.map((l) => `<tr><td><code>${esc(l.file)}</code></td><td><code>${esc(l.name)}</code></td><td class="muted">${l.count}회</td></tr>`).join('')}</table>`
    : '<p class="small muted">하위 패키지 이름이 남은 파일 없음</p>';
  const resultTable = ec ? `<div class="row gap wrap small" style="margin:.4rem 0">${badge('s-pass', `통과 ${ec.counts.pass}`)} ${badge('s-partial', `확인 필요 ${ec.counts['needs-review']}`)} ${badge('s-failed', `실패 ${ec.counts.fail}`)} <span class="muted">총 ${ec.total}개 · ${Math.round(ec.durationMs / 100) / 10}초 · 패턴(./x/*)은 설치된 파일 구조에서 펼침</span>
      <span class="mode">${filterBtn('all', '전체')}${filterBtn('fail', '실패')}${filterBtn('needs-review', '확인 필요')}${filterBtn('pass', '통과')}</span></div>
    ${rows.map((i) => `<div class="exp-row"><div class="exp-h">${badge(...VERDICT_LABEL[i.verdict])}<code>${esc(i.specifier)}</code>${i.pattern ? `<span class="muted small">(${esc(i.pattern)})</span>` : ''}</div>
      <div class="exp-s small"><span class="muted">단계</span> ${badge(...NODE_LABEL[i.node.status])} <span class="muted">번들러 해석</span> ${badge(...STEP_LABEL[i.bundle.status])} <span class="muted">번들 평가</span> ${badge(...STEP_LABEL[i.run.status])}</div>
      <div class="small muted">${esc(i.reason)}</div></div>`).join('') || '<p class="muted small">해당하는 항목 없음</p>'}
    <p class="small muted">자동 통과 처리는 하지 않으며 최종 확인은 아래 수동 확인에 기록합니다.</p>`
    : '<p class="small muted">아직 실행하지 않았습니다. 위 버튼으로 설치된 배포 패키지의 exports를 실제로 import합니다.</p>';
  host.innerHTML = `<div class="card">
    <h4>스크립트 검증 <span class="muted small"><code>${esc(a.script.file)}</code> — ${esc(a.script.evidence)}</span></h4>
    <p class="small muted">원본 테스트는 협력자(${esc(a.script.replaces.join(', ') || '없음')})를 대체 객체로 바꿔 호출 순서만 검증합니다. 여기서는 프로젝트를 임시 폴더로 복사한 샌드박스에서 스크립트를 실제로 실행하고(원본 저장소는 변경되지 않음), 만들어진 배포 패키지를 소비자 샌드박스에 설치해 exports가 실제로 import되는지 확인합니다.</p>
    <div class="metrics">${card('변경 연산', `${muts.length}개`, `읽기 ${Object.values(sc?.readCounts ?? {}).reduce((x, y) => x + y, 0)}회`)}${card('산출물 변화', d ? `${d.total}개` : '—', d?.baselineExists ? `+${d.added.length} ~${d.changed.length} −${d.removed.length}` : '기존 dist 없음')}${card('치환 잔여', `${sc?.leftovers.length ?? 0}개 파일`, sc?.leftovers.length ? '확인 필요' : '없음')}${card('exports 검증', ec ? `${ec.counts.fail ? '실패 ' + ec.counts.fail : '통과'}` : '미실행', ec ? `총 ${ec.total}개` : '')}</div>
    <div class="row gap" style="margin:.6rem 0"><button class="btn primary sp-run" type="button" ${active && !running ? '' : 'disabled'}>${running ? '검증 진행 중…' : ec ? 'exports 런타임 import 다시 검증' : 'exports 런타임 import 검증 실행'}</button><span class="small muted">설치된 ${esc(run.candidate?.packageName ?? '')}의 exports를 Node 직접 import → 번들러 해석 → 번들 평가 순으로 실제 실행합니다.</span></div>
    ${section('exports', `배포 exports 런타임 import 결과 ${ec ? `<span class="muted small">${ec.total}개</span>` : ''}`, resultTable)}
    ${section('timeline', `파일 연산 타임라인 <span class="muted small">실제 fs 호출 ${muts.length}개 · 테스트가 대체 객체로 검증하던 순서</span>`, mutTable)}
    ${section('diff', `산출물 변화 <span class="muted small">${d ? d.total + '개' : ''}</span>`, diffBody)}
    ${section('left', `하위 패키지 이름 치환 잔여 <span class="muted small">${sc?.leftovers.length ?? 0}개 파일</span>`, leftBody)}
  </div>`;
  host.querySelector('.sp-run').onclick = async (e) => { e.target.disabled = true; try { await api('POST', `/api/runs/${run.id}/exports-check`); } catch (err) { notify(err.message); } };
  for (const b of host.querySelectorAll('.sp-filter')) b.onclick = () => { st.filter = b.dataset.f; renderScriptPanel(it, host, active); };
  for (const dEl of host.querySelectorAll('details[data-sec]')) dEl.addEventListener('toggle', () => { if (dEl.open) st.open.add(dEl.dataset.sec); else st.open.delete(dEl.dataset.sec); });
}

// ---- 배포 후보 재실행(런던파 등 조작 화면으로 옮길 수 없는 테스트): 원본 테스트를 배포본 파일로 다시 실행한 결과 ----
const TEST_LABEL = { pass: ['s-pass', '통과'], fail: ['s-failed', '실패'], skip: ['s-not-applicable', 'skip'], todo: ['s-not-applicable', 'todo'] };
function renderReplayPanel(it, host, active) {
  const run = it.run;
  const rp = run.replay;
  const re = run.realEnv;
  const s1 = run.jobs.find((j) => j.kind === 'stage1')?.stage1;
  const running = run.jobs.some((j) => j.kind === 'replay' && (j.status === 'queued' || j.status === 'running'));
  if (!it.rp) it.rp = { open: new Set(['real']), filter: 'all', live: new Set(), console: true };
  const st = it.rp;
  if (host.dataset.run !== run.id) { host.dataset.run = run.id; host.replaceChildren(); }
  const tests = rp?.run.tests ?? [];
  const nPass = tests.filter((t) => t.status === 'pass').length;
  const nFail = tests.filter((t) => t.status === 'fail').length;
  const lineOf = (t) => t.line;
  const base = (t) => s1?.tests.find((x) => x.line === lineOf(t) && x.name === t.name) ?? s1?.tests.find((x) => x.name === t.name);
  const card = (label, value, sub) => `<div class="metric"><div class="small muted">${esc(label)}</div><div class="mv">${esc(value)}</div><div class="small muted">${esc(sub ?? '')}</div></div>`;
  const section = (id, title, body) => `<details class="job" data-sec="${id}" ${st.open.has(id) ? 'open' : ''}><summary>${title}</summary><div class="body">${body}</div></details>`;
  const filterBtn = (k, label) => `<button class="sp-filter ${st.filter === k ? 'on' : ''}" data-f="${k}" type="button">${label}</button>`;
  const shown = tests.filter((t) => st.filter === 'all' || t.status === st.filter);
  const val = (v) => v === undefined ? '' : `<code>${esc(typeof v === 'string' ? v : JSON.stringify(v))}</code>`;
  const rows = shown.map((t) => {
    const b = base(t);
    const regress = b && b.status === 'pass' && t.status !== 'pass';
    const err = t.error ? `<div class="small" style="margin-top:.2rem"><span class="muted">오류</span> ${esc(t.error.message.split('\n')[0])}${t.error.operator ? `<br><span class="muted">기대</span> ${val(t.error.expected)} <span class="muted">실제</span> ${val(t.error.actual)}` : ''}</div>` : '';
    return `<div class="exp-row"><div class="exp-h">${badge(...TEST_LABEL[t.status])}<span>${esc(t.name)}</span>${regress ? ` ${badge('s-failed', '원본은 통과 → 배포본에서 실패')}` : ''}</div>
      <div class="exp-s small"><span class="muted">원본(1단계)</span> ${b ? badge(...TEST_LABEL[b.status]) : badge('s-not-applicable', '—')} <span class="muted">배포 후보</span> ${badge(...TEST_LABEL[t.status])} <span class="muted">${t.line ? `${esc(run.testFile.path)}:${t.line}` : ''}</span></div>${err}</div>`;
  }).join('') || '<p class="muted small">해당하는 항목 없음</p>';
  const modules = rp ? `<p class="small muted">원본 테스트가 import한 프로젝트 dist 파일이 아래 배포 후보 파일로 바뀌어 실행됐습니다(<code>${esc(rp.packageDir)}</code> 기준).</p>${rp.redirected.map((f) => `<div class="small"><code>${esc(f)}</code></div>`).join('') || '<p class="small muted">없음</p>'}${rp.missing.length ? `<p class="small">${badge('s-failed', '배포물에 없음')}</p>${rp.missing.map((f) => `<div class="small"><code>${esc(f)}</code></div>`).join('')}` : ''}` : '<p class="small muted">아직 실행하지 않았습니다.</p>';
  const kv = (o) => Object.keys(o ?? {}).length ? Object.entries(o).map(([k, v]) => `<div class="small"><code>${esc(k)}</code> = <code>${esc(v)}</code></div>`).join('') : '<span class="small muted">비어 있음</span>';
  const vars = (o) => o.variants ? `<div class="small muted">실제 스키마별 결과</div>${Object.entries(o.variants).map(([k, v]) => `<div class="small"><code>${esc(k)}</code> → ${v.threw ? `예외 ${esc(v.threw.message)}` : `<code>${esc(JSON.stringify(v.returned))}</code>`}</div>`).join('')}` : '';
  const obs = (o, env) => !o ? '<span class="small muted">결과 없음</span>' : `${o.threw ? `<div class="small">${badge('s-failed', '예외')} ${esc(o.threw.name)}: ${esc(o.threw.message)}</div>` : ''}${vars(o)}${(o.calls ?? []).filter((c) => c[0] === 'console').map((c) => `<div class="small"><code>${esc(c.slice(0, 2).join('.'))}(${esc(c.slice(2).map((x) => JSON.stringify(x)).join(', '))})</code></div>`).join('')}${env === 'browser' ? `<div class="small muted">실제 sessionStorage</div>${kv(o.storage?.sessionStorage)}<div class="small muted">실제 호출 순서</div>${(o.calls ?? []).map((c) => `<div class="small"><code>${esc(c.slice(0, 2).join('.'))}(${esc(c.slice(2).map((x) => JSON.stringify(x)).join(', '))})</code></div>`).join('') || '<span class="small muted">저장소 호출 없음</span>'}` : `<div class="small">window ${o.storage?.windowDefined ? '정의됨' : '<b>없음</b>(서버 환경)'}</div><div class="small muted">저장소 호출 ${(o.calls ?? []).length}회</div>`}`;
  const vbadge = (v) => badge(v === 'pass' ? 's-pass' : 's-failed', v === 'pass' ? '일치' : v === 'fail' ? '불일치' : '오류');
  const realRows = re ? re.scenarios.map((x) => {
    const showRuns = x.runs.filter((r, i) => r.verdict !== 'pass' || i === 0);
    return `<div class="exp-row"><div class="exp-h">${vbadge(x.verdict)}<span>${esc(x.testName)}</span> <span class="muted small">${x.env === 'browser' ? '실제 브라우저' : '서버(window 없음)'}</span></div>
      <div class="exp-s small"><code>${esc(x.exportName)}(${esc(x.args.join(', '))})</code> <span class="muted">${esc(run.testFile.path)}:${x.line}</span></div>
      <div class="small" style="margin:.2rem 0">${x.runs.map((r) => `${vbadge(r.verdict)} <span class="muted">${esc(r.browser)}</span>`).join(' &nbsp; ')}</div>
      <div class="small muted">${esc(x.reason)}</div>
      ${x.env === 'browser' && re.live?.scenarios[x.id] ? `<div style="margin:.3rem 0"><button class="btn live-run" data-sid="${esc(x.id)}" type="button">${st.live.has(x.id) ? '직접 실행 닫기' : '실제 함수로 직접 실행'}</button> <span class="small muted">mock 없이 배포 후보의 <code>${esc(x.exportName)}</code>를 이 컴퓨터의 브라우저에서 실제 sessionStorage로 호출합니다</span></div>${st.live.has(x.id) ? `<iframe class="live-frame" data-sid="${esc(x.id)}" title="직접 실행" style="width:100%;height:21rem;border:1px solid var(--line,#ddd);border-radius:6px"></iframe>` : ''}` : ''}
      ${showRuns.map((r) => `<details style="margin-top:.3rem" ${r.verdict !== 'pass' ? 'open' : ''}><summary class="small">${esc(r.browser)} — 상세</summary><div class="row gap wrap" style="align-items:flex-start"><div style="flex:1;min-width:14rem"><div class="small"><b>프로젝트 dist(기준)</b></div>${obs(r.base, x.env)}</div><div style="flex:1;min-width:14rem"><div class="small"><b>배포 후보</b></div>${obs(r.cand, x.env)}</div></div></details>`).join('')}</div>`;
  }).join('') + (re.skipped.length ? `<p class="small muted" style="margin-top:.6rem">재현하지 못해 건너뛴 호출 ${re.skipped.length}개: ${re.skipped.map((k) => `${esc(k.testName)}(${esc(k.reason)})`).join(' / ')}</p>` : '') : '';
  const cover = re ? `<div class="small" style="margin:.4rem 0"><b>크로스브라우징 커버리지</b> ${re.browsers.map((b) => `${badge(b.ok ? 's-pass' : 's-failed', b.ok ? '실행' : '실패')} ${esc(b.name)}${b.ok ? '' : ` <span class="muted">(${esc(b.reason)})</span>`}`).join(' &nbsp; ') || '<span class="muted">브라우저 없음</span>'}${re.browsers.filter((b) => b.ok).length === 1 ? ` ${badge('s-not-applicable', '단일 브라우저 — 크로스브라우징 미확인')}` : ''}</div>` : '';
  const connectedCount = Object.values(run.connected?.results ?? {}).filter(r => r.result.status === 'passed').length;
  const consoleBlock = re?.live?.console ? `<div style="margin:.6rem 0"><button class="btn console-run" type="button">${st.console ? '구성 화면 닫기' : '실제 협력자 구성·검증'}</button> <span class="small connected-progress">${run.connected ? `실제 협력자 기대 결과 ${connectedCount}/${run.connected.definition.scenarios.length}개 통과` : '배포 후보 직접 호출'}</span></div>${st.console ? '<iframe class="console-frame" title="실제 협력자 시나리오 검증" style="width:100%;height:52rem;border:1px solid var(--line,#ddd);border-radius:6px"></iframe>' : ''}` : '';
  const realBody = run.connected ? consoleBlock : re ? `<p class="small muted">테스트 안의 SUT 호출을 그대로 가져와 <b>설치된 실제 브라우저들</b>(실제 window.sessionStorage)에서 프로젝트 dist와 배포 후보에 각각 실행하고, 저장소 상태·호출 순서·반환·예외를 비교했습니다. 같은 배포 후보가 브라우저마다 다른 결과를 내는지도 비교합니다. mock은 쓰지 않습니다.</p>${cover}${re.status !== 'passed' ? `<p class="small">${badge('s-failed', '미통과')} ${esc(re.reason)}</p>` : ''}${realRows}${consoleBlock}` : '';
  const out = rp ? `<pre class="log">${esc(rp.run.output ?? '')}</pre>` : '';
  host.innerHTML = `<div class="card">
    <h4>${re ? '실환경 검증 · 배포 후보 재실행' : '배포 후보 재실행'} <span class="muted small"><code>${esc(run.testFile.path)}</code></span></h4>
    ${run.connected ? '<p class="small muted">시나리오를 고르고 실제 검증 규칙을 선택한 뒤 검증 실행을 누르세요.</p>' : `<p class="small muted">런던파 테스트를 배포 후보로 재실행한 뒤, 시나리오별로 실제 협력자를 연결해 실행하고 기대 결과를 검증합니다. 원본 mock 테스트 결과는 참고용이며, 3단계 확정에는 모든 시나리오의 실제 실행·기대 결과 검증이 필요합니다. 원본 재실행은, 프로젝트 <code>dist</code> import만 소비자 샌드박스에 설치된 <b>배포 후보 파일</b>로 바꿔 같은 mock·assert를 그대로 적용합니다. peer 의존성(React 등)은 테스트 쪽 사본을 공유합니다.</p>`}
    <div class="metrics">${card('mock 재실행(참고)', rp ? `${nPass}/${tests.length}` : '—', rp ? (nFail ? `실패 ${nFail}개` : '협력자 mock 기준 · 실제 환경 아님') : '')}${card('배포 후보 모듈', rp ? `${rp.redirected.length}개` : '—', rp?.missing.length ? `배포물에 없는 파일 ${rp.missing.length}개` : '로드된 파일')}${re && !run.connected ? card('실제 환경 검증', re.scenarios.length ? `${re.scenarios.filter((x) => x.verdict === 'pass').length}/${re.scenarios.length}` : '직접 호출', re.status !== 'passed' ? '미통과' : re.manual ? (re.scenarios.length ? `일치 · 직접 확인 ${re.skipped.length}건` : '자동 재현 불가 · 사람이 확인') : '실제 환경 결과 일치') : ''}${card('원본(1단계)', s1 ? `${s1.tests.filter((t) => t.status === 'pass').length}/${s1.tests.length}` : '—', '프로젝트 dist 기준')}</div>
    <div class="row gap" style="margin:.6rem 0"><button class="btn primary rp-run" type="button" ${active && !running ? '' : 'disabled'}>${running ? '재실행 중…' : rp ? '배포 후보로 다시 실행' : '배포 후보로 실행'}</button></div>
    ${re ? section('real', `실제 환경 검증 <span class="muted small">${run.connected ? run.connected.definition.scenarios.length : re.scenarios.length}개 시나리오${run.connected ? ' · 실제 협력자 연결' : re.manual ? ' · 직접 호출 필요' : ''}</span>`, realBody) : ''}
    ${section('tests', `mock 재실행 결과(참고) <span class="muted small">${tests.length}개</span>`, `<div class="row gap wrap small" style="margin:.2rem 0"><span class="mode">${filterBtn('all', '전체')}${filterBtn('fail', '실패')}${filterBtn('pass', '통과')}</span></div>${rows}`)}
    ${section('modules', `로드된 배포 후보 모듈 <span class="muted small">${rp ? rp.redirected.length + '개' : ''}</span>`, modules)}
    ${section('out', '러너 출력', out || '<p class="small muted">아직 실행하지 않았습니다.</p>')}
  </div>`;
  // 직접 실행: 스테이지 UI와 다른 origin(localhost ↔ 127.0.0.1)의 프레임에서 열어 UI 자신의 sessionStorage를 건드리지 않는다.
  const alt = { localhost: '127.0.0.1', '127.0.0.1': 'localhost' }[location.hostname];
  // 격리 실행은 localhost↔127.0.0.1 별도 출처가 필요하다. 그 외 주소에서는 저장소·서버 호출이 막혀 오판할 수 있으므로 조용히 깨지게 두지 않고 막는다.
  if (!alt && host.querySelector('.live-frame, .console-frame')) {
    for (const f of host.querySelectorAll('.live-frame, .console-frame')) f.replaceWith(Object.assign(document.createElement('p'), { className: 's-fail small', textContent: `이 주소(${location.hostname})에서는 격리 실행을 지원하지 않습니다. 실제 저장소·서버 호출을 정확히 검증할 수 없으므로 http://localhost:${location.port} 로 접속해 실행하세요.` }));
  }
  for (const f of host.querySelectorAll('.live-frame')) {
    const draft = it.liveDrafts?.scenarios?.[f.dataset.sid];
    const query = draft ? '?' + new URLSearchParams({ args: draft.args, seed: draft.seed }) : '';
    const src = `/api/runs/${run.id}/live/${encodeURIComponent(f.dataset.sid)}${query}`;
    if (alt) { f.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms'); f.src = `${location.protocol}//${alt}${location.port ? ':' + location.port : ''}${src}`; }
    else { f.setAttribute('sandbox', 'allow-scripts allow-forms'); fetch(src).then((r) => r.text()).then((h) => { f.srcdoc = h; }); }
  }
  for (const f of host.querySelectorAll('.console-frame')) {
    const src = `/api/runs/${run.id}/live-console`;
    f.onload = () => { if (!run.connected && it.liveDrafts?.console !== undefined) f.contentWindow.postMessage({ restoreStageCode: it.liveDrafts.console }, alt ? new URL(f.src).origin : '*'); };
    if (alt) { f.setAttribute('sandbox', 'allow-scripts allow-same-origin'); f.src = `${location.protocol}//${alt}${location.port ? ':' + location.port : ''}${src}`; }
    else { f.setAttribute('sandbox', 'allow-scripts'); fetch(src).then((r) => r.text()).then((h) => { f.srcdoc = h; }); }
  }
  for (const b of host.querySelectorAll('.console-run')) b.onclick = () => { st.console = !st.console; renderReplayPanel(it, host, active); };
  for (const b of host.querySelectorAll('.live-run')) b.onclick = () => { if (st.live.has(b.dataset.sid)) st.live.delete(b.dataset.sid); else st.live.add(b.dataset.sid); renderReplayPanel(it, host, active); };
  host.querySelector('.rp-run').onclick = async (e) => { e.target.disabled = true; try { await api('POST', `/api/runs/${run.id}/replay`); } catch (err) { notify(err.message); } };
  for (const b of host.querySelectorAll('.sp-filter')) b.onclick = () => { st.filter = b.dataset.f; renderReplayPanel(it, host, active); };
  for (const dEl of host.querySelectorAll('details[data-sec]')) dEl.addEventListener('toggle', () => { if (dEl.open) st.open.add(dEl.dataset.sec); else st.open.delete(dEl.dataset.sec); });
}

// ---- 연결 구성: 테스트가 대체 객체로 바꿔 끼운 협력자를 실물로 전환하는 화면(분석 메타정보로 자동 구성) ----
const ROLE_TEXT = { 'http-client': 'HTTP 클라이언트', observer: '관찰 대상' };
const headersToText = (h) => Object.entries(h ?? {}).map(([k, v]) => (v.env ? `${k} = ${v.prefix ?? ''}$${v.env}` : `${k} = ${v.value}`)).join('\n');
function textToHeaders(t) {
  const out = {};
  for (const line of String(t).split('\n')) {
    const m = line.match(/^\s*([^=\s][^=]*?)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    const ref = m[2].match(/^(.*?)\$([A-Za-z_][A-Za-z0-9_]*)$/); // "Bearer $TOKEN" → 접두어 + 환경변수 이름
    out[m[1]] = ref ? (ref[1] ? { env: ref[2], prefix: ref[1] } : { env: ref[2] }) : { value: m[2] };
  }
  return out;
}

function ensureWiring(it) {
  const w = it.analysis?.wiring;
  const host = $('#wiring');
  if (!w || !w.tests.length) { host.replaceChildren(); return; }
  if (!it.wiringEl) { it.wiringEl = document.createElement('div'); it.wiringEl.className = 'card'; it.wiringOpen = new Set(); }
  if (host.firstChild !== it.wiringEl) host.replaceChildren(it.wiringEl);
  const root = it.analysis.project?.root;
  if (!it.wiring && !it.wiringLoading) {
    it.wiringLoading = true;
    (root ? api('GET', `/api/profiles?project=${encodeURIComponent(root)}`) : Promise.reject(new Error('프로젝트 연결 없음 — 프로필을 저장할 수 없습니다')))
      .then((r) => { it.wiring = { ...r, saved: JSON.stringify(r.doc) }; })
      .catch((e) => { it.wiring = { error: e.message }; })
      .finally(() => { it.wiringLoading = false; drawWiring(it); });
  }
  if (!it.wiringEl.firstChild) drawWiring(it);
}

function drawWiring(it) {
  const el = it.wiringEl;
  const w = it.analysis.wiring;
  const st = it.wiring;
  const calls = w.tests.flatMap((t) => t.calls);
  const switchable = calls.flatMap((c) => c.collaborators.filter((k) => k.role === 'http-client'));
  const observers = calls.flatMap((c) => c.collaborators.filter((k) => k.role === 'observer'));
  let profileHtml = '<p class="muted small">프로필을 불러오는 중…</p>';
  let doc = null;
  if (st?.error) profileHtml = `<p class="small">${badge('s-partial', '프로필 사용 불가')} ${esc(st.error)}</p>`;
  if (st?.doc) {
    doc = st.doc;
    const p = doc.profiles.find((x) => x.name === doc.active);
    const chk = st.checks?.[p.name];
    const dirty = JSON.stringify(doc) !== st.saved;
    profileHtml = `<div class="row gap wrap">
        <label class="small">프로필 <select class="w-active">${doc.profiles.map((x) => `<option ${x.name === doc.active ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></label>
        <button class="btn w-add" type="button">추가</button><button class="btn w-del" type="button" ${doc.profiles.length < 2 ? 'disabled' : ''}>삭제</button>
        <span class="small">${p.mode === 'mock' ? badge('s-not-applicable', 'Mock — 실제 서버로 나가지 않음') : chk?.ok ? badge('s-pass', `Stage 대상 허용: ${chk.host}`) : badge('s-failed', `Stage 전송 차단: ${chk?.reason ?? '저장 후 점검'}`)}</span>
        <span class="w-dirty small muted">${dirty ? '저장 안 된 변경 있음' : '저장됨'}</span></div>
      <div class="field"><label>모드</label><select class="w-mode"><option value="mock" ${p.mode === 'mock' ? 'selected' : ''}>mock — 대체 응답</option><option value="stage" ${p.mode === 'stage' ? 'selected' : ''}>stage — 실제 서버</option></select></div>
      <div class="field"><label>baseUrl</label><input class="w-base" value="${esc(p.baseUrl ?? '')}" placeholder="https://stage.example.com/api"></div>
      <div class="field"><label>허용 호스트</label><input class="w-hosts" value="${esc(p.allowedHosts.join(', '))}" placeholder="stage.example.com, localhost:4500"><div class="hint">Stage 모드는 baseUrl의 호스트가 여기 있을 때만 전송합니다(운영 서버 오호출 방지).</div></div>
      <div class="field"><label>타임아웃(ms)</label><input class="w-timeout" type="number" value="${esc(p.timeoutMs ?? '')}" placeholder="기본값"></div>
      <div class="field"><label>변경 요청 허용</label><label class="small"><input class="w-mut" type="checkbox" ${p.allowMutations ? 'checked' : ''}> POST·PUT·PATCH·DELETE를 실제로 보냄</label></div>
      <div class="field"><label>헤더</label><textarea class="w-headers" rows="2" spellcheck="false" placeholder="Authorization = Bearer $STAGE_API_TOKEN">${esc(headersToText(p.headers))}</textarea><div class="hint">값 끝의 $이름은 환경변수 참조입니다(앞에 Bearer 같은 접두어 가능). 토큰 값은 저장하지 않습니다. 한 줄에 하나(이름 = 값).</div></div>
      <div class="row gap"><button class="btn primary w-save" type="button" ${dirty ? '' : 'disabled'}>저장</button><span class="w-msg small"></span></div>`;
  }
  const bindOf = (c, k) => doc?.bindings[`${c.id}.${k.option}`] ?? 'real';
  const canOpen = !!doc && JSON.stringify(doc) === st.saved;
  const openBtn = (t, c) => (c.hook && c.clientFactory ? ` <button class="btn pg-open" data-t="${esc(t.id)}" data-c="${esc(c.id)}" type="button" ${canOpen ? '' : 'disabled title="프로필을 저장한 뒤 열 수 있습니다"'}>가상 화면 열기</button>` : ' <span class="muted">(가상 화면은 Hook·HTTP 클라이언트 구현 확인 필요)</span>');
  const testHtml = w.tests.map((t) => `<details class="job" data-t="${esc(t.id)}" ${it.wiringOpen.has(t.id) ? 'open' : ''}><summary>${esc(t.path.join(' › '))} <span class="muted small">${t.calls.map((c) => `${esc(c.sut)}(${esc(c.path ?? '')})`).join(', ')}</span>${t.globals.length ? ` ${badge('s-not-applicable', '전역 대체: ' + t.globals.join(', '))}` : ''}</summary><div class="body">
      ${t.calls.map((c) => `<div class="small"><b>${esc(c.sut)}</b> <span class="muted">${esc(locText(c.loc))}</span>${openBtn(t, c)}
        <div>${c.options.filter((o) => o.kind === 'literal').map((o) => `<code>${esc(o.key)}=${esc(JSON.stringify(o.value))}</code>`).join(' ') || '<span class="muted">고정 옵션 없음</span>'}</div>
        ${c.collaborators.length ? `<table class="wt">${c.collaborators.map((k) => `<tr><td><code>${esc(k.option)}</code></td><td>${esc(ROLE_TEXT[k.role])}${k.methods.length ? ` <span class="muted">(${esc(k.methods.join(', '))})</span>` : ''}</td><td>${k.role === 'http-client'
          ? `<span class="mode" data-k="${esc(c.id)}.${esc(k.option)}"><button data-b="double" class="${bindOf(c, k) === 'double' ? 'on' : ''}" type="button">테스트 대체 객체</button><button data-b="real" class="${bindOf(c, k) === 'real' ? 'on' : ''}" type="button">실제 호출</button></span>`
          : '<span class="muted">스파이로 관찰 — 호출 순서·인자 기록</span>'}</td></tr>`).join('')}</table>` : '<div class="muted">대체 객체 없음</div>'}</div>`).join('')}</div></details>`).join('');
  el.innerHTML = `<h4>연결 구성 <span class="muted small">테스트가 import한 공개 API ${w.sut.map((s) => `<code>${esc(s.name)}</code>`).join(' ')} 를 대체 객체 없이 호출할 때의 전환 항목 — 분석 메타정보에서 자동 구성</span></h4>
    <p class="small">호출 지점 ${calls.length}곳 · 실물로 전환 가능한 HTTP 클라이언트 ${switchable.length}개 · 스파이로 관찰할 협력자 ${observers.length}개</p>
    ${profileHtml}
    <h4>호출 지점별 협력자</h4>${testHtml}
    <p class="small muted">현재는 구성 저장과 전송 대상 점검까지 제공합니다. 이 구성으로 Hook을 실제 서버에 호출하는 실행기는 아직 연결되지 않았습니다.</p>`;
  for (const d of el.querySelectorAll('details[data-t]')) d.addEventListener('toggle', () => { if (d.open) it.wiringOpen.add(d.dataset.t); else it.wiringOpen.delete(d.dataset.t); });
  if (!doc) return;
  const cur = () => doc.profiles.find((x) => x.name === doc.active);
  const refreshDirty = () => {
    const dirty = JSON.stringify(doc) !== st.saved;
    el.querySelector('.w-save').disabled = !dirty;
    el.querySelector('.w-dirty').textContent = dirty ? '저장 안 된 변경 있음' : '저장됨';
  };
  const on = (sel, ev, fn) => { const n = el.querySelector(sel); if (n) n.addEventListener(ev, () => fn(n)); };
  on('.w-active', 'change', (n) => { doc.active = n.value; drawWiring(it); });
  on('.w-mode', 'change', (n) => { cur().mode = n.value; refreshDirty(); });
  on('.w-base', 'input', (n) => { cur().baseUrl = n.value.trim() || undefined; refreshDirty(); });
  on('.w-hosts', 'input', (n) => { cur().allowedHosts = n.value.split(',').map((x) => x.trim()).filter(Boolean); refreshDirty(); });
  on('.w-timeout', 'input', (n) => { cur().timeoutMs = n.value === '' ? undefined : Number(n.value); refreshDirty(); });
  on('.w-mut', 'change', (n) => { cur().allowMutations = n.checked; refreshDirty(); });
  on('.w-headers', 'input', (n) => { cur().headers = textToHeaders(n.value); refreshDirty(); });
  on('.w-add', 'click', () => {
    const name = prompt('새 프로필 이름');
    if (!name || !name.trim()) return;
    if (doc.profiles.some((x) => x.name === name.trim())) { notify('같은 이름의 프로필이 있습니다'); return; }
    doc.profiles.push({ name: name.trim(), mode: 'stage', allowedHosts: [], allowMutations: false, headers: {} });
    doc.active = name.trim();
    drawWiring(it);
  });
  on('.w-del', 'click', () => {
    if (!confirm(`프로필 '${doc.active}'을(를) 삭제할까요?`)) return;
    doc.profiles = doc.profiles.filter((x) => x.name !== doc.active);
    doc.active = doc.profiles[0].name;
    drawWiring(it);
  });
  for (const m of el.querySelectorAll('.mode[data-k]')) for (const b of m.querySelectorAll('button')) b.addEventListener('click', () => { doc.bindings[m.dataset.k] = b.dataset.b; drawWiring(it); });
  for (const b of el.querySelectorAll('.pg-open')) b.addEventListener('click', () => openPlayground(it, b.dataset.t, b.dataset.c, b));
  on('.w-save', 'click', async () => {
    try {
      const r = await api('PUT', '/api/profiles', { project: it.analysis.project.root, doc });
      it.wiring = { ...r, saved: JSON.stringify(r.doc) };
      drawWiring(it);
    } catch (e) { el.querySelector('.w-msg').textContent = `저장 실패: ${e.message}`; }
  });
}

// ---- 가상 화면: 생성된 코드를 고치면 바로 다시 번들해 iframe에 반영한다. 실제 호출은 서버 프록시를 거친다. ----
const short = (v) => { const s = JSON.stringify(v); return s && s.length > 220 ? s.slice(0, 217) + '…' : s; };

function ensurePlayground(it) {
  const host = $('#playground');
  if (!it.pg) { host.replaceChildren(); return; }
  if (host.firstChild !== it.pg.el) host.replaceChildren(it.pg.el);
}

async function openPlayground(it, testId, callId, btn) {
  const doc = it.wiring?.doc;
  btn.disabled = true;
  try {
    const r = await api('POST', '/api/playground', { project: it.analysis.project.root, analysisId: it.analysis.id, testId, callId, binding: doc?.bindings[`${callId}.client`] ?? 'real' });
    if (!r.source) throw new Error('이 호출은 가상 화면을 만들 수 없습니다');
    const test = it.analysis.wiring.tests.find((t) => t.id === testId);
    const call = test.calls.find((c) => c.id === callId);
    const el = document.createElement('div');
    el.className = 'card';
    el.innerHTML = `<h4>가상 화면 <span class="muted small">${esc(test.path.join(' › '))} · ${esc(call.sut)}</span> <button class="btn pg-close" type="button">닫기</button></h4>
      <p class="small">${r.mode === 'mock' ? badge('s-not-applicable', `Mock — 프로필 ${r.profile}: 실제 서버로 나가지 않음`) : r.check.ok ? badge('s-pass', `Stage — 프로필 ${r.profile}: 실제 서버로 전송`) : badge('s-failed', `Stage 전송 차단 — ${r.check.reason}`)} <span class="muted">코드를 고치면 잠시 뒤 오른쪽 화면에 반영됩니다. 원본 테스트의 assert는 적용되지 않으며 결과는 직접 확인합니다.</span></p>
      <div class="pg-grid"><div><div class="small muted">코드 (React · 편집 가능)</div><textarea class="pg-code" spellcheck="false"></textarea><div class="pg-err small"></div></div>
        <div><div class="small muted">화면 (격리된 iframe)</div><iframe class="pg-frame" sandbox="allow-scripts" title="가상 화면"></iframe></div></div>
      <div class="pg-logs"><div><b class="small">콜백·결과</b><ul class="pg-events small"></ul></div><div><b class="small">실제로 나간 요청 (서버 기록)</b><ul class="pg-net small"></ul></div></div>`;
    const pg = { id: r.id, el, events: [], netSig: '', timer: null, frame: el.querySelector('.pg-frame') };
    it.pg = pg;
    const code = el.querySelector('.pg-code');
    code.value = r.source;
    it.playgroundCodes ??= {};
    it.playgroundCodes[pg.id] = code.value;
    code.addEventListener('input', () => { it.playgroundCodes[pg.id] = code.value; });
    code.addEventListener('keydown', (e) => {
      if (e.key !== 'Tab') return;
      e.preventDefault();
      const { selectionStart: s, selectionEnd: en } = code;
      code.setRangeText('  ', s, en, 'end');
      code.dispatchEvent(new Event('input'));
    });
    const rebuild = async () => {
      const err = el.querySelector('.pg-err');
      try {
        const out = await api('POST', `/api/playground/${pg.id}/bundle`, { code: code.value });
        if (out.errors) { err.innerHTML = out.errors.map((x) => `<div>${badge('s-failed', '빌드 오류')} ${x.line ? `${x.line}:${x.column ?? 0} ` : ''}${esc(x.text)}</div>`).join(''); return; }
        err.textContent = '';
        pg.events = [];
        drawPgEvents(pg);
        // 화면은 스테이지 UI와 다른 origin(localhost ↔ 127.0.0.1)에서 열어 부모와 격리하면서도 자체 저장소(sessionStorage 등)를 쓰게 한다.
        // 다른 origin을 만들 수 없는 주소로 열었을 때는 저장소를 막은 srcdoc으로 대신하므로 저장소를 쓰는 코드는 실패할 수 있다.
        const alt = { localhost: '127.0.0.1', '127.0.0.1': 'localhost' }[location.hostname];
        if (alt) {
          pg.frame.setAttribute('sandbox', 'allow-scripts allow-same-origin');
          pg.frame.src = `${location.protocol}//${alt}${location.port ? ':' + location.port : ''}/api/playground/${pg.id}/frame?v=${Date.now()}`;
        } else {
          pg.frame.setAttribute('sandbox', 'allow-scripts');
          pg.frame.removeAttribute('src');
          pg.frame.srcdoc = await (await fetch(`/api/playground/${pg.id}/frame`)).text();
        }
      } catch (e) { err.textContent = `번들 실패: ${e.message}`; }
    };
    code.addEventListener('input', () => { clearTimeout(pg.timer); pg.timer = setTimeout(rebuild, 500); });
    el.querySelector('.pg-close').addEventListener('click', () => { it.pg = null; ensurePlayground(it); });
    ensurePlayground(it);
    el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    startPgPoll();
    rebuild();
  } catch (e) { notify(e.message); } finally { btn.disabled = false; }
}

function drawPgEvents(pg) {
  pg.el.querySelector('.pg-events').innerHTML = pg.events.map((ev) => `<li>${badge(ev.kind === 'error' ? 's-failed' : ev.kind === 'result' ? 's-pass' : 's-not-applicable', ev.kind === 'callback' ? '콜백' : ev.kind === 'result' ? '결과' : '오류')} <code>${esc(ev.name)}</code> ${esc(short(ev.detail) ?? '')}</li>`).join('') || '<li class="muted">아직 없음 — 화면에서 버튼을 눌러 보세요</li>';
}

let pgPollStarted = false;
function startPgPoll() {
  if (pgPollStarted) return;
  pgPollStarted = true;
  window.addEventListener('message', (e) => {
    if (!e.data?.stage) return;
    for (const it of state.items) if (it.pg && it.pg.frame.contentWindow === e.source) { it.pg.events.push(e.data); drawPgEvents(it.pg); }
  });
  setInterval(async () => {
    for (const it of state.items) {
      const pg = it.pg;
      if (!pg || !pg.el.isConnected) continue;
      try {
        const log = await api('GET', `/api/playground/${pg.id}/log`);
        const sig = JSON.stringify(log.map((x) => [x.seq, x.status, x.blocked, x.error]));
        if (sig === pg.netSig) continue; // 진행 중이던 요청이 끝나 상태가 바뀌면 다시 그린다
        pg.netSig = sig;
        pg.el.querySelector('.pg-net').innerHTML = log.map((x) => `<li>#${x.seq} <code>${esc(x.method)} ${esc(x.url)}</code> ${x.blocked ? badge('s-failed', '보내지 않음') + ' ' + esc(x.blocked) : x.error ? badge('s-failed', '실패') + ' ' + esc(x.error) : x.status === undefined ? '…' : `${badge(x.status < 400 ? 's-pass' : 's-failed', String(x.status))} ${x.durationMs ?? ''}ms`}</li>`).join('') || '<li class="muted">아직 없음</li>';
      } catch { /* 세션 만료 등은 다음 열기에서 다시 만든다 */ }
    }
  }, 1000);
}

function buildOpCard(it, card, sc) {
  const step = sc.steps.find((s) => s.kind === 'call' && s.method);
  const original = step.args.map((x) => (x.kind === 'value' ? x.value : undefined));
  const form = { args: structuredClone(original), routes: null };
  it.opForms[sc.id] = form;
  it.mode[sc.id] = it.mode[sc.id] ?? 'stage';
  card.innerHTML = `<h4>${esc(sc.path.join(' › '))} <span class="muted small">컨슈머 경로: ${esc(sc.consumerLink.setupExport)}(설정) → .${esc(step.method)}()</span></h4>
    <div class="opgrid"><div><div class="small muted">입력 (원본 테스트 값으로 채움 · 바꾼 칸은 강조 표시)</div><div class="form"></div>
      <div class="row gap" style="margin-top:.5rem"><span class="mode"><button data-m="stage">Stage</button><button data-m="mock">Mock</button></span><button class="btn primary run-btn">실행</button></div>
      <div class="mock-edit hidden"><div class="small muted">Mock 응답(fetch 가로채기). 비우면 stage.config.json 기본값</div><textarea class="routes" spellcheck="false" placeholder='[{"method":"POST","path":"/orders","status":503,"body":{"message":"x"}}]'></textarea></div>
      <p class="small muted">반환 타입: <code>${esc(step.returnsText)}</code></p></div>
    <div><div class="small muted">처리 이력</div><div class="history"></div></div></div>`;
  const fhost = card.querySelector('.form');
  step.params.forEach((p, i) => {
    fhost.appendChild(fieldFor(p.schema, form.args[i] && form.args[i].$stage === 'undefined' ? undefined : form.args[i], original[i], (v) => { form.args[i] = v; }, p.name, p.optional));
  });
  const setMode = (m) => {
    it.mode[sc.id] = m;
    for (const b of card.querySelectorAll('.mode button')) b.classList.toggle('on', b.dataset.m === m);
    card.querySelector('.mock-edit').classList.toggle('hidden', m !== 'mock');
  };
  for (const b of card.querySelectorAll('.mode button')) b.onclick = () => setMode(b.dataset.m);
  setMode(it.mode[sc.id]);
  card.querySelector('.run-btn').onclick = async () => {
    const mode = it.mode[sc.id];
    let routes;
    const txt = card.querySelector('.routes').value.trim();
    if (mode === 'mock' && txt) { try { routes = JSON.parse(txt); } catch { return notify('Mock 응답 JSON 형식 오류'); } }
    const args = form.args.map((v) => (v === undefined ? { $stage: 'undefined' } : v));
    while (args.length && args[args.length - 1]?.$stage === 'undefined') args.pop();
    try { await api('POST', `/api/runs/${it.run.id}/interactions`, { scenarioId: sc.id, stepId: step.id, mode, args, routes }); }
    catch (e) { notify(e.message); }
  };
}

$('#manual').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  try { await api('POST', `/api/runs/${state.cur.run.id}/manual`, Object.fromEntries(f)); e.target.reset(); } catch (err) { notify(err.message); }
});

// ---- 보고서 ----
let reportTimer;
function renderReport(it) {
  renderCodeExport(it);
  clearTimeout(reportTimer);
  reportTimer = setTimeout(async () => {
    const run = it.run;
    if (!run) return;
    const r = await api('GET', `/api/runs/${run.id}/report`);
    if (state.cur !== it) return;
    $('#report-html').href = `/api/runs/${run.id}/report?format=html`;
    $('#report').innerHTML = `<div class="decision">배포 판단: ${esc(r.decision.label)}</div><ul class="small">${r.decision.reasons.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
      <table class="small"><tr><th>시나리오</th><th>분석</th><th>1단계</th><th>2단계</th><th>3단계 Stage</th><th>3단계 Mock</th></tr>${r.scenarios.map((s) => `<tr><td>${esc(s.title)}</td><td>${badge('s-' + s.support, s.supportLabel)}</td><td>${esc(s.stage1)}</td><td>${esc(s.stage2)}</td><td>${s.stage3Stage ? `${badge('v-' + s.stage3Stage.verdict, s.stage3Stage.label)} #${s.stage3Stage.attempt} · 실제 요청 ${s.stage3Stage.requests}건${s.stage3Stage.inputChanged ? ' · 입력 변경' : ''}` : '미실행'}</td><td>${s.stage3Mock ? `${esc(s.stage3Mock.status)} #${s.stage3Mock.attempt}` : '-'}</td></tr>`).join('')}</table>
      <h3>미검증·미지원</h3><ul class="small">${r.notCovered.map((x) => `<li>${esc(x)}</li>`).join('') || '<li>없음</li>'}</ul>
      <details><summary class="small">식별 정보·환경</summary><pre>${j({ identity: r.identity, environment: r.environment })}</pre></details>
      <h3>한계</h3><ul class="small muted">${r.disclaimers.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`;
  }, 150);
}

// ---- 초기화·SSE ----
async function init() {
  state.meta = await api('GET', '/api/meta');
  $('#meta').textContent = `framework ${state.meta.frameworkVersion} · rules ${state.meta.rulesVersion}`;
  renderProjects();
  const conn = $('#conn');
  const setConn = (ok, t) => { conn.classList.toggle('ok', ok); conn.classList.toggle('bad', !ok); conn.querySelector('span').textContent = t; };
  const es = new EventSource('/api/events');
  es.onopen = () => { setConn(true, '서버 연결됨'); for (const it of state.items) refreshRun(it); };
  es.onerror = () => { if (!state.restarting) setConn(false, '서버 연결 끊김 — 표시 중인 상태가 최신이 아닐 수 있음'); };
  const restartBtn = $('#restart');
  restartBtn.classList.toggle('hidden', !state.meta.canRestart);
  restartBtn.onclick = async () => {
    const busy = state.items.some((it) => it.run && it.run.jobs?.some((j) => j.status === 'queued' || j.status === 'running'));
    if (!confirm(busy ? '진행 중인 작업이 있습니다. 서버를 재시작하면 작업이 중단되고 자동으로 다시 실행되지 않습니다. 재시작할까요?' : '서버를 재시작할까요?')) return;
    try {
      state.restarting = true;
      restartBtn.disabled = true;
      setConn(false, '서버 재시작 중…');
      await api('POST', '/api/restart');
      // 새 프로세스가 뜰 때까지(서버 시작 시각이 바뀔 때까지) 기다렸다가 화면을 다시 불러온다.
      const before = state.meta.startedAt;
      for (let i = 0; i < 60; i++) {
        await new Promise((r) => setTimeout(r, 500));
        const m = await api('GET', '/api/meta').catch(() => null);
        if (m && m.startedAt !== before) { location.reload(); return; }
      }
      throw new Error('30초 안에 서버가 다시 뜨지 않았습니다');
    } catch (e) {
      state.restarting = false;
      restartBtn.disabled = false;
      setConn(false, `재시작 실패: ${e.message}`);
    }
  };
  es.addEventListener('run', (e) => {
    const run = JSON.parse(e.data);
    const it = state.items.find((x) => x.run?.id === run.id);
    if (it) { it.run = run; autoStep(it); renderQueue(); if (state.cur === it) renderDetail(); }
    loadHistory();
  });
  document.body.classList.add('on-home');
  loadHistory();
}
init().catch((e) => { $('#conn').querySelector('span').textContent = `초기화 실패: ${e.message}`; });
