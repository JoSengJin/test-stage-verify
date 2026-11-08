// 공통 실행 모델. 분석기·실행기·UI가 공유하는 직렬화 가능한 데이터만 담는다.
// 실제 실행 코드는 CodeRef(패키지 지정자 + export 이름)로만 참조하고, 실행 시점에 자식 프로세스가 해석한다.

export const RULES_VERSION = 'london-node-test/1.0.0';
export const FRAMEWORK_VERSION = '0.1.0';

export type SupportStatus = 'auto' | 'partial' | 'unsupported' | 'contract-mismatch' | 'no-target';

export const SUPPORT_LABEL: Record<SupportStatus, string> = {
  auto: '자동 실행 가능',
  partial: '일부 연결 필요',
  unsupported: '미지원',
  'contract-mismatch': '계약 불일치',
  'no-target': '실행 가능한 대상 없음',
};

export interface Loc {
  file: string;
  line: number;
  column: number;
}

export type FindingLevel = 'info' | 'partial' | 'unsupported' | 'mismatch' | 'no-target';

export interface Finding {
  ruleId: string;
  level: FindingLevel;
  message: string;
  loc?: Loc;
  evidence?: string;
}

/**
 * 태그된 JSON 값. 일반 JSON은 그대로, JSON으로 표현할 수 없는 값은 {"$stage": 종류, ...}로 표현한다.
 * - {"$stage":"undefined"}
 * - {"$stage":"error", name, message, props?}
 * - {"$stage":"construct", export: 공개 export 이름, sourceExport, args: Value[]}
 * - {"$stage":"regexp", source, flags}
 * - {"$stage":"function", name}   (실행 결과 표시 전용)
 * - {"$stage":"object", ctor}     (실행 결과 표시 전용)
 */
export type Value = unknown;

export type TypeSchema =
  | { kind: 'string' | 'number' | 'boolean' | 'null' | 'undefined' | 'unknown' | 'any' | 'void' | 'never' }
  | { kind: 'literal'; value: string | number | boolean }
  | { kind: 'union'; options: TypeSchema[] }
  | { kind: 'object'; name?: string; props: Record<string, { schema: TypeSchema; optional: boolean }> }
  | { kind: 'array'; element: TypeSchema }
  | { kind: 'function'; text: string }
  | { kind: 'ref'; text: string };

export interface PublicMapping {
  status: 'mapped' | 'unmapped';
  /** 컨슈머 import 지정자, 예: "@sample/order-client" */
  specifier?: string;
  exportName?: string;
  evidence: string;
}

export interface TargetRef {
  id: string;
  kind: 'class' | 'function' | 'value';
  sourceFile: string;
  sourceExport: string;
  importedAs: string;
  loc: Loc;
  publicApi: PublicMapping;
}

export type Behavior =
  | { kind: 'returns'; value: Value }
  | { kind: 'resolves'; value: Value }
  | { kind: 'rejects'; value: Value }
  | { kind: 'throws'; value: Value }
  | { kind: 'noop' };

export interface DoubleSpec {
  id: string;
  varName: string;
  shape: 'object' | 'function';
  loc: Loc;
  /** shape=object: 메서드별 동작. shape=function: 키 "()" 하나. */
  methods: Record<string, { behavior: Behavior; loc: Loc }>;
  /** 이 대체 객체가 전달된 대상 매개변수 타입(협력 관계 근거). */
  collaboratorOf?: { step: string; param: string; type: string };
}

export type ArgRef =
  | { kind: 'value'; value: Value }
  | { kind: 'double'; id: string }
  | { kind: 'doubleMethod'; id: string; method: string };

export type Subject =
  | { kind: 'result'; step: string; path: (string | number)[] }
  | { kind: 'callCount'; double: string; method: string }
  | { kind: 'callArgs'; double: string; method: string; call: number }
  | { kind: 'callArg'; double: string; method: string; call: number; arg: number };

export type ErrorMatcher =
  | { kind: 'object'; value: Value }
  | { kind: 'regexp'; value: Value }
  /** 공개 API의 오류 클래스(instanceof). target은 TargetRef.id */
  | { kind: 'ctor'; target: string }
  | { kind: 'builtin'; name: string };

export type Check =
  /** node:assert의 같은 함수(op)를 같은 모듈(module)에서 불러 실행하므로 판정 의미가 원본 테스트와 같다. */
  | { id: string; kind: 'compare'; module: AssertModule; op: string; subject: Subject; expected?: Value; loc: Loc; source: string }
  | { id: string; kind: 'error'; module: AssertModule; op: 'rejects' | 'throws'; step: string; matcher?: ErrorMatcher; loc: Loc; source: string }
  /** 인식하지 못한 assertion. 누락하지 않고 미지원으로 남긴다. */
  | { id: string; kind: 'unsupported'; loc: Loc; source: string; reason: string };

export type AssertModule = 'node:assert' | 'node:assert/strict';

