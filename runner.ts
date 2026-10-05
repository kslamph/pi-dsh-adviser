/**
 * The dsh transport pi-dsh drives: one `dsh --profile <p> --json` process per
 * run, its newline-delimited events consumed as they arrive.
 *
 * A run is a bounded packet rather than a transcript: dsh keeps its own session
 * history, so a follow-up resumes that session instead of re-sending context.
 */

import { spawn } from "node:child_process"
import type { DshCommand } from "./resolve.ts"

/** One event from the dsh run stream. */
export interface DshEvent {
  type: string
  [key: string]: unknown
}

/** Token accounting dsh reports per step, in its own event vocabulary. */
export interface DshUsage {
  input: number
  output: number
  cacheRead: number
  totalTokens: number
}

/** dsh's per-step usage fields, as they appear on a `step_end` event. */
interface DshStepUsage {
  inputTokens?: number
  outputTokens?: number
  cacheReadTokens?: number
  totalTokens?: number
}

/** What one run produced. */
export interface RunResult {
  /** Session the answer came from; pass it to resume. */
  sessionId: string | undefined
  /** The answer text, empty when the run failed before answering. */
  text: string
  /** Steps the run took. */
  steps: number
  /** Token usage summed over steps. */
  usage: DshUsage
  /** Why the run ended, from dsh's own reason vocabulary. */
  outcome: string
  /** Wall-clock duration in milliseconds. */
  durationMs: number
  /** dsh's diagnostics, kept for the failure path. */
  stderr: string
}

/** Options for one run. */
export interface RunOptions {
  /** dsh profile to boot. */
  profile: string
  /** Resolved dsh invocation; defaults to `dsh` on PATH. */
  dshCommand?: DshCommand
  /** Test seam for the child process; defaults to node:child_process spawn. */
  spawnFn?: typeof spawn
  /** Working directory dsh runs in. */
  cwd: string
  /** The task text. */
  task: string
  /** Session to resume; omit to start a new one. */
  sessionId?: string
  /** Wall-clock limit. */
  timeoutMs: number
  /** Called for every streamed event. */
  onEvent?: (event: DshEvent) => void
  /** Cancels the run. */
  signal?: AbortSignal
  /** Launcher overlays passed as `--patch`, each overriding profile rows for this run. */
  patchPaths?: string[]
  /** The child's environment; defaults to a scrubbed allowlist of ours. */
  env?: NodeJS.ProcessEnv
}

/**
 * Variables a dsh run needs whatever the configuration says.
 *
 * The child is a full agent with a shell and network access, so handing it
 * everything the user's shell holds would hand it every credential in the
 * session — including the provider keys this run needs, which are added back
 * explicitly by {@link adviserEnv} and nothing else.
 */
const ENV_NAMES = [
  "PATH", "HOME", "USERPROFILE", "SHELL", "TMPDIR", "TMP", "TEMP",
  "LANG", "LANGUAGE", "LC_ALL", "LC_CTYPE", "TZ", "TERM",
  "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR",
]

/** Variable prefixes kept whole, so dsh's and pi-dsh's own settings survive. */
const ENV_PREFIXES = ["DSH_", "PI_DSH_", "npm_config_"]

/**
 * Build the environment a dsh run is allowed to see.
 *
 * Allowlist rather than denylist: a new secret in the user's shell is excluded by
 * default instead of leaking until someone remembers to add it here. Provider keys
 * are the deliberate exception, passed as `extraKeys`, because dsh reads them from
 * the environment by name.
 *
 * @param extraKeys - variable names the run genuinely needs, such as provider keys
 * @param base - the environment to filter; defaults to this process's
 * @returns the filtered environment
 */
export function adviserEnv(extraKeys: readonly string[] = [], base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const wanted = new Set([...ENV_NAMES, ...extraKeys])
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue
    if (wanted.has(key) || ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) env[key] = value
  }
  return env
}

/** Raised when a run cannot be started at all. */
export class RunError extends Error {}

/**
 * Sum per-step usage into one total.
 *
 * @param totals - the accumulator to add into
 * @param usage - the step's usage as dsh reports it, or undefined when it reported none
 * @returns {void}
 */
