import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript-api'
import { runTypecheckProjects } from './run-typecheck-projects-in-parallel.mjs'

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))
const PROJECT_CONFIGS = {
  node: 'config/tsconfig.node.json',
  web: 'config/tsconfig.tc.web.json',
  cli: 'config/tsconfig.tc.cli.json'
}

/**
 * 파일 검사에 사용할 실행 환경과 대상 파일을 읽어요.
 * @param args - `--project=node|web|cli`와 검사할 TypeScript 파일 경로예요.
 * @returns 선택한 `project`와 검사할 `files`예요.
 */
export function parseFileTypecheckOptions(args) {
  const projectOptions = args.filter((argument) => argument.startsWith('--project='))
  const project = projectOptions[0]?.slice('--project='.length)
  const files = args.filter((argument) => !argument.startsWith('--project='))
  if (projectOptions.length !== 1 || !Object.hasOwn(PROJECT_CONFIGS, project)) {
    throw new Error('Use --project=node|web|cli and explicit TypeScript file paths')
  }
  if (files.length === 0 || files.some((file) => file.startsWith('-'))) {
    throw new Error('Provide at least one TypeScript file path; unknown options are not accepted')
  }
  return { project, files }
}

/**
 * 지정한 파일과 프로젝트의 전역 타입 선언만 검사 시작점으로 설정해요.
 * @param options - 검사 설정이에요.
 * - `root`: 의존성이 설치된 저장소의 절대 경로예요.
 * - `project`: 타입과 모듈 해석 설정을 가져올 `node`, `web`, `cli` 중 하나예요.
 * - `files`: 저장소 안에서 검사할 TypeScript 파일 경로예요. 상대 경로는 `root`를 기준으로 해요.
 * @returns 임시 `config` 경로, 시작점인 `files`, 임시 파일을 지우는 `dispose`를 반환해요.
 */
export function prepareFileTypecheck({ root = repoRoot, project, files }) {
  if (!Object.hasOwn(PROJECT_CONFIGS, project) || files.length === 0) {
    throw new Error('A supported project and at least one file are required')
  }
  const canonicalRoot = realpathSync(root)
  const selected = files.map((file) => {
    const absolute = realpathSync(resolve(canonicalRoot, file))
    const local = relative(canonicalRoot, absolute)
    if (isAbsolute(local) || local === '..' || local.startsWith(`..${sep}`)) {
      throw new Error(`File must be inside the repository: ${file}`)
    }
    if (
      local.split(sep).includes('node_modules') ||
      !/\.[cm]?tsx?$/.test(absolute) ||
      !statSync(absolute).isFile()
    ) {
      throw new Error(`Expected a repository TypeScript file: ${file}`)
    }
    return absolute
  })
  const parentConfig = join(canonicalRoot, PROJECT_CONFIGS[project])
  const parsed = ts.getParsedCommandLineOfConfigFile(
    parentConfig,
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic(diagnostic) {
        throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))
      }
    }
  )
  if (parsed.errors.length > 0) {
    throw new Error(
      parsed.errors
        .map((error) => ts.flattenDiagnosticMessageText(error.messageText, '\n'))
        .join('\n')
    )
  }
  const ambient = parsed.fileNames.filter(
    (file) =>
      /\.d\.[cm]?ts$/.test(file) ||
      relative(canonicalRoot, file).split(sep).slice(0, 2).join('/') === 'src/types'
  )
  const roots = [...new Set([...selected, ...ambient])]
  const cache = join(canonicalRoot, 'node_modules', '.cache', 'typechecks')
  mkdirSync(cache, { recursive: true })
  const directory = mkdtempSync(join(cache, 'files-'))
  const config = join(directory, 'tsconfig.json')
  writeFileSync(
    config,
    JSON.stringify(
      {
        extends: parentConfig,
        compilerOptions: { composite: false, incremental: false, noEmit: true },
        files: roots,
        include: [],
        exclude: []
      },
      null,
      2
    )
  )
  return {
    config: relative(canonicalRoot, config),
    files: roots,
    dispose() {
      rmSync(directory, { recursive: true, force: true })
    }
  }
}

/**
 * 지정한 파일과 import로 연결된 의존성을 검사해요.
 * @param options - 검사 대상과 실행 설정이에요.
 * - `root`: 저장소의 절대 경로예요. 생략하면 이 스크립트의 저장소를 사용해요.
 * - `project`: 실행 환경을 선택하는 `node`, `web`, `cli` 중 하나예요.
 * - `files`: 검사할 TypeScript 파일 경로예요.
 * - `run`: 검사 실행 함수예요. 생략하면 공통 실행기로 순차 검사해요.
 * @returns 컴파일러가 보고한 실패 목록이에요.
 */
export async function runFileTypecheck({
  root = repoRoot,
  project,
  files,
  run = runTypecheckProjects
}) {
  const prepared = prepareFileTypecheck({ root, project, files })
  try {
    console.log(
      `Typecheck ${project}: ${files.length} selected file(s), ${prepared.files.length} roots including ambient declarations; imported dependencies are included.`
    )
    return await run({ root, projects: [{ config: prepared.config, heapGib: 1 }] })
  } finally {
    prepared.dispose()
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const failures = await runFileTypecheck(parseFileTypecheckOptions(process.argv.slice(2)))
  for (const failure of failures) {
    console.error(failure.message ?? failure)
  }
  process.exitCode = failures.length > 0 ? 1 : 0
}
