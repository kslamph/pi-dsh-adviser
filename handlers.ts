/**
 * The commands, as pure functions over injected dependencies.
 *
 * Everything pi provides — configuration, the dsh command, the run itself, the project store —
 * arrives through `HandlerDeps`, and everything the user sees leaves through `HandlerContext`. That
 * makes each command testable without pi, without dsh, and without a terminal, which is the only
 * way to assert a confirmation prompt or a warning message at all.
 *
 * @module handlers
 */

import { ensureProfile, setModel } from "./config.ts"
import type { DshConfig } from "./config.ts"
import { dshCommandFor } from "./resolve.ts"
import type { DshCommand } from "./resolve.ts"
import { run } from "./runner.ts"
import type { RunResult } from "./runner.ts"
import { openProject } from "./sessions.ts"
import type { Project, SessionRecord } from "./sessions.ts"
import { pruneExpired } from "./prune.ts"
import { dshRoutesFor } from "./dshRoutes.ts"
import type { DshRoute, DiscoveryResult } from "./dshRoutes.ts"
import { saveModel } from "./config.ts"

/** Everything the commands need from the outside world. */
export interface HandlerDeps {
  /** Read the user's configuration. */
  loadConfig: () => DshConfig
  /** Resolve how dsh is invoked. */
  dshCommand: (config: DshConfig) => DshCommand
  /** Run one dsh turn. */
  run: typeof run
  /** Create or update the dsh profile and return its patch path. */
  ensureProfile: (config: DshConfig, command: DshCommand) => string
  /** Persist a model choice and rewrite the dsh profile's default-model row. */
  setModel: (config: DshConfig, model: { provider: string; id: string }) => string
  /** Open the session store for a project path. */
  openProject: (cwd: string) => Project
  /** Apply retention to a store. */
  prune: typeof pruneExpired
  /** Routes the dsh profile composes from plugins. */
  routes: (config: DshConfig) => DiscoveryResult
  /** Clock, injected so tests are exact. */
  now: () => number
}

/** What a command may show the user. */
export interface HandlerContext {
  /** Directory the command runs in; this is the project sessions belong to. */
  cwd: string
  /** Show a message. */
  notify: (message: string, level: "info" | "warning" | "error") => void
  /** Show or clear a progress line. */
  setStatus: (text: string | undefined) => void
  /** Ask a yes/no question. */
  confirm: (question: string) => Promise<boolean>
  /** Record something in the transcript without adding it to the model's context. */
  appendEntry: (type: string, details: unknown) => void
}

/** A command handler. */
export type Handler = (args: string, ctx: HandlerContext) => Promise<void>

/** Structured detail recorded for a run, so later turns can name its session. */
export interface RunDetails {
  project: string
  index: number
  sessionId: string
  model: string
  steps: number
  durationMs: number
  outcome: string
  artifactPath: string
  truncated: boolean
}

/** How one invocation reaches dsh. */
export interface AdviserRun {
  /** The task text sent to dsh. */
  task: string
  /** Session to resume; omitted for a new session. */
  sessionId?: string
  /** Index of the session this run belongs to; omitted for a new session. */
  index?: number
  /** Wall-clock override. */
  timeoutMs?: number
  /** Cancellation, used by the tool. */
  signal?: AbortSignal
  /** Progress callback, used by the tool. */
  onProgress?: (label: string) => void
}

/** Outcome of one adviser run, including the text pi shows or returns. */
export interface AdviserResult {
  /** The session the run belongs to, once dsh reported its id. */
  record: SessionRecord
  /** The answer, capped for the model or the screen. */
  text: string
  /** Structured detail for the transcript or a tool result. */
  details: RunDetails
  /** Token usage dsh reported. */
  usage: RunResult["usage"]
}

/** Default dependencies, wired to the real implementations. */
export function realDeps(): HandlerDeps {
  return {
    loadConfig: () => {
      throw new Error("loadConfig must be injected")
    },
    dshCommand: dshCommandFor,
    run,
    ensureProfile: (config, command) => ensureProfile(config, command),
    setModel: (config, model) => {
      throw new Error("setModel must be injected")
    },
    openProject: (cwd) => {
      throw new Error("openProject must be injected")
    },
    prune: pruneExpired,
    routes: dshRoutesFor,
    now: () => Date.now(),
  }
}

/**
 * Run one adviser turn and record it against a project session.
 *
 * Both the commands and the model-callable tool go through here, so a run is created, capped,
 * stored, and logged identically no matter who asked.
 *
 * @param deps - injected dependencies
 * @param config - the loaded configuration
 * @param project - the project's session store
 * @param request - what to run and where it attaches
 * @returns the answer, its session record, and structured details
 * @throws when dsh cannot be run or reports a failure
 */