function accumulate(totals: DshUsage, usage: DshStepUsage | undefined): void {
  if (usage === undefined) return
  totals.input += usage.inputTokens ?? 0
  totals.output += usage.outputTokens ?? 0
  totals.cacheRead += usage.cacheReadTokens ?? 0
  totals.totalTokens += usage.totalTokens ?? 0
}

/**
 * Run one dsh turn and resolve when it ends.
 *
 * The child is killed on timeout or abort; dsh keeps its session either way, so a
 * later run can resume it.
 *
 * @param options - the profile, task, session, limits, and event sink
 * @returns the answer, usage, and outcome
 * @throws {RunError} when dsh cannot be started or exits without an outcome
 */
export async function run(options: RunOptions): Promise<RunResult> {
  const args = [...(options.dshCommand?.args ?? [])]
  for (const patch of options.patchPaths ?? []) args.push("--patch", patch)
  args.push("--profile", options.profile, "--json")
  if (options.sessionId !== undefined) args.push("--session-id", options.sessionId)
  args.push("--", options.task)

  const spawnFn = options.spawnFn ?? spawn
  const started = Date.now()
  const usage: DshUsage = { input: 0, output: 0, cacheRead: 0, totalTokens: 0 }
  let sessionId: string | undefined
  let text = ""
  let steps = 0
  let outcome: string | undefined
  let stderr = ""
  let buffer = ""

  await new Promise<void>((resolve, reject) => {
    const child = spawnFn(options.dshCommand?.command ?? "dsh", args, {
      cwd: options.cwd,
      env: options.env ?? adviserEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    })

    const timer = setTimeout(() => {
      stderr += `\npi-dsh: killed after ${options.timeoutMs}ms`
      child.kill("SIGTERM")
    }, options.timeoutMs)

    const stop = () => {
      clearTimeout(timer)
      options.signal?.removeEventListener("abort", onAbort)
    }
    const onAbort = () => {
      stderr += "\npi-dsh: cancelled by pi"
      child.kill("SIGTERM")
    }
    options.signal?.addEventListener("abort", onAbort, { once: true })

    child.stdout.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk
      let newline = buffer.indexOf("\n")
      while (newline !== -1) {
        const line = buffer.slice(0, newline).trim()
        buffer = buffer.slice(newline + 1)
        newline = buffer.indexOf("\n")
        if (line.length === 0) continue
        let event: DshEvent
        try {
          event = JSON.parse(line) as DshEvent
        } catch {
          stderr += `\npi-dsh: unparsable event: ${line.slice(0, 200)}`
          continue
        }
        options.onEvent?.(event)
        if (event.type === "session") sessionId = event.sessionId as string
        if (event.type === "status" && event.phase === "step_end") {
          steps = Math.max(steps, Number(event.step ?? steps))
          accumulate(usage, event.usage as DshStepUsage | undefined)
        }
        if (event.type === "status" && event.phase === "turn_end") {
          const reason = event.reason as { kind?: string } | undefined
          outcome = reason?.kind ?? "unknown"
        }
        if (event.type === "final") text = String(event.text ?? "")
      }
    })

    child.stderr.setEncoding("utf8")
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk
    })

    child.on("error", (error) => {
      stop()
      reject(new RunError(`pi-dsh: could not start dsh: ${error.message}`))
    })
    child.on("close", (code) => {
      stop()
      if (outcome === undefined) {
        const detail = stderr.trim().split("\n").slice(-3).join(" ")
        reject(new RunError(`pi-dsh: dsh exited with code ${code ?? "null"} before reporting an outcome${detail ? `: ${detail}` : ""}`))
        return
      }
      resolve()
    })
  })

  if (outcome === "error") {
    const failure = await failureText(text, stderr)
    throw new RunError(`pi-dsh: the dsh turn failed: ${failure}`)
  }

  return { sessionId, text, steps, usage, outcome: outcome ?? "unknown", durationMs: Date.now() - started, stderr }
}

/**
 * Extract the most specific failure text a failed run produced.
 *
 * @param text - the run's final text, which carries dsh's error payload
 * @param stderr - the run's diagnostics
 * @returns one line naming the failure
 */
async function failureText(text: string, stderr: string): Promise<string> {
  const trimmed = text.trim()
  if (trimmed.length > 0) return trimmed.split("\n")[0] ?? trimmed
  const lines = stderr.trim().split("\n").filter((line) => line.trim().length > 0)
  return lines[lines.length - 1] ?? "no reason reported"
}