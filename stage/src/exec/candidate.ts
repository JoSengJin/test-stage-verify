// 배포 후보 준비: 프로젝트의 npm pack(=prepack 빌드 포함)으로 실제 tarball을 만들고,
// 별도 컨슈머 샌드박스에 pnpm install(lockfile 미사용)로 설치한다. 유령의존성을 막는 pnpm의 엄격한 node_modules 구조를 그대로 쓴다. 식별 정보(해시·파일 목록·커밋)를 기록한다.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import ts from 'typescript';
import type { Finding, Scenario, TypeSchema } from '../model.ts';
import { toSchema, awaitedReturn } from '../analysis/schema.ts';
import { sha256 } from '../util.ts';

export interface CandidateInfo {
  id: string;
  packageName: string;
  version: string;
  tarball: string;
  tarballSha256: string;
  npmIntegrity?: string;
  files: string[];
  consumerDir: string;
  entryFile: string;
  installedAt: string;
  boundary: { ok: boolean; notes: string[] };
  /** true면 배포 tarball이 아니라 프로젝트 진입 파일을 직접 쓰는 후보(2단계 건너뜀) */
  source?: boolean;
}

export interface ProcResult { code: number | null; stdout: string; stderr: string; killed: boolean }

export function runProc(cmd: string, args: string[], opts: { cwd: string; env?: NodeJS.ProcessEnv; signal?: AbortSignal; timeoutMs?: number }): Promise<ProcResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env ?? process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = ''; let killed = false;
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const kill = () => { killed = true; child.kill('SIGKILL'); };
    const timer = opts.timeoutMs ? setTimeout(kill, opts.timeoutMs) : undefined;
    opts.signal?.addEventListener('abort', kill, { once: true });
    child.on('close', (code) => { if (timer) clearTimeout(timer); opts.signal?.removeEventListener('abort', kill); resolve({ code, stdout, stderr, killed }); });
  });
}

/**
 * sandboxRoot는 저장소 밖(기본: OS 임시 디렉터리)에 둔다. 저장소 안에 두면 Node 모듈 해석이 상위 node_modules로
 * 올라가 배포 후보에 없는 의존성을 우연히 찾을 수 있기 때문이다.
 */
