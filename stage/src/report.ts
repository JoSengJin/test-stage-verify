// 통합 보고서: 어떤 배포 후보를 어떤 환경·범위에서 검증했는지와 판정 근거를 모은다.
// 검증 범위를 넘어 배포 안전성을 보장하지 않는다.
import type { AnalysisResult } from './model.ts';
import { EXEC_LABEL, LINK_LABEL, MODE_LABEL, SUPPORT_LABEL } from './model.ts';
import type { Run } from './exec/runs.ts';

export interface Report {
  generatedAt: string;
  runId: string;
  rerunOf?: string;
  identity: Record<string, unknown>;
  environment: Run['environment'];
  stages: { stage: number; title: string; status: string; label: string; reason: string }[];
  scenarios: {
    id: string; title: string; support: string; supportLabel: string; findings: string[];
    stage1?: string; stage2?: string; stage2Reason?: string;
    stage3Stage?: { verdict?: string; label?: string; reason?: string; attempt?: number; requests: number; inputChanged?: boolean };
    stage3Mock?: { status: string; attempt?: number; requests: number };
  }[];
  variants: { label: string; status: string; reason?: string }[];
  manual: Run['manual'];
  notCovered: string[];
  decision: { code: 'within-scope-pass' | 'conditional' | 'hold-failure' | 'undecided'; label: string; reasons: string[] };
  disclaimers: string[];
}

