import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TypeScriptLanguageService } from './server'
import { encodeMessage, MessageReader } from './stdio'
import type { TypeScriptQuery } from '../../shared/typescript-language-service'

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), resolve: vi.fn() }))
vi.mock('@orca/process-host', () => ({ spawnProcess: mocks.spawn }))
vi.mock('./resolver', () => ({ resolveNativeTypeScript: mocks.resolve }))

class FakeChild extends EventEmitter {
  stdin = new PassThrough()
  stdout = new PassThrough()
  stderr = new PassThrough()
  kill = vi.fn()
  messages: unknown[] = []
  respond = true

  constructor() {
    super()
    const reader = new MessageReader()
    this.stdin.on('data', (chunk: Buffer) =>
      reader.push(chunk, (message) => {
        this.messages.push(message)
        if (message && typeof message === 'object' && 'id' in message && 'method' in message) {
          const { id, method } = message
          if (method === 'initialize' || this.respond) {
            queueMicrotask(() => {
              this.stdout.write(
                encodeMessage({
                  jsonrpc: '2.0',
                  id,
                  result: method === 'initialize' ? { capabilities: {} } : { contents: '형식' }
                })
              )
            })
          }
        }
      })
    )
  }
}
const query: TypeScriptQuery = {
  rootPath: process.cwd(),
  filePath: `${process.cwd()}/file.ts`,
  content: 'const x = 1',
  version: 1,
  method: 'hover',
  position: { line: 0, character: 6 }
}
let child: FakeChild
let service: TypeScriptLanguageService
beforeEach(() => {
  child = new FakeChild()
  mocks.spawn.mockReset().mockReturnValue(child)
  mocks.resolve.mockReset().mockReturnValue({ executable: '/native/tsc', version: '7.0.2' })
  service = new TypeScriptLanguageService()
})
afterEach(() => {
  service.dispose()
  vi.useRealTimers()
})

describe('native TypeScript session', () => {
  it('initializes once for concurrent requests and synchronizes document changes before queries', async () => {
    const results = await Promise.all([
      service.query(query),
      service.query({ ...query, content: 'const x = 2', version: 2 })
    ])
    expect(results[0]).toEqual({ available: true, result: { contents: '형식' }, version: '7.0.2' })
    expect(mocks.spawn).toHaveBeenCalledTimes(1)
    expect(mocks.spawn).toHaveBeenCalledWith(
      expect.objectContaining({ args: ['--lsp', '--stdio'] })
    )
    expect(child.messages).toEqual([
      expect.objectContaining({
        method: 'initialize',
        params: expect.objectContaining({
          processId: process.pid,
          capabilities: expect.any(Object),
          workspaceFolders: expect.any(Array)
        })
      }),
      expect.objectContaining({ method: 'initialized' }),
      expect.objectContaining({ method: 'textDocument/didOpen' }),
      expect.objectContaining({ method: 'textDocument/hover' }),
      expect.objectContaining({
        method: 'textDocument/didChange',
        params: expect.objectContaining({ textDocument: expect.objectContaining({ version: 2 }) })
      }),
      expect.objectContaining({ method: 'textDocument/hover' })
    ])
  })

  it.each([
    ['file.js', 'javascript'],
    ['file.jsx', 'javascriptreact'],
    ['file.mjs', 'javascript'],
    ['file.cjs', 'javascript'],
    ['file.tsx', 'typescriptreact']
  ])('opens %s with %s language mode', async (file, languageId) => {
    await service.query({ ...query, filePath: `${process.cwd()}/${file}` })
    expect(child.messages).toContainEqual(
      expect.objectContaining({
        method: 'textDocument/didOpen',
        params: expect.objectContaining({ textDocument: expect.objectContaining({ languageId }) })
      })
    )
  })

  it('synchronizes documents without sending a language request', async () => {
    await expect(service.query({ ...query, method: 'sync' })).resolves.toMatchObject({
      available: true,
      result: null
    })
    expect(child.messages).toHaveLength(3)
    expect(child.messages).toContainEqual(
      expect.objectContaining({ method: 'textDocument/didOpen' })
    )
  })

  it('does not start a server for close or unavailable installations', async () => {
    expect(await service.query({ ...query, method: 'close' })).toEqual({ available: false })
    mocks.resolve.mockReturnValue(null)
    expect(await service.query(query)).toEqual({ available: false })
    expect(mocks.spawn).not.toHaveBeenCalled()
  })

  it('closes and reopens documents and keeps protocol versions increasing', async () => {
    await service.query(query)
    await service.query({ ...query, content: 'const x = 3' })
    await service.query({ ...query, method: 'close' })
    await service.query(query)
    expect(child.messages).toContainEqual(
      expect.objectContaining({
        method: 'textDocument/didChange',
        params: expect.objectContaining({ textDocument: expect.objectContaining({ version: 2 }) })
      })
    )
    expect(
      child.messages.filter(
        (message) =>
          message &&
          typeof message === 'object' &&
          'method' in message &&
          message.method === 'textDocument/didOpen'
      )
    ).toHaveLength(2)
  })

  it('cancels timed out requests and accepts subsequent requests', async () => {
    vi.useFakeTimers()
    await service.query(query)
    child.respond = false
    const request = service.query(query)
    const assertion = expect(request).rejects.toThrow('timed out')
    await vi.advanceTimersByTimeAsync(15_001)
    await assertion
    expect(child.messages).toContainEqual(expect.objectContaining({ method: '$/cancelRequest' }))
    child.respond = true
    await expect(service.query(query)).resolves.toMatchObject({ available: true })
  })

  it('rejects pending requests on exit and allows a fresh session', async () => {
    await service.query(query)
    child.respond = false
    const request = service.query(query)
    await Promise.resolve()
    const assertion = expect(request).rejects.toThrow('exited')
    child.emit('exit', 1, null)
    await assertion
    child = new FakeChild()
    mocks.spawn.mockReturnValue(child)
    await expect(service.query(query)).resolves.toMatchObject({ available: true })
    expect(mocks.spawn).toHaveBeenCalledTimes(2)
  })

  it('cleans idle sessions and rejects queries after disposal', async () => {
    vi.useFakeTimers()
    await service.query(query)
    await vi.advanceTimersByTimeAsync(120_001)
    expect(child.kill).not.toHaveBeenCalled()
    await service.query({ ...query, method: 'close' })
    await vi.advanceTimersByTimeAsync(120_001)
    expect(child.kill).toHaveBeenCalledTimes(1)
    service.dispose()
    await expect(service.query(query)).rejects.toThrow('disposed')
  })

  it('rejects initialization errors instead of reporting unavailable', async () => {
    child.removeAllListeners()
    child.stdin.removeAllListeners('data')
    const request = service.query(query)
    const assertion = expect(request).rejects.toThrow('server error')
    child.stdout.write(
      encodeMessage({ jsonrpc: '2.0', id: 1, error: { code: -32603, message: 'failure' } })
    )
    await assertion
    expect(child.kill).toHaveBeenCalled()
  })
})
