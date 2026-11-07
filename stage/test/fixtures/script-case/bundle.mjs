import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outputRoot = resolve(packageRoot, 'dist')

if (dirname(outputRoot) !== packageRoot) {
  throw new Error(`예상하지 못한 출력 경로는 정리할 수 없습니다: ${outputRoot}`)
}

// 하위 패키지 빌드 산출물 폴더. 루트의 exports/main/types도 같은 규칙(./dist/...)을 따른다.
const DIST_PREFIX = './dist/'

/**
 * JSON 파일을 읽는다.
 * @param {string} path JSON 파일 경로
 * @returns {any} 파싱된 객체
 */
function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

/**
 * exports 대상(문자열 또는 조건부 객체)의 ./dist/ 경로를 배포 구조로 변환한다.
 * @param {string|object} target exports 값
 * @param {string} base 배포 기준 경로 (예: ./ffw/ 또는 ./)
 * @returns {string|object} 배포 기준으로 변환된 값
 */
function toPublishedTarget(target, base) {
  if (typeof target === 'object') {
    return Object.fromEntries(
        Object.entries(target).map(([condition, value]) => [
          condition,
          toPublishedTarget(value, base),
        ]),
    )
  }

  return target.replace(DIST_PREFIX, base)
}

const sourceManifest = readJson(resolve(packageRoot, 'package.json'))

// 루트 package.json의 files가 통합 배포할 하위 패키지(packages/<name>)를 정한다.
const packages = sourceManifest.files.map((name) => {
  const directory = resolve(packageRoot, 'packages', name)
  const source = resolve(directory, 'dist')

  if (!existsSync(source)) {
    throw new Error(`빌드 산출물이 없습니다: ${source}`)
  }

  return { name, source, manifest: readJson(resolve(directory, 'package.json')) }
})

// 각 하위 패키지 exports를 그대로 이어받아 ./<name>/... 하위로 배치한다.
const publishedExports = {}

for (const { name, manifest } of packages) {
  for (const [key, target] of Object.entries(manifest.exports)) {
    const publishedKey = key === '.' ? `./${name}` : `./${name}${key.slice(1)}`

    publishedExports[publishedKey] = toPublishedTarget(target, `./${name}/`)
  }
}

// 루트 진입점(.)과 main/types는 files의 첫 번째 패키지의 정의를 이어받는다.
const entryPackage = packages[0]

publishedExports['.'] = publishedExports[`./${entryPackage.name}`]

rmSync(outputRoot, { recursive: true, force: true })
mkdirSync(outputRoot, { recursive: true })
for (const { name, source } of packages) {
  cpSync(source, resolve(outputRoot, name), { recursive: true })
}

/**
 * exports 대상 문자열을 모두 모은다 (조건부 객체 포함).
 * @param {string|object} target exports 값
 * @returns {string[]} 대상 경로 목록
 */
function collectTargets(target) {
  return typeof target === 'object' ? Object.values(target).flatMap(collectTargets) : [target]
}

// 패턴(*)이 아닌 exports 대상 파일이 산출물에 실제로 있는지 확인한다.
const missingTargets = Object.entries(publishedExports).flatMap(([key, target]) =>
  collectTargets(target)
    .filter((file) => !file.includes('*') && !existsSync(resolve(outputRoot, file)))
    .map((file) => `${key} -> ${file}`),
)

if (missingTargets.length > 0) {
  throw new Error(`exports 대상 파일이 산출물에 없습니다:\n${missingTargets.join('\n')}`)
}

const publishedManifest = {
  name: sourceManifest.name,
  version: sourceManifest.version,
  type: 'module',
  main: toPublishedTarget(entryPackage.manifest.main, `./${entryPackage.name}/`),
  types: toPublishedTarget(entryPackage.manifest.types, `./${entryPackage.name}/`),
  exports: publishedExports,
  files: sourceManifest.files,
  dependencies: sourceManifest.dependencies,
  peerDependencies: sourceManifest.peerDependencies,
}
writeFileSync(
    resolve(outputRoot, 'package.json'),
    `${JSON.stringify(publishedManifest, null, 2)}\n`,
)

// 하위 패키지명(manifest.name) -> 배포 패키지 내 경로(<루트 name>/<폴더>) 치환 규칙
const importRewrites = packages.map(({ name, manifest }) => [
  manifest.name,
  `${sourceManifest.name}/${name}`,
])

/**
 * 배포본에서 하위 패키지 간 import를 배포 패키지 경로로 치환한다.
 * @param {string} directory 치환할 디렉터리
 */
function rewriteInternalImports(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      rewriteInternalImports(path)
    } else if (entry.name.endsWith('.tsbuildinfo')) {
      rmSync(path)
    } else if (['.js', '.ts', '.map'].includes(extname(entry.name))) {
      const source = readFileSync(path, 'utf8')
      const rewritten = importRewrites.reduce(
          (text, [from, to]) => text.replaceAll(from, to),
          source,
      )
      if (rewritten !== source) {
        writeFileSync(path, rewritten)
      }
    }
  }
}

rewriteInternalImports(outputRoot)
