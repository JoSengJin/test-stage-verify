// 실행: node stage/src/cli.ts [--project <패키지 경로> ...]  (프로젝트는 화면에서도 등록 가능) [--port 4400] [--data .stage-data] [--watch]
// 부모(감독) 프로세스가 서버를 자식으로 띄운다. 자식이 종료 코드 75로 끝나면(화면의 "서버 재시작") 같은 인자로 다시 띄운다.
// --watch(또는 STAGE_WATCH=1)면 stage/src 파일이 바뀔 때도 자동으로 다시 띄운다. 그 밖의 종료는 그대로 따른다(충돌을 무한 재시도하지 않음).
import { fork, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const RESTART_EXIT_CODE = 75;
const SELF = fileURLToPath(import.meta.url);
const args = process.argv.slice(2);

function supervise() {
  const watch = args.includes('--watch') || process.env.STAGE_WATCH === '1';
  const childArgs = args.filter((a) => a !== '--watch');
  let child: ChildProcess | undefined;
  let stopping = false;
  let restartReason: string | undefined;

  const start = () => {
    child = fork(SELF, childArgs, { env: { ...process.env, STAGE_CHILD: '1', STAGE_SUPERVISED: '1' } });
    child.on('exit', (code, signal) => {
      child = undefined;
      if (stopping) process.exit(code ?? 0);
      if (code === RESTART_EXIT_CODE || restartReason) {
        console.log(`[감독] 서버를 다시 시작합니다 (${restartReason ?? '화면에서 재시작 요청'})`);
        restartReason = undefined;
        start();
        return;
      }
      console.log(`[감독] 서버가 종료되었습니다(코드 ${code ?? signal}) — 다시 시작하지 않습니다`);
      process.exit(code ?? 1);
    });
  };

  const restart = (why: string) => {
    if (!child || restartReason) return;
    restartReason = why;
    child.kill('SIGTERM');
  };

  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => { stopping = true; if (child) child.kill(sig); else process.exit(0); });

  if (watch) {
    const src = path.dirname(SELF).replace(/[/\\]src$/, '') + path.sep + 'src';
    let timer: NodeJS.Timeout | undefined;
    fs.watch(path.join(path.dirname(SELF), '..', 'src'), { recursive: true }, (_ev, file) => {
      if (!file || !/\.(ts|mjs|js)$/.test(String(file))) return;
      clearTimeout(timer);
      timer = setTimeout(() => restart(`코드 변경 감지: ${file}`), 300);
    });
    console.log(`[감독] 코드 변경 감시 중: ${src}`);
  }
  start();
}

async function serve() {
  const { createStageServer } = await import('./server.ts');
  const projects: string[] = [];
  let port = 4400;
  let dataDir = path.resolve(path.dirname(SELF), '..', '..', '.stage-data');
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--project') projects.push(args[++i]);
    else if (args[i] === '--port') port = Number(args[++i]);
    else if (args[i] === '--data') dataDir = path.resolve(args[++i]);
  }
  // 감독 프로세스가 없으면 재시작을 제공하지 않는다(그냥 종료되어 서버가 사라지기 때문).
  const supervised = process.env.STAGE_SUPERVISED === '1' && !!process.send;
  const s = createStageServer({ projects, dataDir, port, restart: supervised ? () => process.exit(RESTART_EXIT_CODE) : undefined });
  await s.listen();
  console.log(`스테이지 UI: http://127.0.0.1:${port}${supervised ? ' (재시작 가능)' : ''}`);
  const reg = s.listProjects();
  console.log(`등록 프로젝트: ${reg.length ? reg.join(', ') : '없음 — 화면에서 등록하세요'}`);
  console.log(`결과 저장: ${dataDir}`);
  if (reg[0]) console.log(`Stage 대상: ${s.rm.stageTarget(s.rm.stageConfig(reg[0])) ?? '설정 없음'}`);
  // 감독 프로세스가 사라지면(터미널 종료·preview 중지 등) 고아 서버가 포트를 잡고 남지 않도록 같이 종료한다.
  if (supervised) process.on('disconnect', () => process.exit(0));
}

if (process.env.STAGE_CHILD === '1' || process.env.STAGE_NO_SUPERVISOR === '1') await serve();
else supervise();
