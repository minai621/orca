import { describe, expect, it } from 'vitest'
import { encodeMessage, MessageReader } from './stdio'

describe('LSP framing', () => {
  it('handles partial headers and split UTF-8 characters across multiple frames', () => {
    const reader = new MessageReader()
    const messages: unknown[] = []
    const bytes = Buffer.concat([encodeMessage({ result: '한글' }), encodeMessage({ result: 2 })])
    for (const byte of bytes) {
      reader.push(Buffer.from([byte]), (message) => messages.push(message))
    }
    expect(messages).toEqual([{ result: '한글' }, { result: 2 }])
  })
  it('reads multiple complete frames in one chunk', () => {
    const messages: unknown[] = []
    new MessageReader().push(
      Buffer.concat([encodeMessage(1), encodeMessage(2), encodeMessage(3)]),
      (message) => messages.push(message)
    )
    expect(messages).toEqual([1, 2, 3])
  })
  it('rejects unbounded headers and body sizes', () => {
    expect(() => new MessageReader().push(Buffer.alloc(8192, 65), () => {})).toThrow(
      'header exceeds'
    )
    expect(() =>
      new MessageReader().push(Buffer.from('Content-Length: 999999999\r\n\r\n'), () => {})
    ).toThrow('content length')
    expect(() =>
      new MessageReader().push(Buffer.from('Content-Type: text/plain\r\n\r\n'), () => {})
    ).toThrow('content length')
  })
})
