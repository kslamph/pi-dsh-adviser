import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { modeOf, openProject, slugFor, dshProjectSlug } from "../sessions.ts"

function setup(): { projectsDir: string; dshHome: string; cwd: string } {
  const home = mkdtempSync(join(tmpdir(), "pi-dsh-store-"))
  process.env.DSH_HOME = join(home, "dsh")
  const projectsDir = join(home, "projects")
  const cwd = join(home, "work", "project")
  mkdirSync(cwd, { recursive: true })
  return { projectsDir, dshHome: process.env.DSH_HOME, cwd }
}

function open(projectsDir: string, cwd: string) {
  process.env.PI_DSH_PROJECTS_DIR = projectsDir
  return openProject(cwd)
}

/** Seed dsh's own session tree so purge has something real to remove. */
function seedDshSession(dshHome: string, cwd: string, sessionIds: string[]): string {
  const dir = join(dshHome, "sessions", dshProjectSlug(cwd))
  mkdirSync(dir, { recursive: true })
  for (const id of sessionIds) {
    mkdirSync(join(dir, id), { recursive: true })
    writeFileSync(join(dir, id, "log.jsonl"), "{}\n")
  }
  return dir
}

test("slugs are readable and injective: dot and dash paths never collide", () => {
  const a = slugFor("/x/minimax.m3")
  const b = slugFor("/x/minimax-m3")
  assert.notEqual(a, b)
  assert.ok(a.startsWith("--x-minimax"), a)
  assert.equal(slugFor("/x/project"), slugFor("/x/project"))
})

test("dsh's own session directory name is reproduced exactly, so purge can find it", () => {
  assert.equal(dshProjectSlug("/home/kslam/minimax.m3"), "--home-kslam-minimax.m3--")
  assert.equal(dshProjectSlug("/home/kslam/piext/pi-dsh"), "--home-kslam-piext-pi-dsh--")
})

test("indices start at 1, increase, and are never reused after a delete", () => {
  const { projectsDir, cwd } = setup()
  const project = open(projectsDir, cwd)
  const first = project.createSession({ sessionId: "session-1", title: "auth-race-review", model: "demo/m1", mode: "workspace-write" })
  const second = project.createSession({ sessionId: "session-2", title: "fix-parser", model: "demo/m1", mode: "workspace-write" })
  assert.equal(first.index, 1)
  assert.equal(second.index, 2)
  project.remove(1)
  const third = project.createSession({ sessionId: "session-3", title: "later", model: "demo/m1", mode: "workspace-write" })
  assert.equal(third.index, 3, "nextIndex never rewinds")
  assert.equal(project.get(2)?.index, 2, "existing indices are untouched")
  assert.equal(project.get(1), undefined)
})

test("the latest session is the newest surviving one after a delete", () => {
  const { projectsDir, cwd } = setup()
  const project = open(projectsDir, cwd)
  project.createSession({ sessionId: "session-1", title: "one", model: "demo/m1", mode: "workspace-write" })
  project.createSession({ sessionId: "session-2", title: "two", model: "demo/m1", mode: "workspace-write" })
  assert.equal(project.latest()?.index, 2)
  project.remove(2)
  assert.equal(project.latest()?.index, 1)
})

