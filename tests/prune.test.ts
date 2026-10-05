import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { openProject, slugFor, dshProjectSlug } from "../sessions.ts"
import { pruneExpired } from "../prune.ts"

const HOUR = 3_600_000
const NOW = 1_800_000_000_000

function setup(): { projectsDir: string; dshHome: string; cwd: string } {
  const home = mkdtempSync(join(tmpdir(), "pi-dsh-prune-"))
  process.env.DSH_HOME = join(home, "dsh")
  const projectsDir = join(home, "projects")
  const cwd = join(home, "work", "project")
  mkdirSync(cwd, { recursive: true })
  return { projectsDir, dshHome: process.env.DSH_HOME, cwd }
}

/**
 * A project holding four sessions: #1 exactly at the boundary, #2 just under it, #3 just over it,
 * and #4 long expired but still the latest, so it is exempt.
 */
function agedSessions(projectsDir: string, cwd: string) {
  process.env.PI_DSH_PROJECTS_DIR = projectsDir
  const project = openProject(cwd, projectsDir)
  project.createSession({ sessionId: "session-at", title: "exactly at the boundary", model: "demo/m1" }, () => NOW - 168 * HOUR)
  project.createSession({ sessionId: "session-under", title: "just under the boundary", model: "demo/m1" }, () => NOW - 168 * HOUR + 60_000)
  project.createSession({ sessionId: "session-over", title: "just over the boundary", model: "demo/m1" }, () => NOW - 168 * HOUR - 60_000)
  project.createSession({ sessionId: "session-old-latest", title: "ancient but latest", model: "demo/m1" }, () => NOW - 1000 * HOUR)
  return project
}

test("only sessions strictly older than the threshold are pruned", () => {
  const { projectsDir, cwd } = setup()
  const project = agedSessions(projectsDir, cwd)
  const removed = pruneExpired(project, 168, { now: () => NOW })
  assert.equal(removed, 1)
  assert.deepEqual(project.list().map((s) => s.index), [1, 2, 4])
  assert.equal(project.get(1)?.title, "exactly at the boundary", "exactly at the threshold survives")
  assert.equal(project.get(2)?.title, "just under the boundary")
  assert.equal(project.get(4)?.title, "ancient but latest", "the latest session is exempt")
})

test("the latest session is never pruned, even when long idle", () => {
  const { projectsDir, cwd } = setup()
  const project = agedSessions(projectsDir, cwd)
  // Make every session old enough, then confirm the newest one is still spared.
  const store = join(projectsDir, slugFor(cwd), "sessions.json")
  const parsed = JSON.parse(readFileSync(store, "utf8"))
  for (const session of parsed.sessions) session.lastUsedAt = new Date(NOW - 1000 * HOUR).toISOString()
  writeFileSync(store, JSON.stringify(parsed, null, 2))

  const removed = pruneExpired(project, 168, { now: () => NOW })
  assert.equal(removed, 3)
  assert.deepEqual(project.list().map((s) => s.index), [4])
})

test("an explicitly targeted session survives this invocation's prune even when expired", () => {
  const { projectsDir, cwd } = setup()
  const project = agedSessions(projectsDir, cwd)
  const removed = pruneExpired(project, 168, { protect: 3, now: () => NOW })
  assert.equal(removed, 0, "the only session past the threshold is the protected target")
  assert.equal(project.get(3)?.index, 3, "the named target survives its own expiry")
})

test("a protected expired session survives while its unprotected expired siblings go", () => {
  const { projectsDir, cwd } = setup()
  const project = agedSessions(projectsDir, cwd)
  const removed = pruneExpired(project, 168, { protect: 1, now: () => NOW })
  assert.equal(removed, 1, "session 3 was over the threshold; session 1 is protected; session 2 is under it")
  assert.equal(project.get(1)?.index, 1)
  assert.equal(project.get(3), undefined)
})

test("zero disables pruning entirely", () => {
  const { projectsDir, cwd } = setup()
  const project = agedSessions(projectsDir, cwd)
  const removed = pruneExpired(project, 0, { now: () => NOW })
  assert.equal(removed, 0)
  assert.equal(project.list().length, 4)
})

test("pruning removes artifacts, run-log lines, and the dsh copy when asked", () => {
  const { projectsDir, dshHome, cwd } = setup()
  const project = agedSessions(projectsDir, cwd)
  const keepArtifact = project.artifactPath(2, "run-a")
  const dropArtifact = project.artifactPath(3, "run-b")
  project.writeArtifact(2, "run-a", "keep me")
  project.writeArtifact(3, "run-b", "drop me")
  project.appendRunLog({ index: 2, outcome: "completed" })
  project.appendRunLog({ index: 3, outcome: "completed" })
  const dshDir = join(dshHome, "sessions", dshProjectSlug(cwd))
  mkdirSync(join(dshDir, "session-over"), { recursive: true })
  mkdirSync(join(dshDir, "session-under"), { recursive: true })

  pruneExpired(project, 168, { purgeDsshSession: true, now: () => NOW })

  assert.ok(!existsSync(dropArtifact))
  assert.ok(existsSync(keepArtifact))
  const lines = readFileSync(join(projectsDir, slugFor(cwd), "runs.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l))
  assert.deepEqual(lines, [{ index: 2, outcome: "completed" }])
  assert.ok(!existsSync(join(dshDir, "session-over")), "the pruned session's dsh copy is gone")
  assert.ok(existsSync(join(dshDir, "session-under")), "its sibling survives")
  assert.equal(project.list().length, 3, "no index was invented and nothing else went")
})

test("the dsh copy is left alone by default", () => {
  const { projectsDir, dshHome, cwd } = setup()
  const project = agedSessions(projectsDir, cwd)
  const dshDir = join(dshHome, "sessions", dshProjectSlug(cwd))
  mkdirSync(join(dshDir, "session-over"), { recursive: true })
  pruneExpired(project, 168, { now: () => NOW })
  assert.ok(existsSync(join(dshDir, "session-over")))
})
