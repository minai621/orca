import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript-api'
import { describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('../..', import.meta.url))
const projects = [
  { app: 'node', tests: 'node' },
  { app: 'tc.node', tests: 'node' },
  { app: 'web', tests: 'web' },
  { app: 'tc.web', tests: 'web' },
  { app: 'cli', tests: 'cli' },
  { app: 'tc.cli', tests: 'cli' }
]

/**
 * 앱 검사에서 분리할 테스트와 fixture 루트를 구분해요.
 * @param path - 검사할 파일의 절대 경로예요.
 */
function isTestRoot(path) {
  return (
    /(?:^|\/)__(?:tests|fixtures)__\//.test(path.replaceAll('\\', '/')) ||
    /\.(?:test|spec)\.[^/]+$/.test(path)
  )
}

/**
 * 테스트도 유지해야 하는 선언 파일과 공통 타입 루트를 구분해요.
 * @param path - 검사할 파일의 절대 경로예요.
 */
function isAmbientRoot(path) {
  return /\.d\.(?:ts|mts|cts)$/.test(path) || path.replaceAll('\\', '/').includes('/src/types/')
}

/**
 * 컴파일과 의존성 탐색 없이 tsconfig의 루트만 읽어요.
 * @param name - config 디렉터리의 tsconfig 이름이에요.
 * @param includeTests - 비교 기준을 위해 앱의 테스트 제외를 해제해요.
 */
function parseRoots(name, includeTests = false) {
  const path = resolve(root, 'config', `tsconfig.${name}.json`)
  const read = ts.readConfigFile(path, ts.sys.readFile)
  expect(read.error).toBeUndefined()
  const config = includeTests
    ? {
        ...read.config,
        exclude: ['../**/node_modules', '../**/bower_components', '../**/jspm_packages', '../out']
      }
    : read.config
  const parsed = ts.parseJsonConfigFileContent(config, ts.sys, dirname(path), undefined, path)
  expect(
    parsed.errors.map((error) => ts.flattenDiagnosticMessageText(error.messageText, '\n'))
  ).toEqual([])
  return parsed
}

describe('application and test typecheck roots', () => {
  it.each(projects)(
    '$app excludes test roots and preserves their separate $tests project',
    ({ app, tests }) => {
      const original = parseRoots(app, true)
      const production = parseRoots(app)
      const testProject = parseRoots(`tests.${tests}`)
      const testRoots = new Set(testProject.fileNames)
      const expectedTests = original.fileNames.filter(isTestRoot)
      expect(expectedTests.length).toBeGreaterThan(0)
      expect(production.fileNames.filter(isTestRoot)).toEqual([])
      expect(production.options.composite).toBe(!app.startsWith('tc.'))
      expect(testProject.options.composite).toBe(false)
      expect(
        testProject.fileNames.filter((path) => !isTestRoot(path) && !isAmbientRoot(path))
      ).toEqual([])
      expect(
        expectedTests.filter((path) => !testRoots.has(path)).map((path) => relative(root, path))
      ).toEqual([])
      const ambientRoots = original.fileNames.filter(isAmbientRoot)
      expect(
        ambientRoots.filter((path) => !testRoots.has(path)).map((path) => relative(root, path))
      ).toEqual([])
      expect(production.fileNames).toEqual(original.fileNames.filter((path) => !isTestRoot(path)))
    }
  )
})