test("deleting a session removes its artifacts and its run-log lines only", () => {
  const { projectsDir, cwd } = setup()
  const project = open(projectsDir, cwd)
  project.createSession({ sessionId: "session-1", title: "one", model: "demo/m1", mode: "workspace-write" })
  project.createSession({ sessionId: "session-2", title: "two", model: "demo/m1", mode: "workspace-write" })
  const keep = project.artifactPath(2, "run-a")
  const drop = project.artifactPath(1, "run-b")
  project.writeArtifact(1, "run-b", "answer one")
  project.writeArtifact(2, "run-a", "answer two")
  project.appendRunLog({ index: 1, outcome: "completed" })
  project.appendRunLog({ index: 2, outcome: "completed" })

  project.remove(1)

  assert.ok(!existsSync(drop), "the deleted session's artifact is gone")
  assert.ok(existsSync(keep), "the surviving session's artifact is untouched")
  const lines = readFileSync(join(projectsDir, slugFor(cwd), "runs.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line))
  assert.deepEqual(lines, [{ index: 2, outcome: "completed" }])
})

test("purge removes exactly the target session's dsh directory, never a sibling or the slug dir", () => {
  const { projectsDir, dshHome, cwd } = setup()
  const project = open(projectsDir, cwd)
  project.createSession({ sessionId: "session-aaa", title: "one", model: "demo/m1", mode: "workspace-write" })
  project.createSession({ sessionId: "session-bbb", title: "two", model: "demo/m1", mode: "workspace-write" })
  const dir = seedDshSession(dshHome, cwd, ["session-aaa", "session-bbb"])

  project.remove(1, { purgeDsshSession: true })

  assert.ok(!existsSync(join(dir, "session-aaa")), "the deleted session's dsh directory is gone")
  assert.ok(existsSync(join(dir, "session-bbb")), "its sibling survives")
  assert.ok(existsSync(dir), "the shared project directory survives")
})

test("a session id that escapes the project directory is refused and removes nothing", () => {
  const { projectsDir, dshHome, cwd } = setup()
  const project = open(projectsDir, cwd)
  project.createSession({ sessionId: "../../etc", title: "evil", model: "demo/m1", mode: "workspace-write" })
  const dir = seedDshSession(dshHome, cwd, [])
  assert.throws(() => project.remove(1, { purgeDsshSession: true }), /session id/i)
  assert.ok(existsSync(dir))
})

test("reopening a store from a different path is reported instead of silently used", () => {
  const { projectsDir, cwd } = setup()
  open(projectsDir, cwd).createSession({ sessionId: "session-1", title: "one", model: "demo/m1", mode: "workspace-write" })
  const elsewhere = join(cwd, "..", "other")
  mkdirSync(elsewhere, { recursive: true })
  // A different project gets a different slug, so no store is shared at all.
  assert.notEqual(slugFor(cwd), slugFor(elsewhere))
  assert.throws(() => {
    const project = open(projectsDir, cwd)
    project.createSession({ sessionId: "session-2", title: "two", model: "demo/m1", mode: "workspace-write" })
    const tampered = join(projectsDir, slugFor(cwd), "sessions.json")
    writeFileSync(tampered, JSON.stringify({ projectPath: "/somewhere/else", nextIndex: 9, sessions: [] }))
    project.list()
  }, /different project|does not match/i)
})

test("concurrent session creation yields distinct indices and valid JSON", async () => {
  const { projectsDir, cwd } = setup()
  const project = open(projectsDir, cwd)
  await Promise.all(
    Array.from({ length: 8 }, (_unused, i) =>
      Promise.resolve().then(() => project.createSession({ sessionId: `session-${i}`, title: `t${i}`, model: "demo/m1", mode: "workspace-write" })),
    ),
  )
  const indices = project.list().map((session) => session.index).sort((a, b) => a - b)
  assert.deepEqual(indices, [1, 2, 3, 4, 5, 6, 7, 8])
  const store = JSON.parse(readFileSync(join(projectsDir, slugFor(cwd), "sessions.json"), "utf8"))
  assert.equal(store.nextIndex, 9)
  assert.equal(store.projectPath, cwd)
})

test("touch records use without creating a session", () => {
  const { projectsDir, cwd } = setup()
  const project = open(projectsDir, cwd)
  project.createSession({ sessionId: "session-1", title: "one", model: "demo/m1", mode: "workspace-write" })
  const before = project.get(1)?.lastUsedAt
  project.touch(1, () => 1_800_000_000_000)
  assert.equal(project.get(1)?.lastUsedAt, new Date(1_800_000_000_000).toISOString())
  assert.notEqual(project.get(1)?.lastUsedAt, before)
  assert.equal(project.list().length, 1)
  assert.ok(!existsSync(join(projectsDir, slugFor(cwd), "runs")), "no runs directory until an artifact is written")
})

test("a session records the mode it was created under", () => {
  const s = setup()
  const project = open(s.projectsDir, s.cwd)
  const record = project.createSession({ sessionId: "session-a", title: "t", model: "demo/demo-1", mode: "read-only" })
  assert.equal(record.mode, "read-only")
  assert.equal(modeOf(project.get(1)!), "read-only", "and it survives a reopen")
})

test("a store written before modes were tracked reads as workspace-write, not as an error", () => {
  const s = setup()
  const project = open(s.projectsDir, s.cwd)
  project.createSession({ sessionId: "session-a", title: "t", model: "demo/demo-1", mode: "workspace-write" })
  // Every session predating this field was created under dsh's workspace-write default, so that
  // is what a missing value means: refusing to continue would strand real history.
  const path = join(s.projectsDir, project.slug, "sessions.json")
  const store = JSON.parse(readFileSync(path, "utf8")) as { sessions: Record<string, unknown>[] }
  delete store.sessions[0]!.mode
  writeFileSync(path, JSON.stringify(store, null, 2))
  assert.equal(modeOf(open(s.projectsDir, s.cwd).get(1)!), "workspace-write")
})
