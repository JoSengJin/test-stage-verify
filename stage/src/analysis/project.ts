// 프로젝트 문맥 해석: package.json, 실행 스크립트(러너), 공개 entry ↔ 소스 대응, git 식별 정보.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';
import type { ProjectInfo, RunnerInfo } from '../model.ts';
import { sha256 } from '../util.ts';

export function findProjectRoot(file: string): string | undefined {
  let dir = path.dirname(path.resolve(file));
  for (;;) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export function readJson(file: string): any {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** 셸 문자열을 따옴표를 고려해 토큰으로 나눈다(변수 확장·파이프 등은 지원하지 않으며, 있으면 미인식으로 처리). */
export function tokenizeScript(script: string): string[] | undefined {
  const tokens: string[] = [];
  let cur = '';
  let quote: string | null = null;
  let has = false;
  for (const ch of script) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; has = true; continue; }
    if (/\s/.test(ch)) { if (has || cur) tokens.push(cur); cur = ''; has = false; continue; }
    if ('|&;<>$`'.includes(ch)) return undefined;
    cur += ch;
  }
  if (quote) return undefined;
  if (has || cur) tokens.push(cur);
  return tokens;
}

export function detectRunner(pkg: any): RunnerInfo {
  const script: string | undefined = pkg?.scripts?.test;
  if (!script) return { kind: 'unknown', flags: [], evidence: 'package.json에 scripts.test가 없음' };
  const tokens = tokenizeScript(script);
  if (!tokens) return { kind: 'unknown', script, flags: [], evidence: 'scripts.test에 셸 연산자가 있어 해석하지 않음' };
  if (tokens[0] === 'node' && tokens.includes('--test')) {
    const flags = tokens.slice(1).filter((t) => t.startsWith('--') && t !== '--test' && !t.startsWith('--test-reporter'));
    return { kind: 'node-test', script, flags, evidence: `scripts.test = ${JSON.stringify(script)} → Node 내장 테스트 러너(node --test)` };
  }
  return { kind: 'unknown', script, flags: [], evidence: `scripts.test = ${JSON.stringify(script)}: 인식기가 없는 러너(현재 node --test만 지원)` };
}

export function gitInfo(root: string): ProjectInfo['git'] {
  try {
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    const status = execFileSync('git', ['status', '--porcelain', '--', '.'], { cwd: root, encoding: 'utf8' });
    return { commit, dirty: status.trim().length > 0 };
  } catch (e: any) {
    let dirty: boolean | undefined;
    try { dirty = execFileSync('git', ['status', '--porcelain', '--', '.'], { cwd: root, encoding: 'utf8' }).trim().length > 0; } catch { /* git 없음 */ }
    return { dirty, error: 'HEAD 커밋 없음 또는 git 저장소 아님' };
  }
}

interface BuildConfig { rootDir: string; outDir: string; configFile: string }

/** 프로젝트의 tsconfig*.json 중 outDir를 가진 빌드 설정을 TypeScript로 해석한다. */
function buildConfigs(root: string): BuildConfig[] {
  const out: BuildConfig[] = [];
  for (const f of fs.readdirSync(root)) {
    if (!/^tsconfig.*\.json$/.test(f)) continue;
    const configFile = path.join(root, f);
    const parsed = ts.getParsedCommandLineOfConfigFile(configFile, {}, {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic: () => {},
    });
    const o = parsed?.options;
    if (o?.outDir && o.rootDir) out.push({ rootDir: o.rootDir, outDir: o.outDir, configFile });
  }
  return out;
}

function exportTargets(pkg: any): { subpath: string; js?: string; types?: string }[] {
  const exp = pkg.exports;
  const pick = (v: any): { js?: string; types?: string } => {
    if (typeof v === 'string') return { js: v };
    if (v && typeof v === 'object') {
      const types = typeof v.types === 'string' ? v.types : undefined;
      for (const cond of ['import', 'node', 'default', 'require']) {
        if (typeof v[cond] === 'string') return { js: v[cond], types };
        if (v[cond] && typeof v[cond] === 'object') return { ...pick(v[cond]), types: types ?? pick(v[cond]).types };
      }
      return { types };
    }
    return {};
  };
  if (exp === undefined) return pkg.main ? [{ subpath: '.', js: pkg.main, types: pkg.types }] : [];
  if (typeof exp === 'string' || !Object.keys(exp).some((k) => k.startsWith('.'))) return [{ subpath: '.', ...pick(exp) }];
  return Object.entries(exp).filter(([k]) => !k.includes('*')).map(([k, v]) => ({ subpath: k, ...pick(v) }));
}

