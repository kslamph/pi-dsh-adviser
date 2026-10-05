/**
 * The per-project adviser session store.
 *
 * One project path owns one directory holding every adviser session that project has ever started,
 * so a session's memory belongs to the code it was about. Two distinct paths can never share a
 * store: the directory slug is a readable prefix plus a digest of the resolved path, because the
 * readable part alone collides (`/x/minimax.m3` and `/x/minimax-m3`).
 *
 * Writes are serialized in-process. Two pi processes in the same project may still race; the file
 * always stays valid JSON and the last writer wins, which is accepted rather than locked away.
 *
 * @module sessions
 */

import { createHash } from "node:crypto"
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { dshSessionsRoot } from "./config.ts"
import type { PermissionMode } from "./config.ts"

/** One adviser session, as recorded in the project's store. */
export interface SessionRecord {
  /** Per-project index; assigned at creation and never reused. */
  index: number
  /** dsh's own session id, which is what a follow-up resumes. */
  sessionId: string
  /** Slugified opening words of the task, so a listing is readable. */
  title: string
  /** Model the session runs on. */
  model: string
  /** File-permission mode dsh pinned into this session when it was created. */
  mode: PermissionMode
  /** ISO timestamp of creation. */
  createdAt: string
  /** ISO timestamp of the most recent use; drives pruning. */
  lastUsedAt: string
  /** How many runs this session has served, counting the one that created it. */
  runs: number
}

/** The persisted shape of a project's session list. */
interface StoreFile {
  projectPath: string
  nextIndex: number
  sessions: SessionRecord[]
}

/** A project's session store. */
export interface Project {
  /** Absolute project path this store belongs to. */
  readonly path: string
  /** Directory slug derived from the path. */
  readonly slug: string
  /** Record a new session and return it. */
  createSession(input: { sessionId: string; title: string; model: string; mode: PermissionMode }, now?: () => number): SessionRecord
  /** One session by index, or undefined. */
  get(index: number): SessionRecord | undefined
  /** The newest surviving session, or undefined. */
  latest(): SessionRecord | undefined
  /** Record a use of a session. */
  touch(index: number, now?: () => number): void
  /** Every session, ascending by index. */
  list(): SessionRecord[]
  /** Delete one session, its artifacts, and its run-log lines. */
  remove(index: number, options?: { purgeDsshSession?: boolean }): void
  /** Where a run's full answer is written. */
  artifactPath(index: number, runId: string): string
  /** Write a run's full answer. */
  writeArtifact(index: number, runId: string, text: string): string
  /** Append one observation line to this project's run log. */
  appendRunLog(record: Record<string, unknown>): void
}

/**
 * The readable half of a store's directory name.
 *
 * @param path - an absolute path
 * @returns its slug without a digest
 */
function readablePrefix(path: string): string {
  const middle = path.replace(/[^A-Za-z0-9.]+/g, "-").replace(/^-+|-+$/g, "")
  return `--${middle}`
}

/**
 * The directory name for a project path.
 *
 * The readable prefix keeps it debuggable; the digest suffix is what makes it injective.
 *
 * @param cwd - the project path
 * @returns its slug
 */
export function slugFor(cwd: string): string {
  const absolute = resolve(cwd)
  const digest = createHash("sha256").update(absolute).digest("hex").slice(0, 8)
  return `${readablePrefix(absolute)}-${digest}`
}

/**
 * The directory name dsh itself uses for a project's sessions.
 *
 * Reproduced here so deletion can find dsh's copy; it is dsh's encoding, not ours, and must not be
 * changed to match our slug. dsh turns path separators into dashes and keeps every other character,
 * so `/home/kslam/minimax.m3` becomes `--home-kslam-minimax.m3--`.
 *
 * @param cwd - the project path
 * @returns dsh's project directory name
 */
export function dshProjectSlug(cwd: string): string {
  return `--${resolve(cwd).replace(/^\/+/, "").replace(/\//g, "-")}--`
}
/**
 * Slugify a task into a short, readable session title.
 *
 * @param task - the opening task text
 * @returns at most four words joined by dashes
 */
function titleFor(task: string): string {
  const words = task.trim().toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((word) => word.length > 0)
  const slug = words.slice(0, 4).join("-")
  return slug.length > 0 ? slug : "session"
}

/**
 * The permission mode a session record was created under.
 *
 * Stores written before pi-dsh tracked the mode have no such field, and every one
 * of them ran under dsh's `workspace-write` default, so that is what a missing value
 * means rather than an error.
 *
 * @param record - a session record, old or new
 * @returns the mode the session is pinned to
 */
export function modeOf(record: SessionRecord): PermissionMode {
  return (record as { mode?: PermissionMode }).mode ?? "workspace-write"
}

/**
 * Open (or create) the session store for a project.
 *
 * @param cwd - the project path sessions belong to
 * @param projectsDir - root of the session stores; defaults to the configured location
 * @returns the project store
 */
