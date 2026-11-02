import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { resolveNativeTypeScript } from './resolver'

const roots: string[] = []
/**
 * 프로젝트 로컬 의존성을 검증할 임시 설치를 만들어요.
 * @param version - typescript 패키지 버전이에요.
 * @param native - 플랫폼 실행 파일을 함께 만들지 정해요.
 */
function fixture(version: string, native = true): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'orca-typescript-')))
  roots.push(root)
  const compiler = join(root, 'node_modules', 'typescript')
  mkdirSync(compiler, { recursive: true })
  writeFileSync(join(compiler, 'package.json'), JSON.stringify({ name: 'typescript', version }))
  if (native) {
    const platformPackage = join(
      root,
      'node_modules',
      '@typescript',
      `typescript-${process.platform}-${process.arch}`
    )
    mkdirSync(join(platformPackage, 'lib'), { recursive: true })
    writeFileSync(join(platformPackage, 'package.json'), '{}')
    writeFileSync(
      join(platformPackage, 'lib', process.platform === 'win32' ? 'tsc.exe' : 'tsc'),
      ''
    )
  }
  return root
}
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('project native compiler resolution', () => {
  it('resolves the platform binary of TypeScript 7 from nested documents', () => {
    const root = fixture('7.0.2')
    expect(resolveNativeTypeScript(root, join(root, 'src', 'file.ts'))).toEqual({
      version: '7.0.2',
      executable: join(
        root,
        'node_modules',
        '@typescript',
        `typescript-${process.platform}-${process.arch}`,
        'lib',
        process.platform === 'win32' ? 'tsc.exe' : 'tsc'
      )
    })
  })
  it('does not use a native binary with TypeScript 6 or without its optional platform package', () => {
    for (const root of [fixture('6.0.3'), fixture('7.0.2', false)]) {
      expect(resolveNativeTypeScript(root, join(root, 'file.ts'))).toBeNull()
    }
  })
  it('prefers a nested project installation over the workspace installation', () => {
    const root = fixture('7.0.2')
    const nested = join(root, 'packages', 'nested', 'node_modules', 'typescript')
    mkdirSync(nested, { recursive: true })
    writeFileSync(join(nested, 'package.json'), JSON.stringify({ version: '6.0.3' }))
    expect(resolveNativeTypeScript(root, join(root, 'packages', 'nested', 'file.ts'))).toBeNull()
  })
})
