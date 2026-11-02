import { runProcess } from '@orca/process-host'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'

const roots = []
const runnerUrl = new URL('./run-typecheck-projects-in-parallel.mjs', import.meta.url).href

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'orca-typecheck-lock-')))
  roots.push(root)
  const compiler = join(root, 'node_modules', 'typescript')
  mkdirSync(compiler, { recursive: true })
  mkdirSync(join(root, 'config'))
  writeFileSync(
    join(compiler, 'package.json'),
    JSON.stringify({ version: '7.0.2', bin: 'compiler.cjs' })
  )
  writeFileSync(
    join(compiler, 'compiler.cjs'),
    `
    const { appendFileSync } = require('node:fs')
    const config = process.argv.at(-1)
    appendFileSync('events.txt', 'start ' + config + '\\n')
    setTimeout(() => {
      appendFileSync('events.txt', 'end ' + config + '\\n')
      process.exit(config.includes('broken') ? 1 : 0)
    }, 50)
  `
  )
  writeFileSync(
    join(root, 'runner.mjs'),
    `
    import { runTypecheckProjects } from ${JSON.stringify(runnerUrl)}
    const failures = await runTypecheckProjects({ root: process.cwd(), projects: process.argv.slice(2).map(config => ({ config, heapGib: 1 })) })
    process.exitCode = failures.length ? 1 : 0
  `
  )
  return root
}

/**
 * 실제 컴파일러 대신 기록용 프로세스로 잠금과 순서를 확인해요.
 * @param root - 임시 체크아웃 루트예요.
 * @param configs - 순서대로 실행할 가짜 프로젝트 경로예요.
 */
function run(root, configs) {
  return runProcess({
    program: process.execPath,
    args: [join(root, 'runner.mjs'), ...configs],
    cwd: root,
    timeoutMs: 10_000
  })
}
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

it('keeps native projects sequential and releases the lock after compiler failure', async () => {
  const root = fixture()
  const first = await run(root, ['config/broken.json', 'config/healthy.json'])
  expect(first).toMatchObject({ code: 1, timedOut: false })
  expect(await run(root, ['config/followup.json'])).toMatchObject({ code: 0, timedOut: false })
  expect(readFileSync(join(root, 'events.txt'), 'utf8').trim().split('\n')).toEqual([
    'start config/broken.json',
    'end config/broken.json',
    'start config/healthy.json',
    'end config/healthy.json',
    'start config/followup.json',
    'end config/followup.json'
  ])
})

it('serializes separate runner processes in the same checkout', async () => {
  const root = fixture()
  const results = await Promise.all([
    run(root, ['config/first.json']),
    run(root, ['config/second.json'])
  ])
  expect(results.map(({ code }) => code)).toEqual([0, 0])
  const events = readFileSync(join(root, 'events.txt'), 'utf8').trim().split('\n')
  expect(events).toHaveLength(4)
  expect(events[0].replace('start ', '')).toBe(events[1].replace('end ', ''))
  expect(events[2].replace('start ', '')).toBe(events[3].replace('end ', ''))
})

it('reclaims a stale lock left by a stopped owner', async () => {
  const root = fixture()
  const lock = join(root, 'node_modules', '.cache', 'typechecks', 'compiler.lock')
  mkdirSync(lock, { recursive: true })
  const stale = new Date(Date.now() - 60_000)
  utimesSync(lock, stale, stale)
  expect(await run(root, ['config/recovered.json'])).toMatchObject({ code: 0, timedOut: false })
})