export function openProject(cwd: string, projectsDir?: string): Project {
  const path = resolve(cwd)
  const slug = slugFor(path)
  const dir = join(projectsDir ?? defaultProjectsRoot(), slug)
  const storePath = join(dir, "sessions.json")
  const runsDir = join(dir, "runs")
  const runLog = join(dir, "runs.jsonl")

  /** Read the store, creating an empty one on first use. */
  function read(): StoreFile {
    if (!existsSync(storePath)) return { projectPath: path, nextIndex: 1, sessions: [] }
    let parsed: unknown
    try {
      parsed = JSON.parse(readFileSync(storePath, "utf8"))
    } catch {
      throw new Error(`pi-dsh: the session store at ${storePath} is not readable JSON. Move it aside to start fresh.`)
    }
    const store = parsed as StoreFile
    if (store.projectPath !== path) {
      throw new Error(
        `pi-dsh: ${storePath} belongs to a different project (${store.projectPath}), not ${path}.`
        + ` Refusing to use it; move that file aside.`,
      )
    }
    return store
  }

  /** Write the store back. */
  function write(store: StoreFile): void {
    mkdirSync(dir, { recursive: true })
    writeFileSync(storePath, `${JSON.stringify(store, null, 2)}\n`)
  }

  return {
    path,
    slug,

    createSession(input, now = Date.now) {
      const store = read()
      const timestamp = new Date(now()).toISOString()
      const record: SessionRecord = {
        index: store.nextIndex,
        sessionId: input.sessionId,
        title: input.title.length > 0 ? input.title : titleFor(input.sessionId),
        model: input.model,
        mode: input.mode,
        createdAt: timestamp,
        lastUsedAt: timestamp,
        runs: 1,
      }
      store.sessions.push(record)
      store.nextIndex += 1
      write(store)
      return record
    },

    get(index) {
      return read().sessions.find((session) => session.index === index)
    },

    latest() {
      const sessions = read().sessions
      return sessions.length === 0 ? undefined : sessions[sessions.length - 1]
    },

    touch(index, now = Date.now) {
      const store = read()
      const record = store.sessions.find((session) => session.index === index)
      if (record !== undefined) {
        record.lastUsedAt = new Date(now()).toISOString()
        record.runs += 1
        write(store)
      }
    },

    list() {
      return [...read().sessions].sort((a, b) => a.index - b.index)
    },

    remove(index, options = {}) {
      const store = read()
      const record = store.sessions.find((session) => session.index === index)
      if (record === undefined) return
      store.sessions = store.sessions.filter((session) => session.index !== index)
      write(store)
      // `nextIndex` deliberately stays where it is: an index is never reissued.
      for (const file of readdirOrEmpty(runsDir)) {
        if (file.startsWith(`${index}-`)) rmSync(join(runsDir, file), { force: true })
      }
      if (existsSync(runLog)) {
        const kept = readFileSync(runLog, "utf8")
          .split("\n")
          .filter((line) => line.trim().length === 0 || (JSON.parse(line) as { index?: number }).index !== index)
        writeFileSync(runLog, kept.length > 0 ? `${kept.join("\n")}\n` : "")
      }
      if (options.purgeDsshSession === true) purgeDshSession(path, record.sessionId)
    },

    artifactPath(index, runId) {
      return join(runsDir, `${index}-${runId}.md`)
    },

    writeArtifact(index, runId, text) {
      const path = join(runsDir, `${index}-${runId}.md`)
      mkdirSync(runsDir, { recursive: true })
      writeFileSync(path, text.endsWith("\n") ? text : `${text}\n`)
      return path
    },

    appendRunLog(record) {
      mkdirSync(dir, { recursive: true })
      appendFileSync(runLog, `${JSON.stringify(record)}\n`)
    },
  }
}

/**
 * Read a directory's entries, treating absence as empty.
 *
 * @param path - the directory to read
 * @returns its entry names, or an empty list
 */
function readdirOrEmpty(path: string): string[] {
  try {
    return readdirSync(path)
  } catch {
    return []
  }
}

/**
 * Where session stores live when the caller does not say.
 *
 * @returns the projects directory implied by the environment
 */
function defaultProjectsRoot(): string {
  const fromEnv = process.env.PI_DSH_PROJECTS_DIR
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv
  const home = process.env.HOME ?? process.env.USERPROFILE ?? ""
  return join(home, ".pi", "agent", "pi-dsh", "projects")
}

/**
 * Delete dsh's own copy of one session, refusing anything outside its project directory.
 *
 * @param projectPath - the project the session belongs to
 * @param sessionId - dsh's session id
 * @returns {void}
 */
function purgeDshSession(projectPath: string, sessionId: string): void {
  if (!/^session-[A-Za-z0-9-]+$/.test(sessionId)) {
    throw new Error(`pi-dsh: refusing to delete dsh session ${JSON.stringify(sessionId)}: the session id is not a dsh session name`)
  }
  const projectDir = resolve(dshSessionsRoot(), dshProjectSlug(projectPath))
  const target = resolve(projectDir, sessionId)
  const prefix = `${projectDir}/`
  if (!target.startsWith(prefix)) {
    throw new Error(`pi-dsh: refusing to delete ${target}: it is outside ${projectDir}`)
  }
  rmSync(target, { recursive: true, force: true })
}
