import { spawnProcess } from '@orca/process-host'
import { mkdirSync, readFileSync, realpathSync } from 'node:fs'
import lockfile from 'proper-lockfile'
import { createRequire } from 'node:module'
import { availableParallelism, totalmem } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const BYTES_PER_GIB = 1024 ** 3

// 네이티브 검사는 메모리 사용이 겹치지 않도록 하나씩 실행해요.
export const TYPECHECK_PROJECTS = [
  { name: 'node', config: 'config/tsconfig.node.json', heapGib: 7 },
  { name: 'web', config: 'config/tsconfig.tc.web.json', heapGib: 6 },
  { name: 'cli', config: 'config/tsconfig.tc.cli.json', heapGib: 2 },
  { name: 'node-tests', config: 'config/tsconfig.tests.node.json', heapGib: 7 },
  { name: 'web-tests', config: 'config/tsconfig.tests.web.json', heapGib: 6 },
  { name: 'cli-tests', config: 'config/tsconfig.tests.cli.json', heapGib: 2 },
  // 패키지 테스트는 패키지에 설치된 컴파일러로 검사해요.
  { name: 'process-host', config: 'src/packages/process-host/tsconfig.test.json', heapGib: 1 }
]

const OPTIONAL_TYPECHECK_PROJECTS = [
  { name: 'e2e', config: 'config/tsconfig.e2e.json', heapGib: 7 },
  { name: 'web-base', config: 'config/tsconfig.web.json', heapGib: 6 }
]

// Bun 동시 실행에서도 운영체제와 실행기의 메모리를 남겨요.
export function admissibleHeapGib(totalBytes) {
  return Math.max(1, (totalBytes / BYTES_PER_GIB) * 0.75)
}

/**
 * Heaviest first, admitting another project only while it fits both the memory budget and
 * the core count. A project larger than the whole budget still runs, alone, so a small
 * machine makes progress rather than producing an empty batch forever.
 */
export function planTypecheckBatches(projects, { budgetGib, parallelism }) {
  const pending = [...projects].sort((left, right) => right.heapGib - left.heapGib)
  const batches = []

  while (pending.length > 0) {
    const batch = []
    let claimed = 0

    for (let index = 0; index < pending.length;) {
      const project = pending[index]
      const admit =
        batch.length === 0 || (batch.length < parallelism && claimed + project.heapGib <= budgetGib)

      if (admit) {
        batch.push(project)
        claimed += project.heapGib
        pending.splice(index, 1)
      } else {
        index += 1
      }
    }

    batches.push(batch)
  }

  return batches
}

const repoRoot = fileURLToPath(new URL('../..', import.meta.url))

export function resolveProjectCompilerInfo(config, root = repoRoot) {
  const require = createRequire(join(root, dirname(config), 'package.json'))
  const manifestPath = require.resolve('typescript/package.json')
  const { bin, version } = JSON.parse(readFileSync(manifestPath, 'utf8'))
  return { program: join(dirname(manifestPath), typeof bin === 'string' ? bin : bin.tsc), version }
}

export function resolveProjectCompiler(config, root = repoRoot) {
  return resolveProjectCompilerInfo(config, root).program
}

/**
 * 검사할 프로젝트와 컴파일러 옵션을 읽어요.
 * @param args - 명령줄에서 받은 옵션 목록이에요.
 */
export function parseTypecheckOptions(args) {
  const options = { compiler: 'native', bunConcurrency: 1, bunThreads: 4 }
  for (const argument of args) {
    if (argument === '--compiler=bun' || argument === '--compiler=native') {
      options.compiler = argument.slice('--compiler='.length)
    } else if (argument.startsWith('--project=')) {
      const selection = argument.slice('--project='.length)
      const projects = [...TYPECHECK_PROJECTS, ...OPTIONAL_TYPECHECK_PROJECTS].filter(
        ({ name }) => name === selection || (selection === 'tests' && name.endsWith('-tests'))
      )
      if (projects.length === 0 || options.projects) {
        throw new Error(`Unknown or repeated typecheck project: ${argument}`)
      }
      options.projects = projects
    } else if (argument.startsWith('--bun-concurrency=')) {
      options.bunConcurrency = Number(argument.slice('--bun-concurrency='.length))
    } else if (argument.startsWith('--bun-threads=')) {
      options.bunThreads = Number(argument.slice('--bun-threads='.length))
    } else {
      throw new Error(`Unknown typecheck option: ${argument}`)
    }
  }
  for (const value of [options.bunConcurrency, options.bunThreads]) {
    if (!Number.isInteger(value) || value < 1 || value > 4) {
      throw new Error('Bun concurrency and threads must be integers from 1 to 4')
    }
  }
  return options
}

/**
 * 네이티브 검사는 순차 실행하고 Bun은 지정한 동시 실행 범위를 적용해요.
 * @param projects - config 경로와 예상 heapGib를 가진 프로젝트 목록이에요.
 * @param options - compiler, bunConcurrency, memoryBytes, parallelism으로 실행 범위를 정해요.
 */
