export type RunOptions = {
  command: string
  args: string[]
  cwd: string
  stdin?: string
  signal?: AbortSignal
}

export type RunCliResult = {
  exitCode: number
  stdout: string
  stderr: string
}

export async function runCli(options: RunOptions): Promise<RunCliResult> {
  const process = Bun.spawn([options.command, ...options.args], {
    cwd: options.cwd,
    env: processEnv(),
    stdin: options.stdin === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
    signal: options.signal,
  })

  if (options.stdin !== undefined) {
    process.stdin.write(options.stdin)
    process.stdin.end()
  }

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ])

  return {
    exitCode,
    stdout: stdout.trim(),
    stderr: stderr.trim(),
  }
}

function processEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(Bun.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  )
}