export type Step =
  | { id: string; kind: 'construct'; target: string; instance: string; args: ArgRef[]; params: ParamInfo[]; loc: Loc; source: string }
  | {
      id: string;
      kind: 'call';
      /** 인스턴스 메서드 호출이면 instance, 공개 함수 호출이면 target */
      instance?: string;
      target?: string;
      method?: string;
      args: ArgRef[];
      params: ParamInfo[];
      returns: TypeSchema;
      returnsText: string;
      awaited: boolean;
      loc: Loc;
      source: string;
    }
  | { id: string; kind: 'check'; check: Check };

export interface ParamInfo {
  name: string;
  optional: boolean;
  type: string;
  schema: TypeSchema;
}

export interface Scenario {
  id: string;
  title: string;
  path: string[];
  loc: Loc;
  runKind: 'stateful-object' | 'function' | 'none';
  targets: TargetRef[];
  doubles: DoubleSpec[];
  steps: Step[];
  teardown: { kind: 'restoreMocks' | 'none'; loc?: Loc }[];
  support: { status: SupportStatus; findings: Finding[] };
  /** 컨슈머 초기화 경로와의 연결(3단계 실제 연계용) */
  consumerLink?: ConsumerLink;
}

export interface ConsumerLink {
  status: 'linked' | 'unlinked';
  setupExport?: string;
  operations?: string[];
  evidence: string;
}

// ---- 실물 연결 구성(wiring) ----
// 테스트가 협력자를 대체 객체(mock)로 바꿔 끼운 지점을 메타정보로 뽑아, "대체 객체를 걷어내고 실제 모듈·실제 서버로 호출"할 때
// 화면에서 전환할 항목을 자동으로 만든다. 시나리오 실행 모델로 옮기지 못하는 테스트(Hook 실행기 등)에도 적용된다.

export interface WiringOption {
  key: string;
  /** literal: 테스트가 준 고정 값, double: 대체 객체, function: 인라인 함수, other: 해석하지 않은 식 */
  kind: 'literal' | 'double' | 'function' | 'other';
  value?: Value;
  source: string;
}

export interface WiringCollaborator {
  /** SUT에 전달되는 옵션 이름 (예: client, onSuccess) */
  option: string;
  /** http-client: 실제 서버로 바꿀 수 있음, observer: 호출 순서·인자만 관찰(대체할 실물이 없음) */
  role: 'http-client' | 'observer';
  methods: string[];
  /** 대체 객체를 만든 식(원본 테스트 소스) */
  origin: string;
  loc: Loc;
}

export interface WiringCall {
  id: string;
  /** 테스트가 호출한 공개 API 이름 */
  sut: string;
  specifier: string;
  /** Verified from the implementation's React imports. */
  hook?: boolean;
  clientFactory?: { specifier: string; exportName: string };
  /** 첫 인자가 문자열 리터럴이면 그 값 (예: 요청 경로) */
  path?: string;
  options: WiringOption[];
  collaborators: WiringCollaborator[];
  loc: Loc;
}

export interface WiringTest {
  id: string;
  title: string;
  path: string[];
  loc: Loc;
  calls: WiringCall[];
  /** globalThis.xxx = mock.fn() 형태로 바꿔 끼운 전역 (예: alert) */
  globals: string[];
}

export interface Wiring {
  sut: { name: string; specifier: string }[];
  tests: WiringTest[];
  needsHttpClient: boolean;
}

// ---- 스크립트 SUT(빌드 스크립트 등) ----
// 테스트가 공개 API가 아니라 스크립트 파일을 import()로 실행하고 협력자(node:fs 등)를 대체 객체로 바꿔 검증하는 유형.
// 2단계에서 샌드박스에 실제로 실행하고, 3단계에서 산출물(배포 exports)이 실제로 import되는지 런타임으로 증명한다.

export interface ScriptTarget {
  /** 프로젝트 루트 기준 상대 경로 */
  file: string;
  evidence: string;
  /** 테스트가 모듈 훅으로 대체 객체로 바꾼 내장 모듈(예: node:fs) */
  replaces: string[];
}

export interface FsTraceEvent {
  seq: number;
  op: string;
  /** 샌드박스 경로는 <root>로 줄여 표시 */
  args: string;
  ms: number;
  error?: string;
}

export interface TreeDiff {
  /** 비교 기준(프로젝트의 기존 dist)이 있었는지 */
  baselineExists: boolean;
  added: string[];
  removed: string[];
  changed: string[];
  total: number;
}

export interface ScriptRunResult {
  scriptFile: string;
  exitCode: number | null;
  error?: string;
  /** 변경 연산(rm·mkdir·cp·write·rename 등)은 모두, 읽기 연산은 횟수만 센다. */
  mutations: FsTraceEvent[];
  readCounts: Record<string, number>;
  truncated: boolean;
  diff: TreeDiff;
  /** 하위 패키지 이름이 치환되지 않고 남은 파일(치환 규칙이 놓친 곳) */
  leftovers: { file: string; name: string; count: number }[];
  distDir?: string;
  durationMs: number;
}

