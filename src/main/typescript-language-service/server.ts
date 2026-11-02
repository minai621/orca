import { spawnProcess } from '@orca/process-host'
import type { ChildProcess } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import type {
  TypeScriptQuery,
  TypeScriptQueryResult
} from '../../shared/typescript-language-service'
import { resolveNativeTypeScript, type NativeTypeScript } from './resolver'
import { encodeMessage, MessageReader } from './stdio'

const REQUEST_TIMEOUT_MS = 15_000
const IDLE_TIMEOUT_MS = 120_000
type PendingRequest = {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

class ServerSession {
  readonly ready: Promise<void>
  private readonly child: ChildProcess
  private readonly pending = new Map<number, PendingRequest>()
  private readonly documents = new Map<
    string,
    { content: string; version: number; clientVersion: number }
  >()
  private nextId = 0
  private failure: Error | undefined
  private idleTimer: ReturnType<typeof setTimeout> | undefined

  /**
   * 프로젝트의 네이티브 서버를 시작하고 초기화를 기다려요.
   * @param rootPath - 서버의 작업 디렉터리와 작업 공간 루트예요.
   * @param compiler - `executable`은 프로젝트 실행 파일, `version`은 설치된 패키지 버전이에요.
   * @param onDispose - 세션이 끝나면 캐시에서 제거할 처리기예요.
   */
  constructor(
    rootPath: string,
    readonly compiler: NativeTypeScript,
    private readonly onDispose: () => void
  ) {
    this.child = spawnProcess({
      program: compiler.executable,
      args: ['--lsp', '--stdio'],
      cwd: rootPath,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    const reader = new MessageReader()
    this.child.stdout?.on('data', (chunk: Buffer) => {
      try {
        reader.push(chunk, (message) => this.receive(message))
      } catch (error) {
        this.dispose(error instanceof Error ? error : new Error(String(error)))
      }
    })
    this.child.stdout?.on('error', (error) => this.dispose(error))
    this.child.stderr?.on('error', (error) => this.dispose(error))
    this.child.stderr?.resume()
    this.child.on('error', (error) => this.dispose(error))
    this.child.stdin?.on('error', (error) => this.dispose(error))
    this.child.on('exit', (code, signal) =>
      this.dispose(new Error(`TypeScript server exited (${code ?? signal})`))
    )
    this.ready = this.request('initialize', {
      processId: process.pid,
      rootUri: pathToFileURL(rootPath).href,
      workspaceFolders: [{ uri: pathToFileURL(rootPath).href, name: rootPath }],
      capabilities: { textDocument: { hover: { contentFormat: ['markdown', 'plaintext'] } } }
    })
      .then(() => {
        this.notify('initialized', {})
        this.touch()
      })
      .catch((error: unknown) => {
        this.dispose(error instanceof Error ? error : new Error(String(error)))
        throw error
      })
  }

  /**
   * 문서의 최신 내용을 보낸 뒤 언어 기능을 실행해요.
   * @param args - `rootPath`는 프로젝트 루트, `filePath`는 문서 경로, `content`는 전체 내용, `version`은 문서 버전, `method`는 기능 이름이에요. `position.line`과 `position.character`는 0부터 시작하는 위치예요.
   */
  async query(args: TypeScriptQuery): Promise<unknown> {
    await this.ready
    this.touch()
    const uri = pathToFileURL(args.filePath).href
    const document = this.documents.get(uri)
    if (args.method === 'close') {
      if (document) {
        this.notify('textDocument/didClose', { textDocument: { uri } })
        this.documents.delete(uri)
      }
      return null
    }
    if (!document) {
      this.notify('textDocument/didOpen', {
        textDocument: {
          uri,
          languageId: args.filePath.endsWith('.jsx')
            ? 'javascriptreact'
            : /\.[cm]?js$/.test(args.filePath)
              ? 'javascript'
              : args.filePath.endsWith('.tsx')
                ? 'typescriptreact'
                : 'typescript',
          version: args.version,
          text: args.content
        }
      })
      this.documents.set(uri, {
        content: args.content,
        version: args.version,
        clientVersion: args.version
      })
    } else if (args.version >= document.clientVersion && args.content !== document.content) {
      const version = Math.max(document.version + 1, args.version)
      this.notify('textDocument/didChange', {
        textDocument: { uri, version },
        contentChanges: [{ text: args.content }]
      })
      this.documents.set(uri, { content: args.content, version, clientVersion: args.version })
    } else if (args.version > document.clientVersion) {
      document.clientVersion = args.version
    }
    if (args.method === 'sync') {
      return null
    }
    try {
      return await this.request(`textDocument/${args.method}`, {
        textDocument: { uri },
        position: args.position
      })
    } finally {
      this.touch()
    }
  }

  /**
   * 서버를 끝내고 대기 중인 요청을 모두 실패로 마쳐요.
   * @param error - 요청 호출자에게 전달할 종료 원인이에요.
   */
  dispose(error = new Error('TypeScript server disposed')): void {
    if (this.failure) {
      return
    }
    this.failure = error
    clearTimeout(this.idleTimer)
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
    this.documents.clear()
    this.child.kill()
    this.onDispose()
  }

  private touch(): void {
    if (this.failure) {
      return
    }
    clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => {
      if (this.pending.size || this.documents.size) {
        this.touch()
      } else {
        this.dispose()
      }
    }, IDLE_TIMEOUT_MS)
    this.idleTimer.unref()
  }

  /**
   * 응답이 필요한 메시지를 보내고 제한 시간 안의 응답을 기다려요.
   * @param method - LSP 요청 이름이에요.
   * @param params - 요청 인자예요.
   */
  private request(method: string, params: unknown): Promise<unknown> {
    if (this.failure) {
      return Promise.reject(this.failure)
    }
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`TypeScript request timed out: ${method}`))
        try {
          this.notify('$/cancelRequest', { id })
        } catch {
          /* 종료 오류는 원래 요청 오류를 보존해요. */
        }
      }, REQUEST_TIMEOUT_MS)
      this.pending.set(id, { resolve, reject, timer })
      try {
        this.send({ jsonrpc: '2.0', id, method, params })
      } catch (error) {
        this.dispose(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  /**
   * 응답이 필요 없는 알림을 보내요.
   * @param method - LSP 알림 이름이에요.
   * @param params - 알림 인자예요.
   */
  private notify(method: string, params: unknown): void {
    this.send({ jsonrpc: '2.0', method, params })
  }

  /**
   * 실행 중인 서버의 stdin에 메시지를 써요.
   * @param message - JSON-RPC 메시지예요.
   */
  private send(message: unknown): void {
    if (this.failure) {
      throw this.failure
    }
    if (!this.child.stdin?.writable) {
      throw new Error('TypeScript server stdin is unavailable')
    }
    this.child.stdin.write(encodeMessage(message))
  }

  /**
   * 서버 응답을 요청과 연결하고 지원하지 않는 역방향 요청에 답해요.
   * @param message - stdout에서 읽은 JSON 값이에요.
   */
  private receive(message: unknown): void {
    if (!message || typeof message !== 'object' || !('id' in message)) {
      return
    }
    if ('method' in message) {
      this.send({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32601, message: 'Method not supported' }
      })
      return
    }
    if (typeof message.id !== 'number') {
      return
    }
    const pending = this.pending.get(message.id)
    if (!pending) {
      return
    }
    if (!('result' in message) && !('error' in message)) {
      this.dispose(new Error('Invalid TypeScript server response'))
      return
    }
    this.pending.delete(message.id)
    clearTimeout(pending.timer)
    if ('error' in message) {
      pending.reject(new Error(`TypeScript server error: ${JSON.stringify(message.error)}`))
    } else {
      pending.resolve('result' in message ? message.result : null)
    }
  }
}

