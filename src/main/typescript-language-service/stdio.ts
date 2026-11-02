const MAX_FRAME_BYTES = 16 * 1024 * 1024
const MAX_HEADER_BYTES = 8192

/**
 * JSON 메시지에 바이트 길이를 붙여 LSP 프레임을 만들어요.
 * @param message - JSON으로 직렬화할 프로토콜 메시지예요.
 */
export function encodeMessage(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body])
}

export class MessageReader {
  private readonly header = Buffer.alloc(MAX_HEADER_BYTES)
  private headerLength = 0
  private body: Buffer | undefined
  private bodyLength = 0

  /**
   * 나뉘어 도착한 바이트에서 완성된 JSON 메시지를 읽어요.
   * @param chunk - stdout에서 받은 원본 바이트예요.
   * @param receive - 완성된 메시지마다 호출할 처리기예요.
   */
  push(chunk: Buffer, receive: (message: unknown) => void): void {
    let offset = 0
    while (offset < chunk.length) {
      if (this.body) {
        const take = Math.min(chunk.length - offset, this.body.length - this.bodyLength)
        chunk.copy(this.body, this.bodyLength, offset, offset + take)
        this.bodyLength += take
        offset += take
        if (this.bodyLength === this.body.length) {
          const body = this.body
          this.body = undefined
          this.bodyLength = 0
          receive(JSON.parse(body.toString('utf8')))
        }
        continue
      }
      this.header[this.headerLength++] = chunk[offset++]
      const end = this.headerLength
      if (end >= 4 && this.header.readUInt32BE(end - 4) === 0x0d0a0d0a) {
        const match = /(?:^|\r\n)Content-Length:\s*(\d+)\s*(?:\r\n|$)/i.exec(
          this.header.toString('ascii', 0, end - 4)
        )
        const length = match ? Number(match[1]) : Number.NaN
        if (!Number.isSafeInteger(length) || length <= 0 || length > MAX_FRAME_BYTES) {
          throw new Error('Invalid LSP content length')
        }
        this.headerLength = 0
        this.body = Buffer.allocUnsafe(length)
      } else if (end >= MAX_HEADER_BYTES) {
        throw new Error('LSP header exceeds limit')
      }
    }
  }
}
