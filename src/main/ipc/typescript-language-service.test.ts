import { EventEmitter } from 'node:events'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { typeScriptQuerySchema } from '../../shared/typescript-language-service'

const mocks = vi.hoisted(() => ({
  handle: vi.fn(),
  query: vi.fn(),
  dispose: vi.fn(),
  authorize: vi.fn(),
  construct: vi.fn()
}))

vi.mock('electron', () => ({ ipcMain: { handle: mocks.handle } }))
vi.mock('./local-file-access-resolution', () => ({
  resolveDesktopAuthorizedPath: mocks.authorize
}))
vi.mock('../typescript-language-service/server', () => ({
  TypeScriptLanguageService: class {
    constructor() {
      mocks.construct()
    }
    query = mocks.query
    dispose = mocks.dispose
  }
}))

import {
  disposeTypeScriptLanguageServices,
  registerTypeScriptLanguageHandlers
} from './typescript-language-service'

const input = {
  rootPath: '/workspace',
  filePath: '/workspace/src/main.ts',
  content: 'const value = 1',
  version: 1,
  method: 'hover',
  position: { line: 0, character: 6 }
}

/**
 * 창의 수명 종료를 재현할 발신자를 만들어요.
 * @param id - 다른 창과 구분할 식별자예요.
 */
function sender(id = 1) {
  return Object.assign(new EventEmitter(), { id, isDestroyed: () => false })
}

function handler() {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: 권한 검사 mock이 저장소를 사용하지 않는 테스트예요.
  registerTypeScriptLanguageHandlers({} as never)
  return mocks.handle.mock.calls[0][1]
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.authorize.mockImplementation(async (path: string) => path)
  mocks.query.mockResolvedValue({
    available: true,
    result: { contents: 'number' },
    version: '7.0.2'
  })
})

afterEach(disposeTypeScriptLanguageServices)

it('authorizes root and file before querying and reuses only the requesting sender session', async () => {
  const query = handler()
  const first = sender()
  await query({ sender: first }, input)
  await query({ sender: first }, input)
  await query({ sender: sender(2) }, input)
  expect(mocks.authorize.mock.calls.slice(0, 2).map(([path]) => path)).toEqual([
    '/workspace',
    '/workspace/src/main.ts'
  ])
  expect(mocks.construct).toHaveBeenCalledTimes(2)
  expect(mocks.query).toHaveBeenCalledWith(input)
  first.emit('destroyed')
  expect(mocks.dispose).toHaveBeenCalledOnce()
})

it('rejects authorization failures and canonical paths outside the requested root before spawning', async () => {
  const query = handler()
  mocks.authorize.mockRejectedValueOnce(new Error('Access denied'))
  await expect(query({ sender: sender() }, input)).rejects.toThrow('Access denied')
  mocks.authorize.mockImplementation(async (path: string) =>
    path === input.filePath ? '/elsewhere/main.ts' : path
  )
  await expect(query({ sender: sender() }, input)).rejects.toThrow('outside')
  expect(mocks.construct).not.toHaveBeenCalled()
})

it('does not start a server for closed documents or destroyed senders', async () => {
  const query = handler()
  await query({ sender: sender() }, { ...input, method: 'close' })
  await query({ sender: { ...sender(), isDestroyed: () => true } }, input)
  expect(mocks.construct).not.toHaveBeenCalled()
})

it('rejects malformed positions, methods, and paths before filesystem access', async () => {
  const query = handler()
  for (const invalid of [
    { ...input, method: 'executeCommand' },
    { ...input, position: { line: -1, character: 0 } },
    { ...input, version: 0.5 },
    { ...input, rootPath: 'relative' }
  ]) {
    await expect(query({ sender: sender() }, invalid)).rejects.toThrow()
  }
  expect(mocks.authorize).not.toHaveBeenCalled()
  expect(typeScriptQuerySchema.safeParse(input).success).toBe(true)
})