export async function runAdviser(deps: HandlerDeps, config: DshConfig, project: Project, request: AdviserRun): Promise<AdviserResult> {
  const command = deps.dshCommand(config)
  deps.ensureProfile(config, command)
  const model = `${config.model.provider}/${config.model.id}`
  const result = await deps.run({
    profile: config.dshProfile,
    dshCommand: command,
    cwd: project.path,
    task: request.task,
    ...(request.sessionId === undefined ? {} : { sessionId: request.sessionId }),
    timeoutMs: request.timeoutMs ?? config.timeoutMs,
    ...(request.signal === undefined ? {} : { signal: request.signal }),
    onEvent: (event) => {
      if (event.type === "status" && event.phase === "step_end") request.onProgress?.(`step ${Number(event.step ?? 0) + 1}`)
      if (event.type === "status" && event.phase === "turn_start") request.onProgress?.("thinking")
    },
  })
  const sessionId = result.sessionId ?? request.sessionId
  if (sessionId === undefined) {
    throw new Error("pi-dsh: dsh finished without reporting a session, so I cannot continue this conversation later")
  }

  const truncated = result.text.length > config.maxResultChars
  const text = truncated
    ? `${result.text.slice(0, config.maxResultChars)}\n\n[truncated — full answer at the artifact path]`
    : result.text
  const runId = `${deps.now()}`

  const record = request.index === undefined
    ? project.createSession({ sessionId, title: titleFrom(request.task), model }, deps.now)
    : (project.touch(request.index, deps.now), project.get(request.index) as SessionRecord)
  // Written after the index exists, so an artifact is always named after the session it belongs to
  // and deleting that session takes its artifacts with it.
  const artifactPath = project.writeArtifact(record.index, runId, result.text)

  project.appendRunLog({
    at: new Date(deps.now()).toISOString(),
    project: project.path,
    index: record.index,
    model,
    resumed: request.index !== undefined,
    taskChars: request.task.length,
    steps: result.steps,
    durationMs: result.durationMs,
    outcome: result.outcome,
    ...result.usage,
  })

  return {
    record,
    text,
    usage: result.usage,
    details: {
      project: project.path,
      index: record.index,
      sessionId,
      model,
      steps: result.steps,
      durationMs: result.durationMs,
      outcome: result.outcome,
      artifactPath,
      truncated,
    },
  }
}

/**
 * Derive a short, readable session title from the opening task.
 *
 * @param task - the task text
 * @returns up to four slugified words
 */
function titleFrom(task: string): string {
  const words = task.trim().toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((word) => word.length > 0)
  return words.slice(0, 4).join("-") || "session"
}

/**
 * Parse `/dsh-follow` arguments into an optional session index and the task text.
 *
 * `#7 text` and `7 text` both select session 7; `7 reasons login breaks` is an index plus task, but
 * a bare `7` is a usage mistake rather than an instruction to run an empty turn.
 *
 * @param args - the raw argument text
 * @returns the requested index (if any), the task text, and whether the input was malformed
 */
export function parseFollowArgs(args: string): { index?: number; text: string; usage: boolean } {
  const trimmed = args.trim()
  if (trimmed.length === 0) return { text: "", usage: true }
  const match = /^#?(\d+)(?:\s+([\s\S]+))?$/.exec(trimmed)
  if (match === null) return { text: trimmed, usage: false }
  const index = Number(match[1])
  const rest = match[2]?.trim() ?? ""
  if (rest.length === 0) return { ...(match[2] === undefined ? {} : { index }), text: trimmed, usage: true }
  return { index, text: rest, usage: false }
}

/**
 * Build every command handler.
 *
 * @param deps - injected dependencies
 * @returns handlers keyed by command name, without the leading slash
 */
