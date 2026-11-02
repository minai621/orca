import type * as Monaco from 'monaco-editor'
import {
  QuickInfoAdapter,
  SuggestAdapter,
  SignatureHelpAdapter,
  DefinitionAdapter,
  LibFiles
} from 'monaco-editor/esm/vs/language/typescript/languageFeatures.js'
import {
  getTypeScriptModelRegistration,
  retainTypeScriptDefinitionModel,
  queryTypeScriptModel,
  type TypeScriptModel,
  type Owner
} from './typescript-model-owner'
import { detectLanguage } from './language-detect'
import {
  toTypeScriptHover,
  toTypeScriptCompletions,
  toTypeScriptSignature,
  toTypeScriptDefinitions
} from './typescript-language-results'

/**
 * 기본 분석기의 응답도 요청 당시 모델에만 표시해요.
 * @param model - 응답을 받을 편집 모델이에요.
 * @param token - 편집기가 전달한 취소 토큰이에요.
 * @param provide - 기존 Monaco 분석 기능을 호출하는 함수예요.
 */
async function currentFallback<T>(
  model: TypeScriptModel,
  token: Monaco.CancellationToken,
  provide: () => T | PromiseLike<T>
): Promise<T | undefined> {
  if (token.isCancellationRequested || model.isDisposed()) {
    return undefined
  }
  const version = model.getVersionId()
  const entry = getTypeScriptModelRegistration(model)
  const result = await provide()
  return token.isCancellationRequested ||
    model.isDisposed() ||
    model.getVersionId() !== version ||
    getTypeScriptModelRegistration(model) !== entry
    ? undefined
    : result
}

/**
 * 프로젝트 서버와 Monaco 기본 분석기를 하나의 공급자로 연결해요.
 * @param monaco - 현재 편집기의 Monaco API예요.
 * @param openDefinition - 다른 파일 정의를 기존 탭에서 열어요.
 */
export function installTypeScriptLanguageFeatures(
  monaco: typeof Monaco,
  openDefinition: (owner: Owner, path: string, line: number, column: number) => void
): Monaco.IDisposable {
  const disposables: Monaco.IDisposable[] = []
  for (const language of ['typescript', 'javascript'] as const) {
    const defaults =
      language === 'typescript'
        ? monaco.typescript.typescriptDefaults
        : monaco.typescript.javascriptDefaults
    const previousConfiguration = defaults.modeConfiguration
    disposables.push({ dispose: () => defaults.setModeConfiguration(previousConfiguration) })
    defaults.setModeConfiguration({
      ...defaults.modeConfiguration,
      hovers: false,
      completionItems: false,
      signatureHelp: false,
      definitions: false
    })
    const worker = async (...uris: Monaco.Uri[]): Promise<Monaco.typescript.TypeScriptWorker> => {
      const accessor = await (language === 'typescript'
        ? monaco.typescript.getTypeScriptWorker()
        : monaco.typescript.getJavaScriptWorker())
      return accessor(...uris)
    }
    const hover = new QuickInfoAdapter(worker)
    const suggest = new SuggestAdapter(worker)
    const nativeCompletions = new WeakSet<Monaco.languages.CompletionItem>()
    const signature = new SignatureHelpAdapter(worker)
    const definition = new DefinitionAdapter(new LibFiles(worker), worker)
    disposables.push(
      monaco.languages.registerHoverProvider(language, {
        async provideHover(model, position, token) {
          const response = await queryTypeScriptModel(model, position, token, 'hover')
          if (response === 'stale') {
            return undefined
          }
          return response.available
            ? toTypeScriptHover(response.result)
            : currentFallback(model, token, () => hover.provideHover(model, position, token))
        }
      }),
      monaco.languages.registerCompletionItemProvider(language, {
        triggerCharacters: ['.', '"', "'", '/', '@', '<'],
        async provideCompletionItems(model, position, context, token) {
          const response = await queryTypeScriptModel(model, position, token, 'completion')
          if (response === 'stale') {
            return undefined
          }
          const word = model.getWordUntilPosition(position)
          if (!response.available) {
            return currentFallback(model, token, () =>
              suggest.provideCompletionItems(model, position, context, token)
            )
          }
          const result = toTypeScriptCompletions(response.result, monaco, {
            startLineNumber: position.lineNumber,
            endLineNumber: position.lineNumber,
            startColumn: word.startColumn,
            endColumn: word.endColumn
          })
          result?.suggestions.forEach((item) => nativeCompletions.add(item))
          return result
        },
        resolveCompletionItem(item, token) {
          return nativeCompletions.has(item) ? item : suggest.resolveCompletionItem(item, token)
        }
      }),
      monaco.languages.registerSignatureHelpProvider(language, {
        signatureHelpTriggerCharacters: ['(', ','],
        signatureHelpRetriggerCharacters: [')'],
        async provideSignatureHelp(model, position, token, context) {
          const response = await queryTypeScriptModel(model, position, token, 'signatureHelp')
          if (response === 'stale') {
            return undefined
          }
          return response.available
            ? toTypeScriptSignature(response.result)
            : currentFallback(model, token, () =>
                signature.provideSignatureHelp(model, position, token, context)
              )
        }
      }),
      monaco.languages.registerDefinitionProvider(language, {
        async provideDefinition(model, position, token) {
          const response = await queryTypeScriptModel(model, position, token, 'definition')
          if (response === 'stale') {
            return undefined
          }
          if (!response.available) {
            return currentFallback(model, token, () =>
              definition.provideDefinition(model, position, token)
            )
          }
          const result = toTypeScriptDefinitions(response.result, monaco)
          const version = model.getVersionId()
          const entry = getTypeScriptModelRegistration(model)
          await Promise.all(
            (result ?? []).map(async (location) => {
              if (monaco.editor.getModel(location.uri)) {
                return
              }
              try {
                const file = await window.api.fs.readFile({ filePath: location.uri.fsPath })
                if (
                  file.isBinary ||
                  token.isCancellationRequested ||
                  model.isDisposed() ||
                  model.getVersionId() !== version ||
                  getTypeScriptModelRegistration(model) !== entry
                ) {
                  return
                }
                if (!monaco.editor.getModel(location.uri)) {
                  const target = monaco.editor.createModel(
                    file.content,
                    detectLanguage(location.uri.fsPath),
                    location.uri
                  )
                  retainTypeScriptDefinitionModel(model, target)
                }
              } catch {
                // 파일을 읽지 못해도 정의 위치로 이동할 수 있어요.
              }
            })
          )
          return token.isCancellationRequested ||
            model.isDisposed() ||
            model.getVersionId() !== version ||
            getTypeScriptModelRegistration(model) !== entry
            ? undefined
            : result
        }
      })
    )
  }
  disposables.push(
    monaco.editor.registerEditorOpener({
      openCodeEditor(source, resource, selection) {
        const model = source.getModel()
        const owner = model && getTypeScriptModelRegistration(model)?.owner
        if (!owner || resource.scheme !== 'file' || resource.authority || resource.fragment) {
          return false
        }
        const line =
          selection &&
          ('startLineNumber' in selection ? selection.startLineNumber : selection.lineNumber)
        const column =
          selection && ('startColumn' in selection ? selection.startColumn : selection.column)
        openDefinition(owner, resource.fsPath, line ?? 1, column ?? 1)
        return true
      }
    })
  )
  return { dispose: () => disposables.toReversed().forEach((item) => item.dispose()) }
}
