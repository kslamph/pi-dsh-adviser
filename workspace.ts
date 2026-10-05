/**
 * Detecting what an adviser run changed in the shared project directory.
 *
 * The adviser runs with a shell and write access to the same tree pi is working
 * in, so pi needs to be able to say "this run touched these files" rather than
 * trusting the run's own prose. The event stream cannot answer that: dsh's
 * `--json` projection is owner-session scoped (`if (session !== agent.session)
 * return`), so tool calls made by the adviser's own subagents are filtered out
 * before pi ever sees them. Comparing the tree before and after the run sees
 * every write in the workspace regardless of which session made it.
 *
 * The comparison is by modification time, so it also reports a write pi made
 * concurrently during the run. That is a deliberate trade: a false positive is a
 * line of output, a false negative is an invisible edit.
 *
 * @module workspace
 */

import { readdirSync, statSync } from "node:fs"
import type { Dirent } from "node:fs"
import { join, relative, resolve } from "node:path"

/** Directories never walked: they are large, generated, or both. */
const SKIP_DIRS = new Set([".git", "node_modules", ".hg", ".svn", "dist", "build", ".next", ".cache", "target", "vendor"])

/** Hard ceiling on files visited, so a huge tree cannot stall a run. */
const MAX_ENTRIES = 20_000

/** Wall-clock budget for one walk. */
const MAX_DURATION_MS = 3_000

/** How many changed paths a report names before it summarises instead. */
const MAX_REPORTED = 50

/** One tree's file modification times, keyed by project-relative path. */
export interface WorkspaceSnapshot {
  /** Absolute paths and their modification times. */
  files: Map<string, number>
  /** False when the walk hit its entry or time budget and is therefore partial. */
  complete: boolean
  /** How many files were visited. */
  scanned: number
}

/** What a run changed, as far as a before/after comparison can tell. */
export interface WorkspaceChanges {
  /** Project-relative paths created, modified, or removed during the run. */
  files: string[]
  /** False when either snapshot was partial, so absence of a path means little. */
  complete: boolean
}

/**
 * Record every file's modification time under one directory.
 *
 * Symlinks are recorded but not followed, so a link into a large tree costs one
 * entry rather than a second walk.
 *
 * @param root - the directory to walk
 * @param now - clock, injected so tests are exact
 * @returns the snapshot, marked partial if a budget was reached
 */
export function snapshotWorkspace(root: string, now: () => number = Date.now): WorkspaceSnapshot {
  const files = new Map<string, number>()
  const deadline = now() + MAX_DURATION_MS
  let complete = true
  const walk = (dir: string): void => {
    if (!complete) return
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true, encoding: "utf8" })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue
        walk(full)
        if (!complete) return
        continue
      }
      try {
        files.set(full, statSync(full).mtimeMs)
      } catch {
        continue
      }
      if (files.size >= MAX_ENTRIES || now() > deadline) {
        complete = false
        return
      }
    }
  }
  walk(resolve(root))
  return { files, complete, scanned: files.size }
}

/**
 * Compare two snapshots of the same tree.
 *
 * @param before - the snapshot taken before the run
 * @param after - the snapshot taken after it
 * @param root - the directory both were taken from, so paths are reported relative to it
 * @returns the changed paths and whether the comparison is trustworthy
 */
export function changedSince(before: WorkspaceSnapshot, after: WorkspaceSnapshot, root: string): WorkspaceChanges {
  const changed = new Set<string>()
  const base = resolve(root)
  const report = (full: string): void => {
    const rel = relative(base, full)
    if (rel.length > 0 && !rel.startsWith("..")) changed.add(rel)
  }
  for (const [full, mtime] of after.files) {
    const previous = before.files.get(full)
    if (previous === undefined || previous !== mtime) report(full)
  }
  for (const full of before.files.keys()) {
    if (!after.files.has(full)) report(full)
  }
  const files = [...changed].sort()
  return {
    files: files.slice(0, MAX_REPORTED),
    complete: before.complete && after.complete,
  }
}

/**
 * Describe a change report in one sentence a caller can show or return.
 *
 * @param changes - what the comparison found
 * @returns a human-readable line, or undefined when nothing changed
 */
export function describeChanges(changes: WorkspaceChanges): string | undefined {
  if (changes.files.length === 0) return undefined
  const shown = changes.files.slice(0, 10).join(", ")
  const rest = changes.files.length - 10
  const list = rest > 0 ? `${shown}, and ${rest} more` : shown
  const caveat = changes.complete ? "" : " (partial scan: large or slow tree, so this list may be incomplete)"
  return `[adviser changed ${changes.files.length} file(s) in the project: ${list}]${caveat}`
}