export function createHandlers(deps: HandlerDeps): Record<string, Handler> {
  /** Load the configuration and open this project's store, or report why not. */
  function projectFor(ctx: HandlerContext): { config: DshConfig; project: Project } | undefined {
    try {
      const config = deps.loadConfig()
      return { config, project: deps.openProject(ctx.cwd) }
    } catch (error) {
      report(ctx, error)
      return undefined
    }
  }

  /** Apply retention, protecting a session this invocation names. */
  function prune(config: DshConfig, project: Project, protect?: number): void {
    try {
      deps.prune(project, config.pruneAfterHours, {
        purgeDsshSession: config.purgeDsshSessions,
        ...(protect === undefined ? {} : { protect }),
        now: deps.now,
      })
    } catch (error) {
      report(ctxOf(project), error)
    }
  }

  /** A context used only for reporting errors raised outside a command's own flow. */
  function ctxOf(_project: Project): HandlerContext {
    return fallbackCtx
  }

  let fallbackCtx: HandlerContext = {
    cwd: "",
    notify: () => undefined,
    setStatus: () => undefined,
    confirm: async () => false,
    appendEntry: () => undefined,
  }

  /** Run one adviser turn and show the result, honouring a working directory. */
  async function advise(
    ctx: HandlerContext,
    config: DshConfig,
    project: Project,
    request: AdviserRun,
    describe: (record: SessionRecord) => string,
  ): Promise<AdviserResult | undefined> {
    ctx.setStatus("dsh: starting")
    try {
      const result = await runAdviser(deps, config, project, {
        ...request,
        onProgress: (label) => ctx.setStatus(`dsh: ${label}`),
      })
      ctx.appendEntry("dsh-adviser", result.details)
      ctx.notify(`dsh: ${describe(result.record)} · ${result.details.steps} steps · ${(result.details.durationMs / 1000).toFixed(1)}s`, "info")
      return result
    } catch (error) {
      report(ctx, error)
      return undefined
    } finally {
      ctx.setStatus(undefined)
    }
  }

  /** Every route the adviser can be pointed at: pi-ai, plugin-provided, and declared. */
  function routesOf(config: DshConfig): { piAi: string[]; plugin: DshRoute[]; declared: string[]; error?: string } {
    const discovered = deps.routes(config)
    return {
      piAi: Object.keys(config.providers),
      plugin: discovered.routes,
      declared: config.dshProviders ?? [],
      ...(discovered.error === undefined ? {} : { error: discovered.error }),
    }
  }

  return {
    async dsh(args, ctx) {
      const task = args.trim()
      if (task.length === 0) {
        ctx.notify("usage: /dsh <task> — start a new adviser session in this project", "warning")
        return
      }
      const context = projectFor(ctx)
      if (context === undefined) return
      prune(context.config, context.project)
      await advise(ctx, context.config, context.project, { task }, (record) =>
        `session #${record.index} created — continue with /dsh-follow #${record.index} <text>`
        + ` · ${record.model}`,
      )
    },

    async "dsh-follow"(args, ctx) {
      const parsed = parseFollowArgs(args)
      if (parsed.usage || parsed.text.length === 0) {
        ctx.notify("usage: /dsh-follow <text> to continue the latest session, or /dsh-follow #<n> <text> for one in particular", "warning")
        return
      }
      const context = projectFor(ctx)
      if (context === undefined) return
      const sessions = context.project.list()
      if (sessions.length === 0) {
        ctx.notify("dsh: this project has no adviser sessions yet — start one with /dsh <task>", "warning")
        return
      }
      const target = parsed.index === undefined
        ? sessions[sessions.length - 1]
        : sessions.find((session) => session.index === parsed.index)
      if (target === undefined) {
        ctx.notify(
          `dsh: there is no session #${parsed.index} in this project. Run /dsh-sessions to see the ones that exist.`,
          "warning",
        )
        return
      }
      prune(context.config, context.project, target.index)
      await advise(ctx, context.config, context.project, {
        task: parsed.text,
        sessionId: target.sessionId,
        index: target.index,
      }, (record) => `continued session #${record.index} · ${record.model}`)
    },

    async "dsh-sessions"(args, ctx) {
      const context = projectFor(ctx)
      if (context === undefined) return
      const sessions = context.project.list()
      if (sessions.length === 0) {
        ctx.notify("dsh: no adviser sessions in this project yet — start one with /dsh <task>", "warning")
        return
      }
      const lines = [`adviser sessions for ${context.project.path}:`]
      const latest = sessions[sessions.length - 1]
      for (const session of sessions) {
        const age = relativeAge(Date.parse(session.lastUsedAt), deps.now())
        const marker = session.index === latest?.index ? "  ← latest" : ""
        lines.push(`  #${session.index} ${session.title} · ${session.runs} runs · ${age}${marker}`)
      }
      lines.push(`continue one with /dsh-follow #<n> <text>; remove one with /dsh-delete #<n>`)
      ctx.notify(lines.join("\n"), "info")
    },

    async "dsh-delete"(args, ctx) {
      const parsed = parseFollowArgs(`${args} x`)
      if (parsed.index === undefined) {
        ctx.notify("usage: /dsh-delete #<n> — remove one adviser session from this project", "warning")
        return
      }
      const context = projectFor(ctx)
      if (context === undefined) return
      const target = context.project.get(parsed.index)
      if (target === undefined) {
        ctx.notify(`dsh: there is no session #${parsed.index} in this project. Run /dsh-sessions to see the ones that exist.`, "warning")
        return
      }
      const confirmed = await ctx.confirm(
        `Delete adviser session #${target.index} ("${target.title}") and its saved answers?`,
      )
      if (!confirmed) {
        ctx.notify(`dsh: kept session #${target.index}`, "info")
        return
      }
      try {
        context.project.remove(target.index, { purgeDsshSession: context.config.purgeDsshSessions })
        ctx.notify(`dsh: deleted session #${target.index}`, "info")
      } catch (error) {
        report(ctx, error)
      }
    },

    async "dsh-status"(args, ctx) {
      const context = projectFor(ctx)
      if (context === undefined) return
      const { config, project } = context
      let route = "unresolved"
      let patch = "not created yet"
      try {
        const command = deps.dshCommand(config)
        route = command.route === "path" ? `dsh (installed on PATH)` : `npx ${command.args.join(" ")}`
        patch = deps.ensureProfile(config, command)
      } catch (error) {
        report(ctx, error)
        return
      }
      const sessions = project.list()
      const latest = sessions[sessions.length - 1]
      const routes = routesOf(config)
      const routeLine = routes.error !== undefined
        ? "routes: could not check the dsh plugins"
        : `routes:   ${routes.plugin.length + routes.declared.length} from dsh plugins`
      const lines = [
        `project:   ${project.path}`,
        `sessions:  ${sessions.length}${latest === undefined ? "" : ` · latest #${latest.index} "${latest.title}"`}`,
        `model:     ${config.model.provider}/${config.model.id} (${config.modelSource})`,
        `dsh:       ${config.dshProfile} (${patch})`,
        `dsh route: ${route}`,
        routeLine,
        `timeout:   ${Math.round(config.timeoutMs / 1000)}s`,
        `prune:     ${config.pruneAfterHours === 0 ? "off" : `after ${config.pruneAfterHours}h idle`}`,
      ]
      ctx.notify(lines.join("\n"), "info")
    },

    async "dsh-model"(args, ctx) {
      const value = args.trim()
      let config: DshConfig
      try {
        config = deps.loadConfig()
      } catch (error) {
        report(ctx, error)
        return
      }
      if (value.length === 0) {
        const lines: string[] = []
        for (const [provider, spec] of Object.entries(config.providers)) {
          lines.push(`${provider}${spec.displayName === undefined ? "" : ` (${spec.displayName})`}:`)
          for (const model of spec.models) {
            const current = provider === config.model.provider && model.id === config.model.id ? "  ← current" : ""
            lines.push(`  ${provider}/${model.id}${model.name === undefined ? "" : ` — ${model.name}`}${current}`)
          }
        }
        if (lines.length === 0) lines.push("no providers are configured yet")
        const routes = routesOf(config)
        if (routes.plugin.length > 0 || routes.declared.length > 0) {
          lines.push("")
          lines.push("routes from dsh plugins:")
          const names = [...routes.plugin.map((route) => route.route), ...routes.declared]
          for (const name of names) {
            const current = name === config.model.provider ? "  ← current" : ""
            lines.push(`  ${name}/${"<model>"}${current} — models are chosen at runtime, so set one with /dsh-model ${name}/<model>`)
          }
        } else if (routes.error !== undefined) {
          lines.push("")
          lines.push(`routes from dsh plugins: could not check — ${routes.error}`)
        }
        ctx.notify(lines.join("\n"), "info")
        return
      }
      const separator = value.lastIndexOf("/")
      if (separator <= 0 || separator === value.length - 1) {
        ctx.notify("usage: /dsh-model <provider>/<model> — run /dsh-model on its own to list the options", "warning")
        return
      }
      const provider = value.slice(0, separator)
      const id = value.slice(separator + 1)
      const routes = routesOf(config)
      const spec = config.providers[provider]
      const fromPlugin = routes.plugin.some((route) => route.route === provider)
      const declared = routes.declared.includes(provider)
      if (spec === undefined && !fromPlugin && !declared) {
        const known = [...routes.piAi, ...routes.plugin.map((route) => route.route), ...routes.declared]
        const available = known.length === 0 ? "none are configured yet" : `known routes: ${known.join(", ")}`
        ctx.notify(`dsh: ${provider} is not a route this adviser can use — ${available}`, "error")
        return
      }
      if (spec !== undefined && !spec.models.some((model) => model.id === id)) {
        // pi validates only what it owns: a plugin route's model lineup exists in dsh at run
        // time, so its id is accepted as written and a wrong one surfaces from dsh itself.
        ctx.notify(`dsh: ${provider} does not list a model called ${id}. Run /dsh-model on its own to see the options.`, "error")
        return
      }
      try {
        const saved = saveModel(config, { provider, id })
        const patchPath = deps.setModel({ ...config, model: { provider, id } }, { provider, id })
        ctx.notify(
          `dsh: the adviser now runs ${provider}/${id} — saved to ${saved.path} (previous copy at ${saved.backupPath}),`
          + ` dsh profile at ${patchPath}`,
          "info",
        )
        if (config.modelSource === "PI_DSH_DEFAULT_MODEL") {
          ctx.notify(
            `dsh: note PI_DSH_DEFAULT_MODEL is set in your environment, so it will override this choice on the next run.`
            + ` Unset it, or change the variable, to use ${provider}/${id}.`,
            "warning",
          )
        }
      } catch (error) {
        report(ctx, error)
      }
    },

    async "dsh-doctor"(args, ctx) {
      const lines: string[] = ["dsh-doctor:"]
      let config: DshConfig | undefined
      try {
        config = deps.loadConfig()
        lines.push(`  ok   configuration loaded from your pi-dsh config file`)
      } catch (error) {
        lines.push(`  fail configuration: ${error instanceof Error ? error.message : String(error)}`)
        ctx.notify(lines.join("\n"), "error")
        return
      }
      try {
        const command = deps.dshCommand(config)
        lines.push(`  ok   dsh reachable via ${command.route === "path" ? "the dsh on your PATH" : `npx ${command.args.join(" ")}`}`)
        lines.push(`  ok   dsh profile ${config.dshProfile} at ${deps.ensureProfile(config, command)}`)
      } catch (error) {
        lines.push(`  fail dsh: ${error instanceof Error ? error.message : String(error)}`)
      }
      for (const [provider, spec] of Object.entries(config.providers)) {
        const set = (process.env[spec.apiKeyEnv] ?? "").length > 0
        lines.push(`  ${set ? "ok  " : "fail"} provider ${provider} needs ${spec.apiKeyEnv} in your environment${set ? "" : " — it is not set"}`)
      }
      const routes = routesOf(config)
      if (routes.error !== undefined) {
        lines.push(`  note dsh plugin routes could not be checked: ${routes.error}`)
      }
      for (const route of routes.plugin) {
        if (route.apiKeyEnv === undefined) {
          lines.push(`  ok   route ${route.route} from ${route.packageName} needs no key`)
          continue
        }
        const set = (process.env[route.apiKeyEnv] ?? "").length > 0
        lines.push(`  ${set ? "ok  " : "fail"} route ${route.route} from ${route.packageName} needs ${route.apiKeyEnv} in your environment${set ? "" : " — it is not set"}`)
      }
      for (const declared of routes.declared) {
        if (routes.plugin.some((route) => route.route === declared)) continue
        lines.push(`  note route ${declared} is declared in your config but was not found in this dsh profile`)
      }
      try {
        const project = deps.openProject(ctx.cwd)
        lines.push(`  ok   sessions for ${project.path}: ${project.list().length} in ${project.slug}`)
      } catch (error) {
        lines.push(`  fail session store: ${error instanceof Error ? error.message : String(error)}`)
      }
      lines.push(`  note adviser runs in ${ctx.cwd} with dsh's workspace-write permissions; DSH_PERMISSION_MODE changes that`)
      ctx.notify(lines.join("\n"), "info")
    },
  }
}

/**
 * Report a failure the way a user can act on.
 *
 * @param ctx - the command context to notify
 * @param error - what went wrong
 * @returns {void}
 */
function report(ctx: HandlerContext, error: unknown): void {
  const raw = error instanceof Error ? error.message : String(error)
  // A child process failure can carry a whole stack trace in its message; users need the line.
  const message = (raw.split("\n")[0] ?? raw).trim()
  ctx.notify(message.startsWith("pi-dsh: ") ? message : `pi-dsh: ${message}`, "error")
}

/**
 * Describe how long ago a timestamp was, in words a user reads quickly.
 *
 * @param timestamp - milliseconds since the epoch
 * @param now - the current time
 * @returns a short relative description
 */
function relativeAge(timestamp: number, now: number): string {
  if (Number.isNaN(timestamp)) return "unknown"
  const minutes = Math.max(0, Math.round((now - timestamp) / 60_000))
  if (minutes < 1) return "just now"
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}
