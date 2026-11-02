// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { languages } from 'monaco-editor/esm/vs/editor/editor.api.js'
import { URI } from 'monaco-editor/esm/vs/base/common/uri.js'
import { queryTypeScriptModel, registerTypeScriptModelOwner } from './typescript-model-owner'
import {
  toTypeScriptCompletions,
  toTypeScriptDefinitions,
  toTypeScriptHover,
  toTypeScriptSignature
} from './typescript-language-results'

vi.mock('monaco-editor/esm/vs/language/typescript/languageFeatures.js', () => ({
  QuickInfoAdapter: class {},
  SuggestAdapter: class {},
  SignatureHelpAdapter: class {},
  DefinitionAdapter: class {},
  LibFiles: class {}
}))
const position = {
  lineNumber: 1,
  column: 4,
  with: vi.fn(),
  delta: vi.fn(),
  equals: vi.fn(),
  isBefore: vi.fn(),
  isBeforeOrEqual: vi.fn(),
  clone: vi.fn(),
  toString: vi.fn(),
  toJSON: vi.fn()
}
const token = { isCancellationRequested: false, onCancellationRequested: vi.fn() }
const modelDisposals: (() => void)[] = []
const owner = { rootPath: '/repo', filePath: '/repo/a.ts', worktreeId: 'repo' }

/**
 * 모델 수명과 내용 변경을 제어할 테스트 모델을 만들어요.
 * @param fragment - 원격 소유자 또는 임베디드 모델의 URI 조각이에요.
 */
function fixture(fragment = '') {
  let version = 1
  let disposed = false
  let content = 'unsaved text'
  const changes = new Set<() => void>()
  const disposals = new Set<() => void>()
  const model = {
    uri: URI.file('/repo/a.ts').with({ fragment }),
    getVersionId: () => version,
    getValue: () => content,
    isDisposed: () => disposed,
    onDidChangeContent: (listener: () => void) => {
      changes.add(listener)
      return {
        dispose: () => {
          changes.delete(listener)
        }
      }
    },
    onWillDispose: (listener: () => void) => {
      disposals.add(listener)
      return {
        dispose: () => {
          disposals.delete(listener)
        }
      }
    }
  }
  modelDisposals.push(() => {
    disposals.forEach((listener) => listener())
    disposed = true
  })
  return {
    model,
    change: (value = content) => {
      version += 1
      content = value
      changes.forEach((listener) => listener())
    },
    disposeModel: () => {
      disposals.forEach((listener) => listener())
      disposed = true
    }
  }
}

afterEach(() => {
  modelDisposals.splice(0).forEach((dispose) => dispose())
  vi.unstubAllGlobals()
  token.isCancellationRequested = false
})

describe('project TypeScript queries', () => {
  it('sends unsaved content and filesystem path without an owner fragment', async () => {
    const queryTypeScript = vi
      .fn()
      .mockResolvedValue({ available: false })
      .mockResolvedValue({
        available: true,
        result: {
          contents: { kind: 'markdown', value: '```typescript\nconst command: Command\n```' }
        },
        version: '1'
      })
    Object.defineProperty(window, 'api', { value: { fs: { queryTypeScript } }, configurable: true })
    const { model } = fixture()
    const dispose = registerTypeScriptModelOwner(model, owner)
    const response = await queryTypeScriptModel(model, position, token, 'hover')
    expect(queryTypeScript).toHaveBeenCalledWith(
      expect.objectContaining({
        filePath: '/repo/a.ts',
        content: 'unsaved text',
        version: 1,
        position: { line: 0, character: 3 }
      })
    )
    expect(response).toMatchObject({ available: true })
    dispose()
  })
  it('keeps remote, embedded and unmounted models out of local IPC', async () => {
    const queryTypeScript = vi.fn().mockResolvedValue({ available: false })
    Object.defineProperty(window, 'api', { value: { fs: { queryTypeScript } }, configurable: true })
    const remote = fixture('[null,"ssh:remote"]')
    const dispose = registerTypeScriptModelOwner(remote.model, owner)
    expect(await queryTypeScriptModel(remote.model, position, token, 'hover')).toEqual({
      available: false
    })
    expect(await queryTypeScriptModel(fixture().model, position, token, 'hover')).toEqual({
      available: false
    })
    expect(queryTypeScript).not.toHaveBeenCalled()
    dispose()
  })
  it.each(['change', 'cancel', 'dispose'] as const)(
    'discards a pending response after %s',
    async (action) => {
      let finish: (value: unknown) => void = () => {}
      const queryTypeScript = vi.fn((args: { method: string }) =>
        args.method !== 'hover'
          ? Promise.resolve({ available: false })
          : new Promise((resolve) => {
              finish = resolve
            })
      )
      Object.defineProperty(window, 'api', {
        value: { fs: { queryTypeScript } },
        configurable: true
      })
      const { model, change, disposeModel } = fixture()
      const dispose = registerTypeScriptModelOwner(model, owner)
      const pending = queryTypeScriptModel(model, position, token, 'hover')
      if (action === 'change') {
        change()
      }
      if (action === 'cancel') {
        token.isCancellationRequested = true
      }
      if (action === 'dispose') {
        disposeModel()
      }
      finish({ available: true, result: null, version: '1' })
      expect(await pending).toBe('stale')
      if (action !== 'dispose') {
        dispose()
      }
    }
  )
  it('preserves fallback when the bridge is absent', async () => {
    Object.defineProperty(window, 'api', { value: undefined, configurable: true })
    const { model } = fixture()
    const dispose = registerTypeScriptModelOwner(model, owner)
    expect(await queryTypeScriptModel(model, position, token, 'hover')).toEqual({
      available: false
    })
    dispose()
  })
  it('shows native Command hover without sandbox any', () => {
    expect(
      toTypeScriptHover({
        contents: { kind: 'markdown', value: '```typescript\nconst command: Command\n```' }
      })
    ).toEqual({
      contents: [{ value: '```typescript\nconst command: Command\n```' }],
      range: undefined
    })
    expect(toTypeScriptHover({ contents: 42 })).toBeUndefined()
    expect(
      toTypeScriptSignature({
        signatures: [{ label: 'run(name: string)', parameters: [{ label: [4, 16] }] }],
        activeParameter: 0
      })?.value.signatures[0].parameters[0].label
    ).toEqual([4, 16])
  })
})

