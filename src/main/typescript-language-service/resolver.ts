import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

export type NativeTypeScript = {
  executable: string
  version: string
}

/**
 * 파일에 가장 가까운 프로젝트의 네이티브 TypeScript 설치를 찾아요.
 * @param rootPath - 언어 서버가 다룰 프로젝트 루트예요.
 * @param filePath - 의존성 탐색을 시작할 문서 경로예요.
 * @returns 네이티브 실행 파일이 없는 버전이면 null을 반환해요.
 */
export function resolveNativeTypeScript(
  rootPath: string,
  filePath: string
): NativeTypeScript | null {
  for (const directory of new Set([dirname(filePath), rootPath])) {
    const require = createRequire(join(directory, '__orca_typescript__.cjs'))
    let packagePath: string
    try {
      packagePath = require.resolve('typescript/package.json')
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'MODULE_NOT_FOUND') {
        continue
      }
      throw error
    }
    const metadata: unknown = JSON.parse(readFileSync(packagePath, 'utf8'))
    if (
      !metadata ||
      typeof metadata !== 'object' ||
      !('version' in metadata) ||
      typeof metadata.version !== 'string'
    ) {
      throw new Error('Invalid project TypeScript package version')
    }
    const major = Number.parseInt(metadata.version, 10)
    if (!Number.isFinite(major)) {
      throw new Error('Invalid project TypeScript package version')
    }
    if (major < 7) {
      return null
    }
    let nativePackage: string
    try {
      nativePackage = createRequire(packagePath).resolve(
        `@typescript/typescript-${process.platform}-${process.arch}/package.json`
      )
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'MODULE_NOT_FOUND') {
        return null
      }
      throw error
    }
    const executable = join(
      dirname(nativePackage),
      'lib',
      process.platform === 'win32' ? 'tsc.exe' : 'tsc'
    )
    return existsSync(executable) ? { executable, version: metadata.version } : null
  }
  return null
}