export function projectInfo(root: string): ProjectInfo {
  const pkgFile = path.join(root, 'package.json');
  const pkg = readJson(pkgFile);
  const configs = buildConfigs(root);
  const publicEntries: ProjectInfo['publicEntries'] = [];
  // 루트 package.json에 exports·main이 없고 dist/package.json이 exports를 선언하면 dist를 배포 단위로 본다.
  let packageDir: string | undefined;
  let packageDirEvidence: string | undefined;
  let entryPkg = pkg;
  const distPkgFile = path.join(root, 'dist', 'package.json');
  if (pkg.exports === undefined && !pkg.main && fs.existsSync(distPkgFile)) {
    const distPkg = readJson(distPkgFile);
    if (distPkg.exports !== undefined) {
      packageDir = path.join(root, 'dist');
      packageDirEvidence = '루트 package.json에 exports·main이 없어 dist/package.json의 exports를 공개 진입점으로 사용(dist를 배포 단위로 pack)';
      entryPkg = { ...distPkg, name: distPkg.name ?? pkg.name, version: distPkg.version ?? pkg.version };
    }
  }
  const baseDir = packageDir ?? root;
  for (const t of exportTargets(entryPkg)) {
    const specifier = t.subpath === '.' ? entryPkg.name : `${entryPkg.name}/${t.subpath.replace(/^\.\//, '')}`;
    if (!t.js) { publicEntries.push({ subpath: t.subpath, specifier, evidence: 'exports에 실행 가능한 조건(import/default)이 없음' }); continue; }
    const dist = path.resolve(baseDir, t.js);
    let sourceFile: string | undefined;
    let evidence = `exports["${t.subpath}"] → ${t.js}: 대응 소스를 찾지 못함(outDir/rootDir를 가진 tsconfig 없음 또는 파일 없음)`;
    for (const c of configs) {
      const rel = path.relative(c.outDir, dist);
      if (rel.startsWith('..')) continue;
      const base = path.join(c.rootDir, rel).replace(/\.(m|c)?js$/, '');
      for (const ext of ['.ts', '.mts', '.tsx', '.cts', '.js', '.mjs']) {
        if (fs.existsSync(base + ext)) { sourceFile = base + ext; break; }
      }
      if (sourceFile) {
        evidence = `exports["${t.subpath}"] → ${t.js}; ${path.basename(c.configFile)}의 outDir(${path.relative(root, c.outDir)}) → rootDir(${path.relative(root, c.rootDir)}) 대응 → ${path.relative(root, sourceFile)}`;
        break;
      }
    }
    if (!sourceFile && fs.existsSync(dist) && !dist.includes(`${path.sep}dist${path.sep}`)) {
      sourceFile = dist;
      evidence = `exports["${t.subpath}"] → ${t.js} (소스 파일 직접 노출)`;
    }
    publicEntries.push({ subpath: t.subpath, specifier, distFile: dist, sourceFile, evidence });
  }
  return {
    root,
    name: entryPkg.name,
    version: entryPkg.version,
    packageDir,
    packageDirEvidence,
    packageJsonSha256: sha256(fs.readFileSync(pkgFile)),
    git: gitInfo(root),
    runner: detectRunner(pkg),
    publicEntries,
  };
}

/** 프로젝트 안의 테스트 후보 파일(node_modules·dist 제외). 드롭 파일 연결에 사용한다. */
export function listProjectFiles(root: string, max = 5000): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (out.length >= max) return;
      if (ent.name === 'node_modules' || ent.name === 'dist' || ent.name.startsWith('.')) continue;
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (/\.(m|c)?(t|j)sx?$/.test(ent.name)) out.push(p);
    }
  };
  walk(root);
  return out;
}