export async function prepareCandidate(projectRoot: string, sandboxRoot: string, log: (m: string) => void, signal?: AbortSignal, opts: { extraDependencies?: Record<string, string> } = {}): Promise<CandidateInfo> {
  const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'));
  const work = (fs.mkdirSync(sandboxRoot, { recursive: true }), fs.mkdtempSync(path.join(sandboxRoot, 'pack-')));
  log(`npm pack (${pkg.name}@${pkg.version}) — prepack 스크립트가 있으면 프로젝트 빌드가 실행됨`);
  const pack = await runProc('npm', ['pack', '--json', '--pack-destination', work], { cwd: projectRoot, signal, timeoutMs: 120_000 });
  if (pack.killed) throw new Error('npm pack 취소/시간 초과');
  if (pack.code !== 0) throw new Error(`npm pack 실패(code ${pack.code}): ${pack.stderr.slice(-2000)}`);
  const jsonStart = pack.stdout.indexOf('[');
  const info = JSON.parse(pack.stdout.slice(jsonStart))[0];
  const tarball = path.join(work, info.filename);
  const tarballSha256 = sha256(fs.readFileSync(tarball));
  const id = `${pkg.name}@${pkg.version}#${tarballSha256.slice(0, 12)}`;
  const files: string[] = info.files.map((f: any) => f.path);

  // 경계 확인: 테스트·스테이지 도구 파일이 배포물에 들어가지 않았는지
  const notes: string[] = [];
  const leaked = files.filter((f) => /(^|\/)(test|tests|__tests__)\/|\.test\.|stage\.config\.json$|(^|\/)\.stage-data\//.test(f));
  if (leaked.length) notes.push(`배포물에 테스트/스테이지 파일 포함: ${leaked.join(', ')}`);
  else notes.push(`배포물 파일 ${files.length}개 중 테스트·스테이지 도구 파일 없음`);

  const finalDir = path.join(sandboxRoot, tarballSha256.slice(0, 16));
  const consumerDir = path.join(finalDir, 'consumer');
  const finalTar = path.join(finalDir, info.filename);
  if (!fs.existsSync(path.join(consumerDir, 'node_modules', pkg.name, 'package.json'))) {
    fs.mkdirSync(consumerDir, { recursive: true });
    fs.copyFileSync(tarball, finalTar);
    fs.writeFileSync(path.join(consumerDir, 'package.json'), JSON.stringify({
      name: 'stage-consumer-sandbox', private: true, type: 'module',
      // extraDependencies: 소비자 앱이 이미 갖고 있는 peer 의존성(next·react 등). 배포 패키지가 선언한 범위 안의 버전으로 설치한다.
      dependencies: { ...(opts.extraDependencies ?? {}), [pkg.name]: `file:../${info.filename}` },
    }, null, 2));
    log(`컨슈머 샌드박스에 설치: pnpm install ${info.filename} (--ignore-scripts, lockfile 미사용, 레지스트리는 사내 넥서스)`);
    const inst = await runProc('pnpm', ['install', '--lockfile=false', '--ignore-scripts', '--prefer-offline', '--reporter=silent'], { cwd: consumerDir, signal, timeoutMs: 180_000 });
    if (inst.killed) throw new Error('npm install 취소/시간 초과');
    if (inst.code !== 0) throw new Error(`배포 후보 설치 실패(code ${inst.code}): ${inst.stderr.slice(-2000)}`);
  } else log('같은 해시의 배포 후보가 이미 설치되어 있어 재사용');
  fs.rmSync(work, { recursive: true, force: true });

  // 컨슈머와 같은 방식(패키지 지정자, import 조건)으로 해석되도록 샌드박스 안에 진입 파일을 둔다.
  const entryFile = path.join(consumerDir, 'stage-entry.mjs');
  fs.writeFileSync(entryFile, `import * as api from ${JSON.stringify(pkg.name)};\nexport default api;\n`);
  return {
    id, packageName: pkg.name, version: pkg.version, tarball: finalTar, tarballSha256, npmIntegrity: info.integrity,
    files, consumerDir, entryFile, installedAt: new Date().toISOString(), boundary: { ok: leaked.length === 0, notes },
  };
}

export interface CandidateContract {
  findings: Finding[];
  /** 시나리오 id → 단계 id → 배포 후보 타입 기준 반환 스키마 */
  returns: Record<string, Record<string, { schema: TypeSchema; text: string }>>;
  /** 컨슈머 초기화 함수 기준 메서드 반환 스키마 */
  consumerReturns: Record<string, { schema: TypeSchema; text: string }>;
  typesFile?: string;
}

/** 설치된 배포 후보의 타입 선언(.d.ts)을 TypeScript로 읽어 시나리오가 쓰는 공개 export·메서드를 대조한다. */
export function checkCandidateContract(c: CandidateInfo, scenarios: Scenario[], setupExport?: string): CandidateContract {
  const probe = path.join(c.consumerDir, 'stage-probe.ts');
  fs.writeFileSync(probe, `import * as api from ${JSON.stringify(c.packageName)};\nexport { api };\n`);
  const program = ts.createProgram([probe], {
    module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, target: ts.ScriptTarget.ES2022,
    strict: true, noEmit: true, skipLibCheck: true, types: [],
  });
  const checker = program.getTypeChecker();
  const sf = program.getSourceFile(probe)!;
  const findings: Finding[] = [];
  const out: CandidateContract = { findings, returns: {}, consumerReturns: {} };
  const imp = sf.statements.find(ts.isImportDeclaration)!;
  const resolved = ts.resolveModuleName(c.packageName, probe, program.getCompilerOptions(), ts.sys).resolvedModule;
  out.typesFile = resolved?.resolvedFileName ? path.relative(c.consumerDir, resolved.resolvedFileName) : undefined;
  const nsSym = checker.getSymbolAtLocation((imp.importClause!.namedBindings as ts.NamespaceImport).name);
  const modSym = nsSym && checker.getAliasedSymbol(nsSym);
  if (!modSym || !resolved) {
    findings.push({ ruleId: 'candidate/types', level: 'partial', message: '배포 후보의 타입 선언을 찾지 못해 타입 계약을 대조할 수 없음' });
    return out;
  }
  const exports = new Map(checker.getExportsOfModule(modSym).map((s) => [s.name, s]));
  const typeOfExport = (name: string) => {
    const s = exports.get(name)!;
    const r = s.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(s) : s;
    return { sym: r, type: checker.getTypeOfSymbolAtLocation(r, sf) };
  };
  for (const sc of scenarios) {
    out.returns[sc.id] = {};
    const instClass: Record<string, ts.Type> = {};
    for (const st of sc.steps) {
      if (st.kind === 'construct') {
        const t = sc.targets.find((x) => x.id === st.target);
        const name = t?.publicApi.exportName;
        if (!name || !exports.has(name)) {
          findings.push({ ruleId: 'candidate/export-missing', level: 'mismatch', message: `[${sc.title}] 배포 후보 타입에 공개 export '${name ?? t?.sourceExport}'이(가) 없음`, loc: st.loc });
          continue;
        }
        const { type } = typeOfExport(name);
        const ctor = type.getConstructSignatures()[0];
        if (ctor) instClass[st.instance] = ctor.getReturnType();
      }
      if (st.kind === 'call' && st.instance) {
        const it = instClass[st.instance];
        if (!it) continue;
        const prop = checker.getPropertyOfType(it, st.method!);
        if (!prop) { findings.push({ ruleId: 'candidate/method-missing', level: 'mismatch', message: `[${sc.title}] 배포 후보 타입에 '${st.method}'이(가) 없음`, loc: st.loc }); continue; }
        const sig = checker.getTypeOfSymbolAtLocation(prop, sf).getCallSignatures()[0];
        if (sig) { const r = awaitedReturn(checker, sig); out.returns[sc.id][st.id] = { schema: toSchema(checker, r, sf), text: checker.typeToString(r) }; }
      }
      if (st.kind === 'call' && st.target) {
        const t = sc.targets.find((x) => x.id === st.target);
        const name = t?.publicApi.exportName;
        if (!name || !exports.has(name)) { findings.push({ ruleId: 'candidate/export-missing', level: 'mismatch', message: `[${sc.title}] 배포 후보 타입에 공개 함수 '${name ?? t?.sourceExport}'이(가) 없음`, loc: st.loc }); continue; }
        const sig = typeOfExport(name).type.getCallSignatures()[0];
        if (sig) { const r = awaitedReturn(checker, sig); out.returns[sc.id][st.id] = { schema: toSchema(checker, r, sf), text: checker.typeToString(r) }; }
      }
    }
  }
  if (setupExport) {
    if (!exports.has(setupExport)) findings.push({ ruleId: 'candidate/setup-missing', level: 'mismatch', message: `배포 후보 타입에 컨슈머 초기화 '${setupExport}'이(가) 없음` });
    else {
      const sig = typeOfExport(setupExport).type.getCallSignatures()[0];
      const client = sig && awaitedReturn(checker, sig);
      if (client) for (const p of checker.getPropertiesOfType(client)) {
        const ms = checker.getTypeOfSymbolAtLocation(p, sf).getCallSignatures()[0];
        if (ms) { const r = awaitedReturn(checker, ms); out.consumerReturns[p.name] = { schema: toSchema(checker, r, sf), text: checker.typeToString(r) }; }
      }
    }
  }
  return out;
}
