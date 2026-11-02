import {
  createOsc133CommandFinishedScanner,
  type Osc133CommandFinishedScanner
} from './terminal-osc133-command-finished'

/** `unsure`: the asker ran inside a shell command and may be exiting; `group` holds the terminal right now. */
export type PtyQueryAskerSample =
  | { presence: 'present' | 'gone' }
  | { presence: 'unsure'; group: number }

export type PtyQueryAskerVerdict = 'present' | 'gone'

const PRESENT: PtyQueryAskerSample = { presence: 'present' }
const GONE: PtyQueryAskerSample = { presence: 'gone' }

type HeldAsker = { group: number; finished: boolean; markers: Osc133CommandFinishedScanner }

/** A short-lived querier exits before its bytes are read, so it cannot be sampled itself (#14631, #16633). Stream order
 *  proves it ran inside a command (OSC 133;C); the command's 133;D, or another group taking the terminal, proves it gone. */
export class PtyQueryAskerPresence {
  private readonly markers = createOsc133CommandFinishedScanner(
    () => this.setCommandRunning(false),
    () => this.setCommandRunning(true),
    () => this.setCommandRunning(false)
  )
  private commandRunning = false
  private held: HeldAsker | null = null
  // Why: a group proven live is answered at once for the rest of its command.
  private liveGroup: number | undefined

  /** Without a foreground group (ConPTY), only a finish marker past the query proves the asker gone. */
  constructor(private readonly readForegroundGroup?: () => number | null | undefined) {}

  /** Every byte the PTY emits, in stream order. */
  observe(data: string): void {
    this.markers.scan(data)
  }

  /** `finishedAfter`: whether the command's finish marker was read past the query. */
  sample(finishedAfter: () => boolean): PtyQueryAskerSample {
    if (!this.commandRunning) {
      return PRESENT
    }
    if (finishedAfter()) {
      return GONE
    }
    const group = this.readForegroundGroup?.()
    if (typeof group !== 'number' || group === this.liveGroup) {
      return PRESENT
    }
    return { presence: 'unsure', group }
  }

  /** Watch for the asker leaving, from the output read past its query. */
  hold(after: string, group: number): void {
    const held: HeldAsker = {
      group,
      finished: false,
      markers: createOsc133CommandFinishedScanner(() => {
        held.finished = true
      })
    }
    this.held = held
    held.markers.scan(after)
  }

  /** Feeds a later read to the held asker's finish watch; returns where its finish marker ends, or -1. */
  watch(read: string): number {
    return this.held?.markers.scan(read) ?? -1
  }

  /** `gone` once proven; otherwise `present` when `final`, else null to keep waiting. */
  judge(final: boolean): PtyQueryAskerVerdict | null {
    const held = this.held
    const group = held && !held.finished ? this.readForegroundGroup?.() : undefined
    if (held && (held.finished || (typeof group === 'number' && group !== held.group))) {
      return 'gone'
    }
    return final ? 'present' : null
  }

  release(verdict: PtyQueryAskerVerdict): void {
    this.liveGroup = verdict === 'present' ? this.held?.group : undefined
    this.held = null
  }

  private setCommandRunning(running: boolean): void {
    this.commandRunning = running
    this.liveGroup = undefined
  }
}

/** Where the last command finish marker in `output` ends, or -1. */
export function lastCommandFinishEnd(output: string): number {
  return createOsc133CommandFinishedScanner(() => {}).scan(output)
}