export function buildReport(run: Run, a: AnalysisResult): Report {
  const stages = run.stages.map((s) => ({ stage: s.stage, title: s.title, status: s.status, label: EXEC_LABEL[s.status], reason: s.reason }));
  const s1job = run.jobs.find((j) => j.kind === 'stage1');
  const scenarios = a.scenarios.map((sc) => {
    const t1 = s1job?.stage1?.tests.find((t) => t.line === sc.loc.line);
    const j2 = [...run.jobs].reverse().find((j) => j.kind === 'scenario' && j.scenarioId === sc.id);
    const j3s = [...run.jobs].reverse().find((j) => j.kind === 'interaction' && j.scenarioId === sc.id && j.mode === 'stage');
    const j3m = [...run.jobs].reverse().find((j) => j.kind === 'interaction' && j.scenarioId === sc.id && j.mode === 'mock');
    return {
      id: sc.id,
      title: sc.path.join(' › '),
      support: sc.support.status,
      supportLabel: SUPPORT_LABEL[sc.support.status],
      findings: sc.support.findings.filter((f) => f.level !== 'info').map((f) => `[${f.ruleId}] ${f.message}${f.loc ? ` (${f.loc.file}:${f.loc.line})` : ''}`),
      stage1: t1 ? t1.status : s1job ? '대응 테스트 결과 없음' : '미실행',
      stage2: j2 ? EXEC_LABEL[j2.status] : sc.support.status === 'auto' ? '미실행' : `미실행(${SUPPORT_LABEL[sc.support.status]})`,
      stage2Reason: j2?.reason,
      stage3Stage: j3s ? {
        verdict: j3s.outcome?.linkVerdict, label: j3s.outcome?.linkVerdict ? LINK_LABEL[j3s.outcome.linkVerdict] : EXEC_LABEL[j3s.status], reason: j3s.outcome?.verdictReason ?? j3s.reason,
        attempt: j3s.attempt, requests: j3s.outcome?.network.filter((n) => !n.intercepted).length ?? 0, inputChanged: j3s.input?.changed,
      } : undefined,
      stage3Mock: j3m ? { status: EXEC_LABEL[j3m.status], attempt: j3m.attempt, requests: j3m.outcome?.network.length ?? 0 } : undefined,
    };
  });
  const variants = run.jobs.filter((j) => j.kind === 'variant').map((j) => ({ label: j.label, status: EXEC_LABEL[j.status], reason: j.reason }));
  const notCovered: string[] = [];
  for (const sc of scenarios) {
    if (sc.support !== 'auto') notCovered.push(`${sc.title}: ${sc.supportLabel} — 2·3단계 미실행`);
    else if (!sc.stage3Stage) notCovered.push(`${sc.title}: Stage 실제 연계 미실행`);
  }
  for (const f of a.findings) if (f.level !== 'info') notCovered.push(`파일 수준: [${f.ruleId}] ${f.message}`);
  if (run.candidate?.source) notCovered.push('2단계 건너뜀 — 배포 tarball을 검증하지 않았고 3단계는 프로젝트 진입 파일을 직접 사용함');
  else if (!run.candidate) notCovered.push('배포 후보 산출물 미생성 — 배포물 사용을 검증하지 않음');
  const git = run.project.git as { commit?: string; dirty?: boolean; error?: string } | undefined;
  if (!git?.commit) notCovered.push(`소스 버전 식별 불가: ${git?.error ?? 'git 정보 없음'} — 1단계 결과와 배포 후보를 커밋에 연결할 수 없음`);
  else if (git.dirty) notCovered.push(`작업 트리에 커밋되지 않은 변경 있음(HEAD ${git.commit.slice(0, 10)}) — 결과는 커밋이 아닌 작업 트리 기준`);

  const reasons: string[] = [];
  let code: Report['decision']['code'];
  const anyFailed = run.stages.some((s) => ['failed', 'timeout'].includes(s.status));
  const allPassed = run.stages.every((s) => s.status === 'passed');
  const mismatch = a.scenarios.some((s) => s.support.status === 'contract-mismatch');
  if (anyFailed || mismatch) {
    code = 'hold-failure';
    for (const s of run.stages) if (['failed', 'timeout'].includes(s.status)) reasons.push(`${s.title}: ${EXEC_LABEL[s.status]} — ${s.reason}`);
    if (mismatch) reasons.push('분석 단계에서 공개 API 계약 불일치 발견');
  } else if (allPassed && notCovered.length === 0) {
    code = 'within-scope-pass';
    reasons.push('세 단계 모두 성공, 분석한 모든 시나리오가 실행됨');
  } else if (allPassed) {
    code = 'conditional';
    reasons.push('실행한 범위는 모두 통과했으나 미검증 범위가 있음', ...notCovered);
  } else {
    code = 'undecided';
    for (const s of run.stages) if (s.status !== 'passed') reasons.push(`${s.title}: ${EXEC_LABEL[s.status]} — ${s.reason}`);
  }
  const manualIssue = run.manual.filter((m) => m.verdict === 'issue');
  if (manualIssue.length) reasons.push(`수동 확인에서 문제 ${manualIssue.length}건 기록(자동 판정과 별도)`);
  const label = { 'within-scope-pass': '검증 범위 내 통과', conditional: '조건부 — 미검증 범위 있음', 'hold-failure': '배포 보류 — 실패 또는 계약 불일치', undecided: '판단 불가 — 단계 미완료' }[code];

  return {
    generatedAt: new Date().toISOString(),
    runId: run.id,
    rerunOf: run.rerunOf,
    identity: {
      package: run.project.name, version: run.project.version, git: run.project.git,
      testFile: run.testFile, analysisId: run.analysisId, analysisModelSha256: run.analysisSha,
      rulesVersion: run.rulesVersion, frameworkVersion: run.frameworkVersion,
      candidate: run.candidate ? { id: run.candidate.id, tarballSha256: run.candidate.tarballSha256, npmIntegrity: run.candidate.npmIntegrity, files: run.candidate.files, boundary: run.candidate.boundary, typesFile: run.contract?.typesFile } : undefined,
      stageConfigSha256: run.environment.stageConfigSha,
    },
    environment: run.environment,
    stages,
    scenarios,
    variants,
    manual: run.manual,
    notCovered,
    decision: { code, label, reasons },
    disclaimers: [
      '이 보고서는 위 배포 후보·환경·시나리오 범위에서 관찰한 결과만 나타내며 배포 안전성 전체를 보장하지 않는다.',
      '1단계는 커밋 소스와 원본 테스트, 2·3단계는 npm pack으로 만든 배포 후보를 별도 샌드박스에 설치해 공개 API로 실행한 결과다.',
      '2단계 실행 환경은 Node 런타임 자식 프로세스다. 브라우저 자동화 도구가 프로젝트 의존성에 없어 브라우저 런타임 자동 검증은 수행하지 않았다.',
      `연결 모드: ${Object.values(MODE_LABEL).join(' / ')}. Stage 실패 시 Mock으로 자동 대체하지 않는다.`,
      '프로세스 분리는 시간 제한·취소를 위한 것이며 보안 격리가 아니다. 신뢰된 프로젝트의 테스트만 대상으로 한다.',
      '3단계는 원본 테스트의 고정 기대값(대체 객체 응답에 의존)을 실제 응답과 비교하지 않는다. 공개 타입 계약·후속 조회·협력 객체 미호출 경로의 원본 오류 검증으로 판정한다.',
      '수동 확인은 자동 판정을 덮어쓰지 않는다.',
    ],
  };
}

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

