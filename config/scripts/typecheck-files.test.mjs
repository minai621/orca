import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createRequire } from 'node:module'
import { afterEach, expect, it } from 'vitest'
import {
  parseFileTypecheckOptions,
  prepareFileTypecheck,
  runFileTypecheck
} from './typecheck-files.mjs'

const directories = []
const require = createRequire(import.meta.url)

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'orca-typecheck-files-')))
  directories.push(root)
  mkdirSync(join(root, 'config'))
  mkdirSync(join(root, 'src', 'types'), { recursive: true })
  mkdirSync(join(root, 'node_modules'))
  symlinkSync(
    dirname(require.resolve('typescript/package.json')),
    join(root, 'node_modules', 'typescript'),
    'junction'
  )
  for (const name of ['node', 'tc.web', 'tc.cli']) {
    writeFileSync(
      join(root, 'config', `tsconfig.${name}.json`),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          target: 'ESNext',
          module: 'ESNext',
          moduleResolution: 'bundler',
          types: [],
          composite: true
        },
        include: ['../src/**/*']
      })
    )
  }
  writeFileSync(join(root, 'src', 'types', 'global.d.ts'), 'declare const buildName: string')
  writeFileSync(join(root, 'src', 'selected file.ts'), 'export const value: string = buildName')
  writeFileSync(join(root, 'src', 'unrelated.test.ts'), 'export const broken: number = "unrelated"')
  return root
}

afterEach(() => {
  for (const root of directories.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

it('requires an explicit execution environment and file list', () => {
  expect(parseFileTypecheckOptions(['--project=web', 'src/example.tsx'])).toEqual({
    project: 'web',
    files: ['src/example.tsx']
  })
  for (const args of [
    [],
    ['--project=node'],
    ['file.ts'],
    ['--project=nope', 'file.ts'],
    ['--project=node', '--project=web', 'file.ts'],
    ['--project=node', '--all']
  ]) {
    expect(() => parseFileTypecheckOptions(args)).toThrow()
  }
})

it('keeps only explicit roots and ambient declarations, with imports still enabled', () => {
  const root = fixture()
  const prepared = prepareFileTypecheck({
    root,
    project: 'node',
    files: ['src/selected file.ts', 'src/selected file.ts']
  })
  try {
    const config = JSON.parse(readFileSync(join(root, prepared.config), 'utf8'))
    expect(config.files).toEqual([
      join(root, 'src', 'selected file.ts'),
      join(root, 'src', 'types', 'global.d.ts')
    ])
    expect(config.include).toEqual([])
    expect(config.compilerOptions).toMatchObject({
      composite: false,
      incremental: false,
      noEmit: true
    })
    expect(config.compilerOptions.noResolve).toBeUndefined()
  } finally {
    prepared.dispose()
  }
  expect(existsSync(join(root, prepared.config))).toBe(false)
})

it('rejects missing files, dependencies, directories and paths outside the checkout', () => {
  const root = fixture()
  const outside = join(dirname(root), 'outside.ts')
  writeFileSync(outside, 'export {}')
  try {
    for (const file of [
      'src/missing.ts',
      'src',
      'config/tsconfig.node.json',
      outside,
      'node_modules/typescript/lib/lib.d.ts'
    ]) {
      expect(() => prepareFileTypecheck({ root, project: 'node', files: [file] })).toThrow()
    }
  } finally {
    rmSync(outside, { force: true })
  }
})

it('removes the temporary config even if the compiler runner throws', async () => {
  const root = fixture()
  let config
  await expect(
    runFileTypecheck({
      root,
      project: 'web',
      files: ['src/selected file.ts'],
      run: async (options) => {
        config = join(root, options.projects[0].config)
        expect(existsSync(config)).toBe(true)
        throw new Error('compiler failed')
      }
    })
  ).rejects.toThrow('compiler failed')
  expect(existsSync(config)).toBe(false)
})

it('uses the native compiler to ignore unrelated errors and detect imported errors', async () => {
  const root = fixture()
  const options = { root, project: 'node', files: ['src/selected file.ts'] }
  expect(await runFileTypecheck(options)).toEqual([])
  writeFileSync(join(root, 'src', 'dependency.ts'), 'export const dependency: number = "invalid"')
  writeFileSync(join(root, 'src', 'selected file.ts'), 'export { dependency } from "./dependency"')
  const failures = await runFileTypecheck(options)
  expect(failures).toHaveLength(1)
  expect(failures[0].message).toContain('exited with code')
})
