import { execFile } from 'node:child_process'

export interface ListeningProcess {
  pid: number
  executablePath: string | null
  argv: string[] | null
}

export interface ListenerInspectionDeps {
  listListeners: (port: number) => Promise<ListeningProcess[]>
  signalProcess: (pid: number, signal: NodeJS.Signals) => void
  sleep: (ms: number) => Promise<void>
}

function execFileText(command: string, args: string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(command, args, (error, stdout) => resolve(error ? null : stdout))
  })
}

function parseListenerPids(output: string): number[] {
  return output
    .split('\n')
    .filter((line) => line.startsWith('p'))
    .map((line) => Number(line.slice(1)))
    .filter((pid) => Number.isSafeInteger(pid) && pid > 0)
}

function parseCommandLine(command: string): string[] | null {
  // `ps command=` displays a process command line; it is not an argv API.
  // Backslashes and quoting are ambiguous display syntax, so leave such
  // commands uninspectable rather than normalizing them into false proof.
  if (command.includes('\\') || command.includes("'") || command.includes('"')) return null
  const tokens = command.split(/\s+/).filter(Boolean)
  return tokens.length > 0 ? tokens : null
}

async function inspectListener(pid: number): Promise<ListeningProcess> {
  const [command, openFiles] = await Promise.all([
    execFileText('ps', ['-p', String(pid), '-o', 'command=']),
    execFileText('lsof', ['-p', String(pid), '-a', '-d', 'txt', '-Fn'])
  ])
  const executablePath = openFiles
    ?.split('\n')
    .find((line) => line.startsWith('n'))
    ?.slice(1)

  return {
    pid,
    executablePath: executablePath || null,
    argv: command === null ? null : parseCommandLine(command.trim())
  }
}

async function realListListeners(port: number): Promise<ListeningProcess[]> {
  const output = await execFileText('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fp'])
  if (output === null) return []
  return Promise.all(parseListenerPids(output).map(inspectListener))
}

function realSignalProcess(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal)
  } catch {
    // The process may already have exited or not be owned by this user. A
    // reinspection determines whether the port was actually released.
  }
}

export function defaultListenerInspectionDeps(): ListenerInspectionDeps {
  return {
    listListeners: realListListeners,
    signalProcess: realSignalProcess,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  }
}

export function isSameVariantRoutingProxy(
  process: ListeningProcess,
  binary: string,
  config: string
): boolean {
  if (process.executablePath !== binary || process.argv === null) return false
  return process.argv.some(
    (argument, index) => argument === '-config' && process.argv?.[index + 1] === config
  )
}

export async function reclaimProvenOrphan(
  port: number,
  binary: string,
  config: string,
  deps: ListenerInspectionDeps
): Promise<{ reclaimed: boolean; killedPids: number[]; reason?: string }> {
  const listener = (await deps.listListeners(port)).find((process) =>
    isSameVariantRoutingProxy(process, binary, config)
  )
  if (!listener) {
    return { reclaimed: false, killedPids: [], reason: 'no proven same-variant listener' }
  }

  deps.signalProcess(listener.pid, 'SIGTERM')
  await deps.sleep(150)
  const remainsBound = (await deps.listListeners(port)).some(
    (process) => process.pid === listener.pid
  )
  if (remainsBound) {
    return {
      reclaimed: false,
      killedPids: [listener.pid],
      reason: 'proven same-variant listener remains bound after signalling'
    }
  }
  return { reclaimed: true, killedPids: [listener.pid] }
}
