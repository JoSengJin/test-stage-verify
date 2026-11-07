// 배포 후보 재실행용 모듈 해석 훅(--import로 주입). 원본 테스트 파일은 그대로 두고,
// 프로젝트의 배포 단위 디렉터리(dist) 아래 파일 import만 소비자 샌드박스에 설치된 배포 후보 파일로 바꾼다.
//   STAGE_REDIRECT_FROM : 프로젝트의 배포 단위 디렉터리(예: <root>/dist)
//   STAGE_REDIRECT_TO   : 소비자 샌드박스에 설치된 패키지 디렉터리(realpath)
//   STAGE_REDIRECT_ROOT : 프로젝트 루트(peer 의존성은 호스트=테스트 쪽 사본을 쓴다)
//   STAGE_REDIRECT_LOG  : 리다이렉트된 모듈 목록을 NDJSON으로 기록할 파일
import fs from 'node:fs';
import path from 'node:path';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Node ESM은 해석 결과를 realpath로 돌려주므로(macOS /var → /private/var 등) 비교 기준도 realpath로 맞춘다.
const real = (p) => { try { return p ? fs.realpathSync(p) : p; } catch { return p; } };
const from = real(process.env.STAGE_REDIRECT_FROM);
const to = real(process.env.STAGE_REDIRECT_TO);
const root = real(process.env.STAGE_REDIRECT_ROOT);
const logFile = process.env.STAGE_REDIRECT_LOG;
if (from && to && root) {
  const fromUrl = pathToFileURL(from + path.sep).href;
  const toUrl = pathToFileURL(to + path.sep).href;
  const hostParent = pathToFileURL(path.join(root, 'package.json')).href;
  let peers = [];
  try { peers = Object.keys(JSON.parse(fs.readFileSync(path.join(to, 'package.json'), 'utf8')).peerDependencies ?? {}); } catch { /* peer 없음 */ }
  const seen = new Set();
  const note = (rec) => { if (!logFile) return; const key = JSON.stringify(rec); if (seen.has(key)) return; seen.add(key); try { fs.appendFileSync(logFile, key + '\n'); } catch { /* 기록 실패는 무시 */ } };
  const inCandidate = (url) => typeof url === 'string' && url.startsWith(toUrl);
  const pkgName = (spec) => (spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]);

  registerHooks({
    resolve(specifier, context, nextResolve) {
      // 배포 후보 안에서 나온 bare import 중 peer 의존성은 호스트(프로젝트) 사본으로 해석해 React 등이 인스턴스 하나로 유지되게 한다.
      if (inCandidate(context.parentURL) && !specifier.startsWith('.') && !specifier.startsWith('/') && !specifier.startsWith('node:') && !specifier.startsWith('file:') && peers.includes(pkgName(specifier))) {
        return nextResolve(specifier, { ...context, parentURL: hostParent });
      }
      let result;
      try {
        result = nextResolve(specifier, context);
      } catch (error) {
        // 번들러 출력의 확장자 없는 상대 import(번들러 환경에서는 유효) — 배포 후보 안에서만 보정한다.
        if (specifier.startsWith('.') && inCandidate(context.parentURL)) {
          for (const suffix of ['.js', '/index.js']) {
            const url = new URL(specifier + suffix, context.parentURL);
            if (fs.existsSync(fileURLToPath(url))) return nextResolve(url.href, context);
          }
        }
        throw error;
      }
      if (result.url.startsWith(fromUrl)) {
        const rel = result.url.slice(fromUrl.length);
        const target = new URL(rel, toUrl);
        if (!fs.existsSync(fileURLToPath(target))) {
          note({ missing: rel });
          throw new Error(`배포 후보에 없는 파일: ${rel} (프로젝트 dist에는 있으나 pack된 배포물에 포함되지 않음)`);
        }
        note({ redirected: rel });
        return { ...result, url: target.href };
      }
      return result;
    },
  });
}
