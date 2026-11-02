import type * as Monaco from 'monaco-editor'
import type {
  TypeScriptQuery,
  TypeScriptQueryResult
} from '../../../shared/typescript-language-service'

export type TypeScriptModel = Pick<
  Monaco.editor.ITextModel,
  'uri' | 'getVersionId' | 'getValue' | 'isDisposed'
>

type ModelLifetime = {
  onDidChangeContent(listener: () => void): Monaco.IDisposable
  onWillDispose(listener: () => void): Monaco.IDisposable
}

export type Owner = { rootPath: string; filePath: string; worktreeId: string }
const definitionModels = new Map<TypeScriptModel, Set<Monaco.editor.ITextModel>>()
const owners = new Map<TypeScriptModel, { owner: Owner; count: number }>()

/**
 * 로컬 파일 모델이 폐기될 때까지 저장하지 않은 내용도 분석 서버에 유지해요.
 * @param model - 편집 중인 실제 파일 모델이에요.
 * @param owner - 로컬 파일의 소유 정보예요.
 * - `rootPath`: 분석할 프로젝트의 절대 경로예요.
 * - `filePath`: 모델 URI의 소유자 조각을 제외한 실제 파일 경로예요.
 * - `worktreeId`: 정의 위치를 열 워크스페이스 식별자예요.
 * @returns 화면 참조만 해제하고 모델의 분석 수명은 유지하는 함수예요.
 */
export function registerTypeScriptModelOwner(
  model: TypeScriptModel & ModelLifetime,
  owner: Owner
): () => void {
  if (
    model.uri.scheme !== 'file' ||
    model.uri.authority ||
    model.uri.fragment ||
    model.isDisposed()
  ) {
    return () => {}
  }
  const existing = owners.get(model)
  const entry = existing ?? { owner, count: 0 }
  entry.count += 1
  owners.set(model, entry)
  if (!existing) {
    const sync = (): void => {
      void window.api?.fs
        .queryTypeScript?.({
          rootPath: owner.rootPath,
          filePath: owner.filePath,
          content: model.getValue(),
          version: model.getVersionId(),
          method: 'sync',
          position: { line: 0, character: 0 }
        })
        .catch(() => {})
    }
    const change = model.onDidChangeContent(sync)
    const disposal = model.onWillDispose(() => {
      owners.delete(model)
      change.dispose()
      disposal.dispose()
      for (const target of definitionModels.get(model) ?? []) {
        if (!target.isDisposed() && !target.isAttachedToEditor()) {
          target.dispose()
        }
      }
      definitionModels.delete(model)
      void window.api?.fs
        .queryTypeScript?.({
          rootPath: owner.rootPath,
          filePath: owner.filePath,
          content: '',
          version: model.getVersionId(),
          method: 'close',
          position: { line: 0, character: 0 }
        })
        .catch(() => {})
    })
    sync()
  }
  let active = true
  return () => {
    if (!active) {
      return
    }
    active = false
    entry.count -= 1
  }
}

/**
 * 취소되거나 내용과 소유자가 바뀐 응답은 버려요.
 * @param model - 요청할 편집 모델이에요.
 * @param position - Monaco의 커서 위치예요.
 * @param token - 편집기가 전달한 취소 토큰이에요.
 * @param method - 요청할 언어 기능이에요.
 */
export async function queryTypeScriptModel(
  model: TypeScriptModel,
  position: Monaco.IPosition,
  token: Monaco.CancellationToken,
  method: TypeScriptQuery['method']
): Promise<TypeScriptQueryResult | 'stale'> {
  const entry = owners.get(model)
  const query = window.api?.fs.queryTypeScript
  if (
    !entry ||
    model.uri.scheme !== 'file' ||
    model.uri.authority ||
    model.uri.fragment ||
    !query
  ) {
    return { available: false }
  }
  if (token.isCancellationRequested || model.isDisposed()) {
    return 'stale'
  }
  const version = model.getVersionId()
  let result: TypeScriptQueryResult
  try {
    result = await query({
      rootPath: entry.owner.rootPath,
      filePath: entry.owner.filePath,
      content: model.getValue(),
      version,
      method,
      position: { line: position.lineNumber - 1, character: position.column - 1 }
    })
  } catch {
    result = { available: false }
  }
  return token.isCancellationRequested ||
    model.isDisposed() ||
    model.getVersionId() !== version ||
    owners.get(model) !== entry
    ? 'stale'
    : result
}

/**
 * 모델의 현재 분석 소유권을 확인해요.
 * @param model - 소유권을 확인할 모델이에요.
 */
export function getTypeScriptModelRegistration(model: TypeScriptModel) {
  return owners.get(model)
}

/**
 * 정의 미리보기 모델을 원본 모델 수명에 연결해요.
 * @param model - 정의를 요청한 모델이에요.
 * @param target - 새로 만든 정의 미리보기 모델이에요.
 */
export function retainTypeScriptDefinitionModel(
  model: TypeScriptModel,
  target: Monaco.editor.ITextModel
): void {
  const targets = definitionModels.get(model) ?? new Set<Monaco.editor.ITextModel>()
  targets.add(target)
  definitionModels.set(model, targets)
}
