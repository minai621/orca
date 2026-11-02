import { ipcMain } from 'electron'
import { isAbsolute } from 'node:path'
import type { Store } from '../persistence'
import { typeScriptQuerySchema } from '../../shared/typescript-language-service'
import type { TypeScriptQueryResult } from '../../shared/typescript-language-service'
import { TypeScriptLanguageService } from '../typescript-language-service/server'
import { resolveDesktopAuthorizedPath } from './local-file-access-resolution'
import { isDescendantOrEqual } from './filesystem-path-containment'

const services = new Map<number, TypeScriptLanguageService>()

/** 모든 창의 TypeScript 서버를 종료하고 종료 이벤트 구독을 정리해요. */
export function disposeTypeScriptLanguageServices(): void {
  for (const service of services.values()) {
    service.dispose()
  }
  services.clear()
  process.removeListener('exit', disposeTypeScriptLanguageServices)
}

/**
 * 등록된 로컬 프로젝트의 TypeScript 언어 서비스 요청을 처리해요.
 *
 * @param store - 접근을 허용한 저장소와 폴더 워크스페이스를 조회할 저장소예요.
 */
export function registerTypeScriptLanguageHandlers(store: Store): void {
  ipcMain.handle(
    'fs:queryTypeScript',
    async (event, input: unknown): Promise<TypeScriptQueryResult> => {
      const args = typeScriptQuerySchema.parse(input)
      if (!isAbsolute(args.rootPath) || !isAbsolute(args.filePath)) {
        throw new Error('TypeScript requests require absolute project and file paths')
      }
      const rootPath = await resolveDesktopAuthorizedPath(args.rootPath, store)
      const filePath = await resolveDesktopAuthorizedPath(args.filePath, store)
      if (!isDescendantOrEqual(filePath, rootPath)) {
        throw new Error('TypeScript file is outside the requested project')
      }
      if (event.sender.isDestroyed()) {
        return { available: false }
      }
      let service = services.get(event.sender.id)
      if (!service) {
        if (args.method === 'close') {
          return { available: false }
        }
        service = new TypeScriptLanguageService()
        if (services.size === 0) {
          process.once('exit', disposeTypeScriptLanguageServices)
        }
        services.set(event.sender.id, service)
        event.sender.once('destroyed', () => {
          services.get(event.sender.id)?.dispose()
          services.delete(event.sender.id)
          if (services.size === 0) {
            process.removeListener('exit', disposeTypeScriptLanguageServices)
          }
        })
      }
      return service.query({ ...args, rootPath, filePath })
    }
  )
}
