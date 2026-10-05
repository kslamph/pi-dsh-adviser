/**
 * pi-dsh — drive a DeepSeek Harness runtime as an external adviser from pi.
 *
 * pi owns the question and the follow-ups; dsh owns the work. Each run is a separate dsh profile
 * with its own loop, system prompt, toolset, and model, so the adviser reaches the problem
 * differently rather than re-deriving pi's approach. The two contexts stay separate by design: a run
 * carries a task text, never pi's transcript, and dsh keeps its own session history so a follow-up
 * costs a short message instead of a re-sent conversation.
 *
 * Two ideas are kept apart throughout: the **dsh profile** is dsh's machine-scoped configuration
 * home, and an **adviser session** is one conversation belonging to one project directory. Every
 * project has its own list of sessions, each addressable by its `#n` index, listable, deletable, and
 * pruned once it goes idle.
 *
 * Commands: /dsh, /dsh-follow, /dsh-sessions, /dsh-delete, /dsh-status, /dsh-model, /dsh-doctor.
 * Tool: dsh_advise.
 *
 * @module pi-dsh
 */

import { Type } from "typebox"
import type { DshConfig } from "./config.ts"
import type { ExtensionAPI, ExtensionCommandContext, ExtensionToolContext } from "@earendil-works/pi-coding-agent"
import { loadConfig } from "./config.ts"
import { dshCommandFor } from "./resolve.ts"
import { run } from "./runner.ts"
import { openProject } from "./sessions.ts"
import { pruneExpired } from "./prune.ts"
import { dshRoutesFor } from "./dshRoutes.ts"
import { ensureProfile, setModel } from "./config.ts"
import { createHandlers } from "./handlers.ts"
import { createAdvise } from "./advise.ts"
import type { HandlerContext } from "./handlers.ts"

/**
 * Describe what one command did, for the transcript.
 *
 * The entry keeps pi's model context clean while still leaving a record the user can read and a
 * later turn can cite.
 *
 * @param pi - the extension API
 * @param ctx - the command context whose transcript receives the entry
 * @param details - the run's structured detail
 * @returns {void}
 */
function showInTranscript(pi: ExtensionAPI, ctx: ExtensionCommandContext, details: unknown): void {
  pi.appendEntry("dsh-adviser", details)
}

