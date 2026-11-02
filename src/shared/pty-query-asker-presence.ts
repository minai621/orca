import { createOsc133CommandFinishedScanner } from './terminal-osc133-command-finished'

/** `unsure`: the asker ran inside a shell command and may be exiting; `group` holds the terminal right now. */
export type PtyQueryAskerSample =
  | { presence: 'present' | 'gone' }
  | { presence: 'unsure'; group: number }

const PRESENT: PtyQueryAskerSample = { presence: 'present' }
const GONE: PtyQueryAskerSample = { presence: 'gone' }

/** A short-lived querier exits before its bytes are read, so its own process cannot be sampled (#14631, #16633).
 *  Stream order proves it ran inside a command (OSC 133;C); the shell finishing that command (133;D), or another
 *  process group taking the terminal, proves it is gone and a reply would be typed into the next reader. */
export class PtyQueryAskerPresence {
  private readonly markers = createOsc133CommandFinishedScanner(
    () => this.setCommandRunning(false),
    () => this.setCommandRunning(true),
    () => this.setCommandRunning(false)
  )
  private commandRunning = false

  /** Without a foreground group (ConPTY), only a finish marker read past the query proves the asker gone. */
  constructor(private readonly readForegroundGroup?: () => number | null | undefined) {}

  /** Every byte the PTY emits, in stream order. */
  observe(data: string): void {
    this.markers.scan(data)
  }

  private setCommandRunning(running: boolean): void {
    this.commandRunning = running
  }

  /** `after`: output already read past the query; `heldBy`: the group sampled when the query was read. */
  sample(after: string, heldBy?: number): PtyQueryAskerSample {
    if (!this.commandRunning) {
      return PRESENT
    }
    if (showsCommandFinished(after)) {
      return GONE
    }
    const group = this.readForegroundGroup?.()
    if (typeof group !== 'number') {
      return PRESENT
    }
    if (heldBy !== undefined) {
      return group === heldBy ? PRESENT : GONE
    }
    return { presence: 'unsure', group }
  }
}

function showsCommandFinished(output: string): boolean {
  let finished = false
  createOsc133CommandFinishedScanner(() => {
    finished = true
  }).scan(output)
  return finished
}
