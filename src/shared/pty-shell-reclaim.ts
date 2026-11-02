import { isShellProcess } from './shell-process-detection'
import { createOsc133CommandFinishedScanner } from './terminal-osc133-command-finished'

/** The PTY's foreground process group (tcgetpgrp) and its leader's name, read synchronously. Hosts without a
 *  foreground group (ConPTY) have no reader. */
export type PtyForegroundReader = {
  group: () => number | null | undefined
  processName: () => string | null | undefined
}

/** `unsure`: a command's process group still holds the terminal, but the command may be exiting. */
export type PtyQueryAskerPresence = 'present' | 'unsure' | 'gone'

const COMMAND_FINISHED = '\x1b]133;D'

/** Tells whether a query's asker is still there to read the reply. A short-lived querier exits before its bytes are
 *  read, so sampling the asker names the shell or the dying command (#14631, #16633). Stream order instead proves a
 *  command started (OSC 133;C after the shell's prompt); the shell finishing it (133;D), or another process group
 *  taking the terminal, proves the asker is gone, so a reply would be read by someone else as typed input. */
export class PtyShellReclaim {
  private readonly markers = createOsc133CommandFinishedScanner(
    () => {
      this.commandRunning = false
    },
    () => {
      this.commandRunning = true
    },
    () => this.notePrompt()
  )
  private commandRunning = false
  private shellGroup: number | null = null

  constructor(private readonly foreground: PtyForegroundReader) {}

  /** Every byte the PTY emits, in stream order. */
  observe(data: string): void {
    this.markers.scan(data)
  }

  /** `after`: output already read past the query. `heldBy`: the group that held the terminal when the query was
   *  read; once another group holds it, the asker exited or gave the terminal up. */
  askerPresence(after: string, heldBy?: number): PtyQueryAskerPresence {
    const group = this.commandRunning && this.shellGroup !== null ? this.foreground.group() : null
    if (typeof group !== 'number') {
      return 'present'
    }
    if (after.includes(COMMAND_FINISHED)) {
      return 'gone'
    }
    if (heldBy !== undefined) {
      return group === heldBy ? 'present' : 'gone'
    }
    return group === this.shellGroup ? 'gone' : 'unsure'
  }

  get foregroundGroup(): number | undefined {
    const group = this.foreground.group()
    return typeof group === 'number' ? group : undefined
  }

  /** Only a shell's own prompt names the shell's group; an agent printing prompt markers is not the shell. */
  private notePrompt(): void {
    this.commandRunning = false
    const group = this.foreground.group()
    const name = this.foreground.processName()
    if (typeof group === 'number' && name && isShellProcess(name)) {
      this.shellGroup = group
    }
  }
}