it('preserves completion text edits, snippets and import edits', () => {
  const editRange = { start: { line: 2, character: 3 }, end: { line: 2, character: 6 } }
  const result = toTypeScriptCompletions(
    {
      isIncomplete: true,
      items: [
        {
          label: 'run',
          kind: 3,
          insertText: 'ignored',
          insertTextFormat: 2,
          textEdit: { newText: 'run(${1:name})', insert: editRange, replace: editRange },
          additionalTextEdits: [
            {
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
              newText: 'import { run } from "./run"\n'
            }
          ]
        }
      ]
    },
    { languages },
    { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 }
  )
  expect(result?.incomplete).toBe(true)
  expect(result?.suggestions[0]).toMatchObject({
    kind: languages.CompletionItemKind.Function,
    insertText: 'run(${1:name})',
    insertTextRules: languages.CompletionItemInsertTextRule.InsertAsSnippet,
    range: {
      insert: { startLineNumber: 3, startColumn: 4, endLineNumber: 3, endColumn: 7 },
      replace: { startLineNumber: 3, startColumn: 4, endLineNumber: 3, endColumn: 7 }
    },
    additionalTextEdits: [
      {
        text: 'import { run } from "./run"\n',
        range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 }
      }
    ]
  })
})

it('validates definition URIs and locations', () => {
  expect(
    toTypeScriptDefinitions(
      [
        {
          uri: 'file:///repo/b.ts',
          range: { start: { line: 1, character: 2 }, end: { line: 1, character: 8 } }
        },
        {
          uri: 'https://remote/a.ts',
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }
        }
      ],
      { Uri: URI }
    )
  ).toEqual([
    {
      uri: URI.file('/repo/b.ts'),
      range: { startLineNumber: 2, startColumn: 3, endLineNumber: 2, endColumn: 9 }
    }
  ])
})

it('syncs unsaved imported files while their view is hidden and closes only on model disposal', () => {
  const queryTypeScript = vi
    .fn()
    .mockResolvedValue({ available: true, result: null, version: '7.0.2' })
  Object.defineProperty(window, 'api', { value: { fs: { queryTypeScript } }, configurable: true })
  const { model, change, disposeModel } = fixture()
  const release = registerTypeScriptModelOwner(model, owner)
  const secondRelease = registerTypeScriptModelOwner(model, owner)
  expect(queryTypeScript).toHaveBeenCalledTimes(1)
  release()
  secondRelease()
  change('export type Imported = "unsaved"')
  expect(queryTypeScript).toHaveBeenLastCalledWith(
    expect.objectContaining({
      method: 'sync',
      content: 'export type Imported = "unsaved"',
      version: 2
    })
  )
  expect(queryTypeScript).toHaveBeenCalledTimes(2)
  disposeModel()
  expect(queryTypeScript).toHaveBeenLastCalledWith(expect.objectContaining({ method: 'close' }))
})
