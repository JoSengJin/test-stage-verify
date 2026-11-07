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