export default function piDsh(pi: ExtensionAPI): void {
  const deps = {
    loadConfig,
    dshCommand: (config: DshConfig) => dshCommandFor(config),
    run,
    ensureProfile: (config: Parameters<typeof ensureProfile>[0], command: Parameters<typeof ensureProfile>[1]) =>
      ensureProfile(config, command),
    setModel: (config: Parameters<typeof setModel>[0], model: Parameters<typeof setModel>[1]) =>
      setModel(config, model, dshCommandFor(config)),
    openProject: (cwd: string) => openProject(cwd, loadConfig().projectsDir),
    prune: pruneExpired,
    routes: (config: DshConfig) => dshRoutesFor(config),
    now: () => Date.now(),
  }

  const advise = createAdvise(deps)

  /** Bridge pi's command context to the handler context, so tests never need pi. */
  const contextFor = (ctx: ExtensionCommandContext): HandlerContext => ({
    cwd: ctx.cwd,
    notify: (message, level) => ctx.ui.notify(message, level),
    setStatus: (text) => ctx.ui.setStatus("dsh", text),
    confirm: (question) => ctx.ui.confirm("Delete an adviser session?", question),
    appendEntry: (type, details) => showInTranscript(pi, ctx, details),
  })

  const handlers = createHandlers(deps)
  const descriptions: Record<string, string> = {
    dsh: "Ask the dsh adviser: /dsh <task> (starts a new adviser session)",
    "dsh-follow": "Continue an adviser session: /dsh-follow <text> or /dsh-follow #<n> <text>",
    "dsh-sessions": "List this project's adviser sessions",
    "dsh-delete": "Delete one adviser session: /dsh-delete #<n>",
    "dsh-status": "Show the adviser's project, sessions, model, and dsh route",
    "dsh-model": "Switch the adviser's model: /dsh-model <provider>/<model>",
    "dsh-doctor": "Check the adviser's configuration, dsh route, and provider keys",
  }
  for (const [name, description] of Object.entries(descriptions)) {
    const handler = handlers[name]
    if (handler === undefined) continue
    pi.registerCommand(name, {
      description,
      ...(name === "dsh-model" ? { getArgumentCompletions: modelCompletions } : {}),
      handler: async (args, ctx) => {
        await handler(args, contextFor(ctx))
      },
    })
  }

  pi.registerTool({
    name: "dsh_advise",
    label: "dsh adviser",
    description:
      "Delegate a self-contained task to a separate DeepSeek Harness runtime that has its own system prompt,"
      + " toolset, and model. Use it for a second opinion, an isolated deep dive, or work that needs its own"
      + " discipline. It does not see this conversation: state the task and the constraints it needs."
      + " It is a real agent, not a read-only reviewer. It runs in this project directory with a shell: it can"
      + " create and edit files here, run tests, spawn its own subagents, and fetch from the network, and it may"
      + " read any file this process can read. Every run reports which project files it changed."
      + " Pass mode \"read-only\" for an opinion that must not touch the tree; the default \"workspace-write\""
      + " lets it run tests and leave scratch files. Sessions belong to the project directory and keep the mode"
      + " they were first run with — dsh records it and will not change it — so a follow-up cannot change mode,"
      + " and this tool cannot ask for danger-full-access. It cannot ask the user questions either, so the task"
      + " must be complete.",
    parameters: Type.Object({
      task: Type.String({ description: "The task for the adviser, including any constraints and the files or paths it should read." }),
      followUp: Type.Optional(Type.Boolean({ description: "Continue an adviser session instead of starting a new one." })),
      sessionIndex: Type.Optional(Type.Number({ description: "Which of this project's sessions to continue; defaults to the latest." })),
      timeoutMs: Type.Optional(Type.Number({ description: "Wall-clock limit for this run; defaults to the configured limit." })),
      mode: Type.Optional(Type.Union([Type.Literal("read-only"), Type.Literal("workspace-write")], {
        description: "File permissions for this session. \"read-only\" refuses every file change; \"workspace-write\" allows changes inside this project directory and /tmp. Defaults to your configured mode. It cannot change an existing session's mode.",
      })),
    }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    async execute(_toolCallId, params, signal, onUpdate, toolContext: ExtensionToolContext) {
      try {
        const result = await advise(
          {
            task: params.task,
            ...(params.followUp === undefined ? {} : { followUp: params.followUp }),
            ...(params.sessionIndex === undefined ? {} : { sessionIndex: params.sessionIndex }),
            ...(params.timeoutMs === undefined ? {} : { timeoutMs: params.timeoutMs }),
            ...(params.mode === undefined ? {} : { mode: params.mode }),
            ...(onUpdate === undefined || signal === undefined ? {} : {
              onProgress: (label: string) => onUpdate({ content: [{ type: "text", text: `dsh: ${label}` }], details: undefined }),
              signal,
            }),
          },
          toolContext.cwd,
        )
        return {
          content: [{ type: "text", text: result.text }],
          details: result.details,
          usage: {
            input: result.usage.input,
            output: result.usage.output,
            cacheRead: result.usage.cacheRead,
            cacheWrite: 0,
            totalTokens: result.usage.totalTokens,
            // These routes are free-tier, so the cost fields are zero by contract rather
            // than by omission: dsh reports tokens, not price.
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        }
      } catch (error) {
        throw error instanceof Error ? error : new Error(String(error))
      }
    },
  })
}

/**
 * Suggest configured `provider/model` pairs while typing `/dsh-model`.
 *
 * @param argumentPrefix - what the user has typed so far
 * @returns matching completions, or null when the configuration cannot be read
 */
function modelCompletions(argumentPrefix: string) {
  try {
    const config = loadConfig()
    return Object.entries(config.providers)
      .flatMap(([provider, spec]) =>
        spec.models.map((model) => ({
          value: `${provider}/${model.id}`,
          label: `${provider}/${model.id}`,
          description: model.name ?? model.id,
        })),
      )
      .filter((item) => item.value.startsWith(argumentPrefix) || item.label.includes(argumentPrefix))
      .map((item) =>
        `${item.value}` === `${config.model.provider}/${config.model.id}`
          ? { ...item, description: `${item.description} · current` }
          : item,
      )
  } catch {
    return null
  }
}
