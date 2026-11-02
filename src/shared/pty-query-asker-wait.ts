import { PtyIngressHeldSpan } from './pty-ingress-held-span'
import type { PtyIngressSourceSpan } from './pty-startup-ingress-contract'
import { PtyQueryAskerPresence, type PtyQueryAskerSample } from './pty-query-asker-presence'

// A shell reaps an exited asker and prints 133;D in about 1 ms; Codex, the strictest live asker, waits 100 ms.
const ASKER_WAIT_MS = 20

export type PtyQueryAskerVerdict = 'present' | 'gone'

/** Holds a colour query, and every byte after it, until the stream shows whether its asker is still there. The bytes
 *  after it stay held too, so a DA1 sentinel never overtakes the colour reply. */
export class PtyQueryAskerWait {
  private readonly presence: PtyQueryAskerPresence
  private readonly query: PtyIngressHeldSpan
  private later: PtyIngressSourceSpan[] = []
  private heldBy: number | undefined
  // A group already proven live is answered at once while it keeps the terminal.
  private liveGroup: number | undefined
  private verdict: { untilSeq: number; presence: PtyQueryAskerVerdict } | null = null

  constructor(
    readForegroundGroup: (() => number | null | undefined) | undefined,
    onExpire: () => void
  ) {
    this.presence = new PtyQueryAskerPresence(readForegroundGroup)
    this.query = new PtyIngressHeldSpan(ASKER_WAIT_MS, onExpire)
  }

  get waiting(): boolean {
    return this.query.span !== null
  }

  observe(data: string): void {
    this.presence.observe(data)
  }

  /** A held query's verdict, else what the stream says now; `after` is output read past the query. */
  sampleAt(query: PtyIngressSourceSpan, after: string): PtyQueryAskerSample {
    if (this.verdict && query.rawStartSeq < this.verdict.untilSeq) {
      return { presence: this.verdict.presence }
    }
    const sample = this.presence.sample(after)
    return sample.presence === 'unsure' && sample.group === this.liveGroup
      ? { presence: 'present' }
      : sample
  }

  /** `from`: the query and the rest of its read; `heldBy`: the group holding the terminal when it was read. */
  hold(from: PtyIngressSourceSpan, heldBy: number): void {
    this.query.hold(from)
    this.heldBy = heldBy
  }

  /** A later read while waiting: the verdict once that read settles it. */
  review(read: PtyIngressSourceSpan): PtyQueryAskerVerdict | null
  /** The verdict as it stands now, as at expiry. */
  review(read: null): PtyQueryAskerVerdict
  review(read: PtyIngressSourceSpan | null): PtyQueryAskerVerdict | null {
    if (read) {
      this.later.push(read)
    }
    const sample = this.presence.sample(read?.data ?? '', this.heldBy)
    return sample.presence === 'gone' ? 'gone' : read ? null : 'present'
  }

  /** Ends the wait; queries in the held span take `presence`, and later reads are classified afresh. */
  settle(
    presence: PtyQueryAskerVerdict
  ): { from: PtyIngressSourceSpan; later: PtyIngressSourceSpan[] } | null {
    const from = this.query.take()
    const later = this.later
    this.later = []
    if (!from) {
      return null
    }
    this.verdict = { untilSeq: from.rawEndSeq, presence }
    this.liveGroup = presence === 'present' ? this.heldBy : undefined
    this.heldBy = undefined
    return { from, later }
  }
}
