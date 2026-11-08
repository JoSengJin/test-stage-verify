# 스테이지 검증 프레임워크

배포 후보를 컨슈머와 같은 방식(공개 패키지 지정자로 import)으로 실행·조작·검증하고, 배포 판단 근거를 보고서로 남기는 도구다.
개발용 테스트 러너나 운영 모니터링을 대체하지 않으며, 배포를 수행하지 않는다. 이 디렉터리는 루트 `tsconfig`·패키지 `files`에 포함되지 않아 컨슈머 배포물에 들어가지 않는다.

## 실행

```bash
cp .env.stage.example .env.stage   # Stage 주소·토큰 설정(값은 화면·로그·보고서에 표시되지 않음)
npm run stage:server               # 로컬 Stage 대역 서버(실제 배포된 Stage가 없을 때)
npm run stage                      # http://127.0.0.1:4400
npm test                           # 프레임워크 회귀 테스트(분석 사례·실행 관리·연결 모드)
```

프로젝트는 화면의 "프로젝트 추가"에서 경로를 입력해 등록한다(`.stage-data/projects.json`에 저장되어 재시작 후에도 유지). `--project <경로>`는 선택 사항이며 여러 번 줄 수 있다. 드롭한 파일은 내용 sha256이 같은 프로젝트 파일에만 연결된다.

## 운영 게이트로 쓸 때 (처음 보는 사람용)

이 도구의 산출물은 "배포해도 되는가"에 대한 **판정 + 근거 보고서**다. 판정은 네 가지다.

| 판정 | 뜻 | 할 일 |
|---|---|---|
| 검증 범위 내 통과 | 세 단계 통과, 미검증 항목 없음 | 보고서의 "한계"를 읽고 배포 진행 |
| 조건부 | 통과했지만 미검증 항목이 있음 | 책임자가 미검증 항목 수용 여부 결정 |
| 배포 보류 | 실패·계약 불일치·사람이 기록한 문제 | 고친 뒤 처음부터 재실행 |
| 판단 불가 | 단계 미완료 | 3단계까지 끝낸 뒤 확인 |

게이트가 지키는 규칙(회귀 테스트로 고정: `test/gate.test.ts`, `test/ci-gate.test.ts`, `test/connected-scenarios.test.ts`).
- 기대 검증 코드를 화면에서 고친 결과는 기록은 되지만 판정 근거가 아니다(서버가 원본 코드와 대조).
- 서버(Node)에서 실행하는 경로는 원본 코드와 "모듈·전역 API 참조/호출"뿐인 연결식만 받는다.
- 판정 API는 허용된 Host(localhost, 또는 `STAGE_ALLOWED_HOSTS`)와 같은 출처의 요청만 받는다(DNS rebinding·교차 출처 위조 방어).
- 판정 확정에는 확정자 이름과 확인이 필요하고, 확정자·시각·배포 후보 sha256·브라우저가 보고서에 남는다.
- 자동 검증된 시나리오가 0건이면 통과가 아니다(사람이 직접 호출해 본 것은 근거 제외).
- 시나리오 실행은 60초 시간 제한이 있다. 격리 실행은 localhost 접속에서만 지원하고 다른 주소에서는 막는다.

### 화면 없이 실행(CI)

```bash
npm run stage:ci -- --project examples/order-client --test test/order-service.test.ts --out out/report.json
```

종료 코드: `0` 검증 범위 내 통과 · `1` 실패/보류 · `10` 조건부(`--allow-conditional`이면 0) · `3` 사람의 확인이 필요해 자동 판정 불가 · `2` 사용 오류. 실제 협력자를 사람이 연결해야 하는 테스트는 CI에서 자동 통과시키지 않고 `3`으로 끝난다.

## 구조

| 책임 | 위치 |
|---|---|
| A. 스테이지 UI (드롭·분석·큐·단계·조작 화면·보고서) | `ui/` (브라우저 기본 API만 사용) |
| B. 분석 계층 (TypeScript parser·checker) | `src/analysis/` |
| C. 공통 실행 모델 (직렬화 가능, 코드 참조는 export 이름) | `src/model.ts` |
| D. 실행 어댑터 (배포 후보 자식 프로세스: 상태형 객체·함수, 컨슈머 경로) | `src/exec/child.ts` |
| E. 실행 관리 (큐·단계 의존·동시 실행·시간 제한·취소) | `src/exec/runs.ts` |
| 배포 후보 (npm pack → 저장소 밖 샌드박스 설치 → .d.ts 계약 대조) | `src/exec/candidate.ts` |
| 1단계 (프로젝트 러너 그대로 + NDJSON reporter) | `src/exec/stage1.ts`, `src/exec/reporter.mjs` |
| F. 결과 저장 (JSON 파일, 서버가 원본) | `src/store.ts` → `.stage-data/` |
| 보고서 | `src/report.ts` |

## 선택적 힌트: `stage.config.json` (대상 프로젝트 루트)

컨슈머 초기화(`consumer.setup`), 변경 동작의 멱등성·후속 조회(`operations`), Mock 응답과 2단계 Mock 변형(`mock`)을 적는다.
환경 값은 `{"$env": "NAME", "secret": true}`로 참조한다. 없으면 3단계 실제 연계 화면을 만들지 않고 이유를 표시한다.

## 지원 패턴 확장 절차 (개발·유지보수 단계에서만)

1. 실제 테스트 사례를 `test/fixtures/cases/*.case.ts`에 추가하고 `analysis.test.ts`의 `CASE_EXPECT`에 기대 판정을 적는다.
2. 인식 규칙은 `analyze.ts` 상단 규칙 표(`NODE_TEST`, `NODE_ASSERT`, `COMPARE_OPS` …)와 `ScenarioBuilder`에 추가하고 `RULES_VERSION`을 올린다.
3. `npm test`로 기존 사례 회귀를 확인한다. 기대 모델 변경이 의도된 것이면 `UPDATE_SNAPSHOTS=1 npm test` 후 `test/fixtures/expected/` diff를 검토한다.

제품 실행 중에는 규칙을 바꾸지 않으며, 모르는 구문은 추측하지 않고 `미지원`/`일부 연결 필요`로 남긴다.
