/**
 * Session retention.
 *
 * An adviser session earns its keep only while follow-ups on one issue continue, so sessions are
 * meant to be short-lived and expire by inactivity. Expiry is evaluated when a command loads the
 * store — never on a timer — and a session the user explicitly named for this invocation is
 * protected, because a run must never be able to prune the conversation it is about to continue.
 *
 * @module prune
 */

import type { Project } from "./sessions.ts"

/** Inputs a caller may vary for one prune pass. */
export interface PruneOptions {
  /** Also remove dsh's own copy of each expired session. */
  purgeDsshSession?: boolean
  /** Index to keep even if it has expired, because this invocation targets it. */
  protect?: number
  /** Clock, injected so boundaries are exact in tests. */
  now?: () => number
}

/**
 * Remove sessions that have been inactive longer than the threshold.
 *
 * @param project - the project's session store
 * @param pruneAfterHours - inactivity hours; 0 disables pruning
 * @param options - purge, protection, and clock
 * @returns how many sessions were removed
 */
export function pruneExpired(project: Project, pruneAfterHours: number, options: PruneOptions = {}): number {
  if (pruneAfterHours <= 0) return 0
  const now = options.now ?? Date.now
  const cutoff = pruneAfterHours * 3_600_000
  const latest = project.latest()
  const expired = project.list().filter((session) => {
    if (session.index === latest?.index) return false
    if (options.protect !== undefined && session.index === options.protect) return false
    const lastUsed = Date.parse(session.lastUsedAt)
    if (Number.isNaN(lastUsed)) return false
    return now() - lastUsed > cutoff
  })
  for (const session of expired) {
    project.remove(session.index, {
      ...(options.purgeDsshSession === undefined ? {} : { purgeDsshSession: options.purgeDsshSession }),
    })
  }
  return expired.length
}
