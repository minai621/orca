import { afterEach, describe, expect, it, vi } from 'vitest'
import { PtyStartupIngress, type PtyIngressEmission } from './pty-startup-ingress'

const SHELL_GROUP = 100
const COMMAND_GROUP = 200
const QUERY = '\x1b]11;?\x07'
const REPLY = '\x1b]11;rgb:0000/0000/0000\x1b\\'
const DA1 = '\x1b[c'
const PROMPT = '\x1b]133;D;0\x07\x1b]133;A\x07$ '
const COMMAND_START = '\x1b]133;C\x07'

function createHarness() {
  const writes: string[] = []
  const emissions: PtyIngressEmission[] = []
  const foreground: { group: number | null; name: string } = { group: SHELL_GROUP, name: 'bash' }
  const ingress = new PtyStartupIngress({
    ownerBackend: 'posix-pty',
    resolveHostColors: () => ({ foreground: '#ffffff', background: '#000000' }),
    foreground: { group: () => foreground.group, processName: () => foreground.name },
    write: (data) => writes.push(data),
    onEmission: (emission) => emissions.push(emission)
  })
  const visible = (): string => emissions.map((emission) => emission.data).join('')
  // The shell prints its prompt, then runs a command in its own process group.
  const runCommand = (name: string): void => {
    ingress.accept(`${PROMPT}${COMMAND_START}`)
    foreground.group = COMMAND_GROUP
    foreground.name = name
  }
  const returnToShell = (): void => {
    foreground.group = SHELL_GROUP
    foreground.name = 'bash'
  }
  return { ingress, writes, visible, foreground, runCommand, returnToShell }
}

describe('PTY owner colour replies after the asker exits', () => {
  afterEach(() => vi.useRealTimers())

  it('drops the reply when the shell finishes the command right after it asked', () => {
    // `/usr/bin/printf '\e]11;?\a'` exits before bash reclaims the tty; the reply would be typed into bash (#16633).
    vi.useFakeTimers()
    const { ingress, writes, visible, runCommand, returnToShell } = createHarness()
    runCommand('printf')
    ingress.accept(QUERY)
    returnToShell()
    ingress.accept(PROMPT)
    vi.runAllTimers()

    expect(writes).toEqual([])
    expect(visible()).toBe(`${PROMPT}${COMMAND_START}${PROMPT}`)
  })

  it('drops the reply once the shell owns the terminal again mid-command', () => {
    const { ingress, writes, runCommand, returnToShell } = createHarness()
    runCommand('printf')
    returnToShell()
    ingress.accept(QUERY)

    expect(writes).toEqual([])
  })

  it('drops the reply when the next command of the line has taken the terminal', () => {
    // `printf …; cat`: bash reaps printf and hands the terminal to cat before it prints any prompt.
    vi.useFakeTimers()
    const { ingress, writes, foreground, runCommand } = createHarness()
    runCommand('printf')
    ingress.accept(QUERY)
    foreground.group = 201
    vi.advanceTimersByTime(20)

    expect(writes).toEqual([])
  })

  it('answers a live command after a short wait, keeping a DA1 sentinel behind the reply', () => {
    vi.useFakeTimers()
    const { ingress, writes, visible, runCommand } = createHarness()
    runCommand('delta')
    ingress.accept(`${QUERY}${DA1}`)
    expect(writes).toEqual([])
    expect(visible()).toBe(`${PROMPT}${COMMAND_START}`)

    vi.advanceTimersByTime(20)
    expect(writes).toEqual([REPLY])
    // The viewer answers DA1 only after the colour reply is written.
    expect(visible()).toBe(`${PROMPT}${COMMAND_START}${DA1}`)
  })

  it('answers at once at the prompt, before any marker, and for an agent with its own prompt markers', () => {
    const { ingress, writes, foreground } = createHarness()
    ingress.accept(QUERY)
    ingress.accept(PROMPT)
    ingress.accept(QUERY)
    ingress.accept(COMMAND_START)
    foreground.group = 300
    foreground.name = 'node'
    ingress.accept(`\x1b]133;A\x07> ${QUERY}`)

    expect(writes).toEqual([REPLY, REPLY, REPLY])
  })

  it('answers at once when the foreground group is unknown', () => {
    const { ingress, writes, foreground, runCommand } = createHarness()
    runCommand('printf')
    foreground.group = null
    ingress.accept(QUERY)

    expect(writes).toEqual([REPLY])
  })
})