export function reportHtml(r: Report): string {
  const rows = r.scenarios.map((s) => `<tr><td>${esc(s.title)}</td><td>${esc(s.supportLabel)}</td><td>${esc(s.stage1)}</td><td>${esc(s.stage2)}</td><td>${esc(s.stage3Stage ? `${s.stage3Stage.label} (#${s.stage3Stage.attempt}, 실제 요청 ${s.stage3Stage.requests}건${s.stage3Stage.inputChanged ? ', 입력 변경' : ''})` : '미실행')}</td><td>${esc(s.stage3Mock ? `${s.stage3Mock.status} (#${s.stage3Mock.attempt})` : '-')}</td></tr>`).join('');
  return `<!doctype html><html lang="ko"><meta charset="utf-8"><title>스테이지 검증 보고서 ${esc(r.runId)}</title>
<style>body{font:14px/1.5 system-ui,sans-serif;margin:2rem;color:#1d2330}table{border-collapse:collapse;width:100%;margin:.5rem 0 1.5rem}td,th{border:1px solid #d5d9e2;padding:.35rem .5rem;text-align:left;vertical-align:top}th{background:#f2f4f8}h1{font-size:1.4rem}code,pre{font:12px ui-monospace,monospace;background:#f5f6f8;padding:.1rem .3rem}pre{padding:.6rem;overflow:auto}.d{font-weight:700;font-size:1.1rem}</style>
<h1>스테이지 검증 보고서</h1>
<p class="d">배포 판단: ${esc(r.decision.label)}</p><ul>${r.decision.reasons.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
<h2>식별 정보</h2><pre>${esc(JSON.stringify(r.identity, null, 2))}</pre>
<h2>환경</h2><pre>${esc(JSON.stringify(r.environment, null, 2))}</pre>
<h2>단계</h2><table><tr><th>단계</th><th>상태</th><th>근거</th></tr>${r.stages.map((s) => `<tr><td>${esc(s.title)}</td><td>${esc(s.label)}</td><td>${esc(s.reason)}</td></tr>`).join('')}</table>
<h2>시나리오</h2><table><tr><th>시나리오</th><th>분석</th><th>1단계</th><th>2단계</th><th>3단계 Stage</th><th>3단계 Mock</th></tr>${rows}</table>
<h2>Mock 연결 변형(2단계)</h2><table>${r.variants.map((v) => `<tr><td>${esc(v.label)}</td><td>${esc(v.status)}</td><td>${esc(v.reason)}</td></tr>`).join('')}</table>
<h2>미검증·미지원</h2><ul>${r.notCovered.map((x) => `<li>${esc(x)}</li>`).join('') || '<li>없음</li>'}</ul>
<h2>수동 확인(자동 판정과 별도)</h2><ul>${r.manual.map((m) => `<li>${esc(m.at)} [${esc(m.verdict)}] ${esc(m.target)}: ${esc(m.note)}</li>`).join('') || '<li>없음</li>'}</ul>
<h2>한계</h2><ul>${r.disclaimers.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>
<p>생성: ${esc(r.generatedAt)} · 실행 ${esc(r.runId)}${r.rerunOf ? ` (재실행 원본 ${esc(r.rerunOf)})` : ''}</p></html>`;
}