export class TypeScriptLanguageService {
  private readonly sessions = new Map<string, ServerSession>()
  private disposed = false

  /**
   * 프로젝트 설치가 지원하는 언어 기능을 실행해요.
   * @param args - `rootPath`는 프로젝트 루트, `filePath`는 문서 경로, `content`는 전체 내용, `version`은 문서 버전, `method`는 기능 이름이에요. `position.line`과 `position.character`는 0부터 시작하는 위치예요.
   * @returns 설치가 지원되지 않으면 available이 false예요.
   */
  async query(args: TypeScriptQuery): Promise<TypeScriptQueryResult> {
    if (this.disposed) {
      throw new Error('TypeScript language service disposed')
    }
    let session = this.sessions.get(args.rootPath)
    if (!session) {
      if (args.method === 'close') {
        return { available: false }
      }
      const compiler = resolveNativeTypeScript(args.rootPath, args.filePath)
      if (!compiler) {
        return { available: false }
      }
      session = new ServerSession(args.rootPath, compiler, () =>
        this.sessions.delete(args.rootPath)
      )
      this.sessions.set(args.rootPath, session)
    }
    return { available: true, result: await session.query(args), version: session.compiler.version }
  }

  dispose(): void {
    this.disposed = true
    for (const session of this.sessions.values()) {
      session.dispose()
    }
    this.sessions.clear()
  }
}