export type ExportVerdict = 'pass' | 'needs-review' | 'fail';

export interface ExportCheckItem {
  /** package.json exports 키 (예: ./ffw/auth) */
  key: string;
  specifier: string;
  /** 패턴(./ffw/*)에서 펼친 항목이면 그 패턴 */
  pattern?: string;
  /** 일반 Node ESM에서 직접 import */
  node: { status: 'ok' | 'bundler-required' | 'failed' | 'skipped'; detail?: string; names?: number };
  /** 소비자 번들러(esbuild) 해석 */
  bundle: { status: 'ok' | 'failed' | 'skipped'; detail?: string; ms?: number };
  /** 번들 결과를 Node에서 평가 */
  run: { status: 'ok' | 'failed' | 'skipped'; detail?: string };
  verdict: ExportVerdict;
  reason: string;
}

export interface ExportsCheck {
  at: string;
  packageName: string;
  total: number;
  counts: Record<ExportVerdict, number>;
  items: ExportCheckItem[];
  durationMs: number;
}

export interface ImportInfo {
  specifier: string;
  kind: 'static' | 'dynamic' | 'type-only';
  role: 'test-tool' | 'target-source' | 'test-helper' | 'public-package' | 'external' | 'unresolved';
  resolvedFile?: string;
  names: string[];
  loc: Loc;
  evidence: string;
}

export interface ProjectInfo {
  root: string;
  name?: string;
  version?: string;
  packageJsonSha256?: string;
  git?: { commit?: string; dirty?: boolean; error?: string };
  runner?: RunnerInfo;
  /** 배포 단위 디렉터리(루트와 다를 때만: 예 dist). 없으면 프로젝트 루트. */
  packageDir?: string;
  packageDirEvidence?: string;
  publicEntries: { subpath: string; specifier: string; distFile?: string; sourceFile?: string; evidence: string }[];
}

export interface RunnerInfo {
  kind: 'node-test' | 'unknown';
  script?: string;
  flags: string[];
  evidence: string;
}

export interface AnalysisResult {
  id: string;
  rulesVersion: string;
  frameworkVersion: string;
  analyzedAt: string;
  input: { fileName: string; sha256: string; linkedPath?: string; linkStatus: 'linked' | 'not-linked'; linkEvidence: string };
  project?: ProjectInfo;
  imports: ImportInfo[];
  scenarios: Scenario[];
  findings: Finding[];
  status: SupportStatus;
  wiring?: Wiring;
  script?: ScriptTarget;
  stageConfig?: { file: string; sha256: string; present: boolean };
}

// ---- 실행 상태 ----

export type ExecStatus = 'queued' | 'preparing' | 'running' | 'passed' | 'failed' | 'cancelled' | 'timeout' | 'not-run';

export const EXEC_LABEL: Record<ExecStatus, string> = {
  queued: '대기',
  preparing: '준비',
  running: '실행',
  passed: '성공',
  failed: '실패',
  cancelled: '취소',
  timeout: '시간 초과',
  'not-run': '미실행',
};

export type LinkVerdict = 'pass' | 'functional-failure' | 'environment-blocked' | 'outcome-unknown';

export const LINK_LABEL: Record<LinkVerdict, string> = {
  pass: '통과',
  'functional-failure': '기능 실패',
  'environment-blocked': '환경 차단',
  'outcome-unknown': '처리 결과 불명',
};

export type ConnectionMode = 'doubles' | 'mock' | 'stage';

export const MODE_LABEL: Record<ConnectionMode, string> = {
  doubles: '테스트 대체 객체(협력 객체 주입)',
  mock: 'Mock (fetch 가로채기)',
  stage: 'Stage (실제 서버, 가로채기 해제)',
};

export interface CheckResult {
  id: string;
  label: string;
  status: 'pass' | 'fail' | 'not-applicable' | 'invalidated' | 'not-run';
  expected?: Value;
  actual?: Value;
  reason: string;
  origin: 'original-test' | 'public-contract' | 'stage-config' | 'runtime';
  loc?: Loc;
}

export interface NetEvidence {
  seq: number;
  at: string;
  mode: ConnectionMode;
  method: string;
  url: string;
  intercepted: boolean;
  blocked?: boolean;
  status?: number;
  error?: string;
  requestHeaders: Record<string, string>;
  requestBody?: Value;
  durationMs?: number;
  source: string;
}

export interface CallEvent {
  seq: number;
  at: number;
  kind: 'action' | 'double-call' | 'action-result';
  name: string;
  args?: Value[];
  result?: Value;
  error?: Value;
  durationMs?: number;
}

export interface ExecOutcome {
  status: ExecStatus;
  checks: CheckResult[];
  events: CallEvent[];
  network: NetEvidence[];
  logs: string[];
  returned?: Value;
  error?: Value;
  durationMs?: number;
  linkVerdict?: LinkVerdict;
  verdictReason?: string;
}
