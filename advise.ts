/**
 * The model-callable adviser tool.
 *
 * The commands in `handlers.ts` and this tool share one run path, so a run started by the model is
 * recorded exactly like one started by a human: same session store, same artifacts, same log. The
 * one thing the tool adds is addressing — a returned index the model can quote back, so a follow-up
 * can name a session other than the latest.
 *
 * @module advise
 */

import { pruneExpired } from "./prune.ts"
import { openProject } from "./sessions.ts"
import type { Project, SessionRecord } from "./sessions.ts"
import { runAdviser } from "./handlers.ts"
import type { HandlerDeps, RunDetails } from "./handlers.ts"
import type { RunResult } from "./runner.ts"

/** What the tool is given. */
export interface AdviseParams {
  /** The self-contained task for the adviser. */
  task: string
  /** Continue a session instead of starting one. */
  followUp?: boolean
  /** Which session to continue; defaults to the project's latest. */
  sessionIndex?: number
  /** Wall-clock limit for this run. */
  timeoutMs?: number
}

/** What the tool returns. */
export interface AdviseResult {
  /** The answer, plus the index needed to continue it. */
  text: string
  /** Structured detail, including the session index. */
  details: RunDetails
  /** Token usage dsh reported. */
  usage: RunResult["usage"]
}

/** A tool call as the runtime delivers it: the model's parameters plus runtime signals. */
export type AdviseRequest = AdviseParams & {
  /** Progress labels, forwarded to the runtime's streaming update. */
  onProgress?: (label: string) => void
  /** Cancellation, forwarded to the run. */
  signal?: AbortSignal
}

/** Dependencies, the same shape the commands use. */
export type AdviseDeps = HandlerDeps

/**
 * Build the tool's execute function.
 *
 * @param deps - injected dependencies
 * @returns a function that runs one adviser task for a project
 */
export function createAdvise(deps: AdviseDeps) {
  /**
   * Run one adviser task on behalf of the model.
   *
   * @param params - the task and how it attaches to a session
   * @param cwd - the project directory, which is also the workspace the adviser runs in
   * @returns the answer, its session index, and usage
   * @throws when no session matches, or when the run fails
   */
  return async function advise(params: AdviseRequest, cwd: string): Promise<AdviseResult> {
    const config = deps.loadConfig()
    const project = deps.openProject(cwd)
    const sessions = project.list()

    let target: SessionRecord | undefined
    if (params.followUp === true) {
      if (params.sessionIndex !== undefined) {
        target = sessions.find((session) => session.index === params.sessionIndex)
        if (target === undefined) {
          const known = sessions.map((session) => `#${session.index}`).join(", ")
          throw new Error(
            `pi-dsh: there is no session #${params.sessionIndex} in this project.`
            + ` Known sessions: ${known.length > 0 ? known : "none"}. Run /dsh-sessions to see them.`,
          )
        }
      } else {
        target = sessions[sessions.length - 1]
        if (target === undefined) {
          throw new Error(
            "pi-dsh: this project has no adviser sessions yet, so there is nothing to continue."
            + " Start one with /dsh <task>, or call me without followUp.",
          )
        }
      }
    }

    // Retention runs here so an explicit target cannot be pruned before the run reads it.
    pruneExpired(project, config.pruneAfterHours, {
      purgeDsshSession: config.purgeDsshSessions,
      ...(target === undefined ? {} : { protect: target.index }),
      now: deps.now,
    })

    const result = await runAdviser(deps, config, project, {
      task: params.task,
      ...(target === undefined ? {} : { sessionId: target.sessionId, index: target.index }),
      ...(params.timeoutMs === undefined ? {} : { timeoutMs: params.timeoutMs }),
      ...(params.signal === undefined ? {} : { signal: params.signal }),
      ...(params.onProgress === undefined ? {} : { onProgress: params.onProgress }),
    })

    const continueHint = `\n\n[adviser session #${result.record.index} of this project — call me again with followUp: true${result.record.index === latestIndex(project) ? "" : `, sessionIndex: ${result.record.index}`} to continue this thread]`
    return { text: `${result.text}${continueHint}`, details: result.details, usage: result.usage }
  }
}

/**
 * The index of the project's newest session.
 *
 * @param project - the project's store
 * @returns the latest index, or undefined when the project has none
 */
function latestIndex(project: Project): number | undefined {
  const sessions = project.list()
  return sessions.at(-1)?.index
}

export { openProject }