export function typecheckBatches(projects, { compiler, bunConcurrency, memoryBytes, parallelism }) {
  if (compiler !== 'bun') {
    return projects.map((project) => [project])
  }
  return planTypecheckBatches(
    compiler === 'bun' ? projects.map((project) => ({ ...project, heapGib: 4 })) : projects,
    {
      budgetGib: admissibleHeapGib(memoryBytes),
      parallelism: compiler === 'bun' ? Math.min(parallelism, bunConcurrency) : parallelism
    }
  )
}

function checkProject(config, { compiler, bunThreads, root, spawnCompiler }) {
  return new Promise((resolve, reject) => {
    const installedCompiler = resolveProjectCompilerInfo(config, root)
    // Bun 1.4.3 targets TypeScript 7.0.2; compiler upgrades require a new parity comparison.
    if (compiler === 'bun' && installedCompiler.version !== '7.0.2') {
      throw new Error(
        `Bun CI compiler targets TypeScript 7.0.2, but ${config} resolves ${installedCompiler.version}`
      )
    }
    const child = spawnCompiler({
      program: compiler === 'bun' ? 'bun' : process.execPath,
      args:
        compiler === 'bun'
          ? ['check', '-p', config, '--threads', String(bunThreads), '--no-pretty', '--all']
          : [installedCompiler.program, '--noEmit', '-p', config],
      cwd: root,
      stdio: 'inherit'
    })
    child.on('error', reject)
    child.on('close', (code, signal) => {
      if (signal) {
        reject(new Error(`${compiler} ${config} exited with signal ${signal}`))
      } else if (code !== 0) {
        reject(new Error(`${compiler} ${config} exited with code ${code}`))
      } else {
        resolve()
      }
    })
  })
}

/**
 * 체크아웃 잠금을 유지하며 프로젝트를 검사하고 실패를 모아요.
 * @param options - compiler는 native가 기본이고 bunConcurrency는 1, bunThreads는 4예요. root는 저장소 루트, projects는 검사 목록, spawnCompiler는 프로세스 실행기예요. memoryBytes와 parallelism은 Bun 실행 범위를 제한해요.
 */
export async function runTypecheckProjects({
  compiler = 'native',
  bunConcurrency = 1,
  bunThreads = 4,
  root = repoRoot,
  projects = TYPECHECK_PROJECTS,
  spawnCompiler = spawnProcess,
  memoryBytes = totalmem(),
  parallelism = availableParallelism()
} = {}) {
  root = realpathSync(root)
  const lockfilePath = join(root, 'node_modules', '.cache', 'typechecks', 'compiler.lock')
  mkdirSync(dirname(lockfilePath), { recursive: true })
  const children = new Set()
  let compromised
  const release = await lockfile.lock(root, {
    lockfilePath,
    stale: 30_000,
    retries: { forever: true, minTimeout: 100, maxTimeout: 1000 },
    onCompromised(error) {
      compromised = error
      for (const child of children) {
        child.kill()
      }
    }
  })
  /**
   * 잠금이 유지되는 동안에만 검사 프로세스를 시작해요.
   * @param spec - 실행할 프로그램, 인자, 작업 디렉터리와 표준 입출력 설정이에요.
   */
  const launchCompiler = (spec) => {
    if (compromised) {
      throw compromised
    }
    const child = spawnCompiler(spec)
    children.add(child)
    child.once('close', () => children.delete(child))
    child.once('error', () => children.delete(child))
    return child
  }
  try {
    const batches = typecheckBatches(projects, {
      compiler,
      bunConcurrency,
      memoryBytes,
      parallelism
    })
    if (compiler === 'bun') {
      // Bun은 같은 메모리를 예약해 빈 실행 슬롯부터 다음 검사를 시작해요.
      const pending = batches.flat()
      const failures = []
      let next = 0
      await Promise.all(
        Array.from({ length: Math.max(0, ...batches.map((batch) => batch.length)) }, async () => {
          while (next < pending.length) {
            const index = next++
            try {
              await checkProject(pending[index].config, {
                compiler,
                bunThreads,
                root,
                spawnCompiler: launchCompiler
              })
            } catch (reason) {
              failures.push({ index, reason })
            }
          }
        })
      )
      return failures.sort((left, right) => left.index - right.index).map(({ reason }) => reason)
    }
    // 한 프로젝트가 실패해도 나머지 프로젝트의 오류를 함께 확인해요.
    const failures = []
    for (const batch of batches) {
      const results = await Promise.allSettled(
        batch.map((project) =>
          checkProject(project.config, {
            compiler,
            bunThreads,
            root,
            spawnCompiler: launchCompiler
          })
        )
      )
      for (const result of results) {
        if (result.status === 'rejected') {
          failures.push(result.reason)
        }
      }
    }
    return failures
  } finally {
    if (!compromised) {
      await release()
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const failures = await runTypecheckProjects(parseTypecheckOptions(process.argv.slice(2)))
  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(failure.message ?? failure)
    }
    process.exit(1)
  }
}
