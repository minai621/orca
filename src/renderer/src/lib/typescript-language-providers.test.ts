// @vitest-environment happy-dom
import { registerTypeScriptModelOwner } from './typescript-model-owner'
import * as monaco from 'monaco-editor'
import { afterEach, expect, it, vi } from 'vitest'
import { installTypeScriptLanguageFeatures } from './typescript-language-features'

const adapters = vi.hoisted(() => ({
  hover: vi.fn(),
  completion: vi.fn(),
  signature: vi.fn(),
  definition: vi.fn()
}))
vi.mock('monaco-editor/esm/vs/language/typescript/languageFeatures.js', () => ({
  QuickInfoAdapter: class {
    provideHover = adapters.hover
  },
  SuggestAdapter: class {
    provideCompletionItems = adapters.completion
    resolveCompletionItem = vi.fn()
  },
  SignatureHelpAdapter: class {
    provideSignatureHelp = adapters.signature
  },
  DefinitionAdapter: class {
    provideDefinition = adapters.definition
  },
  LibFiles: class {}
}))

afterEach(() => {
  vi.restoreAllMocks()
  vi.clearAllMocks()
  monaco.editor.getModels().forEach((model) => model.dispose())
})

it('replaces built-in hover once, serves native inference and falls back when unavailable', async () => {
  const hovers: monaco.languages.HoverProvider[] = []
  vi.spyOn(monaco.languages, 'registerHoverProvider').mockImplementation((_language, provider) => {
    hovers.push(provider)
    return { dispose: vi.fn() }
  })
  const before = monaco.typescript.typescriptDefaults.modeConfiguration
  const installation = installTypeScriptLanguageFeatures(monaco, vi.fn())
  expect(monaco.typescript.typescriptDefaults.modeConfiguration.hovers).toBe(false)
  expect(hovers).toHaveLength(2)
  const queryTypeScript = vi.fn().mockResolvedValue({
    available: true,
    result: { contents: { kind: 'markdown', value: 'const command: Command' } },
    version: '7.0.2'
  })
  Object.defineProperty(window, 'api', { value: { fs: { queryTypeScript } }, configurable: true })
  const model = monaco.editor.createModel(
    'command',
    'plaintext',
    monaco.Uri.file('/repo/provider.ts')
  )
  const release = registerTypeScriptModelOwner(model, {
    rootPath: '/repo',
    filePath: '/repo/provider.ts',
    worktreeId: 'repo'
  })
  const token = { isCancellationRequested: false, onCancellationRequested: vi.fn() }
  const result = await hovers[0].provideHover(model, new monaco.Position(1, 2), token)
  expect(result?.contents).toEqual([{ value: 'const command: Command' }])
  expect(adapters.hover).not.toHaveBeenCalled()
  queryTypeScript.mockResolvedValue({ available: false })
  adapters.hover.mockResolvedValue({ contents: [{ value: 'fallback' }] })
  expect(await hovers[0].provideHover(model, new monaco.Position(1, 2), token)).toEqual({
    contents: [{ value: 'fallback' }]
  })
  expect(adapters.hover).toHaveBeenCalledTimes(1)
  let finish: (value: monaco.languages.Hover) => void = () => {}
  adapters.hover.mockImplementation(
    () =>
      new Promise((resolve) => {
        finish = resolve
      })
  )
  const pending = hovers[0].provideHover(model, new monaco.Position(1, 2), token)
  await vi.waitFor(() => expect(adapters.hover).toHaveBeenCalledTimes(2))
  model.setValue('changed')
  finish({ contents: [{ value: 'stale fallback' }] })
  expect(await pending).toBeUndefined()
  release()
  model.dispose()
  installation.dispose()
  expect(monaco.typescript.typescriptDefaults.modeConfiguration).toEqual(before)
})
