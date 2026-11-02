import { PtyIngressHeldSpan } from './pty-ingress-held-span'
import type { PtyIngressSourceSpan } from './pty-startup-ingress-contract'
import type { PtyQueryAskerPresence } from './pty-shell-reclaim'

// Long enough for a shell to reap a command that exited right after asking and print its prompt (about 1 ms measured),
// short enough for a live asker: Codex waits 100 ms for colour replies.
const ASKER_WAIT_MS = 20

type AskerPresenceSource = {
  askerPresence: (after: string, heldBy?: number) => PtyQueryAskerPresence
  readonly foregroundGroup: number | undefined
}

/** Holds a colour query, and every byte after it, until the stream shows whether its asker is still there. Holding
 *  the bytes after it keeps a DA1 sentinel behind the colour reply, so the asker never stops reading early. */
export class PtyQueryAskerWait {
  private readonly query: PtyIngressHeldSpan
  private later: PtyIngressSourceSpan[] = []
  private heldBy: number | undefined
  private verdict: { untilSeq: number; presence: 'present' | 'gone' } | null = null

  constructor(
    private readonly source: AskerPresenceSource,
    onExpire: () => void
  ) {
    this.query = new PtyIngressHeldSpan(ASKER_WAIT_MS, onExpire)
  }

  get waiting(): boolean {
    return this.query.span !== null
  }

  /** A held query's verdict, else what the stream says now; `after` is output read past the query. */
  presenceOf(query: PtyIngressSourceSpan, after: string): PtyQueryAskerPresence {
    return this.verdict && query.rawStartSeq < this.verdict.untilSeq
      ? this.verdict.presence
      : this.source.askerPresence(after)
  }

  /** `from`: the query and the rest of its read. */
  hold(from: PtyIngressSourceSpan): void {
    this.query.hold(from)
    this.heldBy = this.source.foregroundGroup
  }

  /** A later read while waiting (`null` once the wait expires): the verdict once it is known. */
  review(read: PtyIngressSourceSpan | null): 'present' | 'gone' | null {
    if (read) {
      this.later.push(read)
    }
    const presence = this.source.askerPresence(read?.data ?? '', this.heldBy)
    return presence === 'gone' ? 'gone' : read ? null : 'present'
  }

  /** Ends the wait; queries in the held span take `presence`, and later reads are classified afresh. */
  settle(
    presence: 'present' | 'gone'
  ): { from: PtyIngressSourceSpan; later: PtyIngressSourceSpan[] } | null {
    const from = this.query.take()
    const later = this.later
    this.later = []
    if (!from) {
      return null
    }
    this.verdict = { untilSeq: from.rawEndSeq, presence }
    return { from, later }
  }
}
