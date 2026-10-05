import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createAdvise } from "../advise.ts"
import type { AdviseDeps } from "../advise.ts"
import { openProject } from "../sessions.ts"
import type { DshConfig } from "../config.ts"

function harness() {
  const home = mkdtempSync(join(tmpdir(), "pi-dsh-advise-"))
  process.env.DSH_HOME = join(home, "dsh")
  const cwd = join(home, "work", "project")
  mkdirSync(cwd, { recursive: true })
  const config: DshConfig = {
    dshProfile: "pi-advisor",
    dshPackage: "@deepseek-ai/dsh@0.2.0-rc.2",
    projectsDir: join(home, "projects"),
    providers: {},
    model: { provider: "demo", id: "demo-1" },
    timeoutMs: 1000,
    maxResultChars: 20000,
    pruneAfterHours: 168,
    purgeDsshSessions: false,
    dshProviders: [],
    modelSource: "config file" as const,
  }
  let generated = 0
  const deps: AdviseDeps = {
    loadConfig: () => config,
    dshCommand: () => ({ command: "dsh", args: [], route: "path" }),
    run: (async (options: { sessionId?: string }) => ({
      sessionId: options.sessionId ?? `session-gen${++generated}`,
      text: "the answer",
      steps: 1,
      usage: { input: 1, output: 1, cacheRead: 0, totalTokens: 2 },
      outcome: "completed",
      durationMs: 5,
      stderr: "",
    })) as unknown as AdviseDeps["run"],
    ensureProfile: () => "patch.yml",
    openProject: (path: string) => openProject(path, config.projectsDir),
    prune: () => 0,
    routes: () => ({ routes: [] }),
    setModel: () => "patch.yml",
    now: () => 1_800_000_000_000,
  }
  return { deps, cwd, project: () => openProject(cwd, config.projectsDir) }
}

test("without followUp the tool starts a new session and reports its index", async () => {
  const h = harness()
  const advise = createAdvise(h.deps)
  const result = await advise({ task: "study the scheduler" }, h.cwd)
  assert.equal(result.details.index, 1)
  assert.match(result.text, /#1/)
  assert.equal(h.project().list().length, 1)
})

test("followUp continues the latest session", async () => {
  const h = harness()
  const advise = createAdvise(h.deps)
  await advise({ task: "first" }, h.cwd)
  await advise({ task: "second" }, h.cwd)
  const result = await advise({ task: "what about the first?", followUp: true }, h.cwd)
  assert.equal(result.details.index, 2, "the latest is session 2")
  assert.equal(result.details.sessionId, "session-gen2")
})

test("sessionIndex selects a specific session of this project", async () => {
  const h = harness()
  const advise = createAdvise(h.deps)
  await advise({ task: "first" }, h.cwd)
  await advise({ task: "second" }, h.cwd)
  const result = await advise({ task: "back to the first", followUp: true, sessionIndex: 1 }, h.cwd)
  assert.equal(result.details.index, 1)
  assert.equal(result.details.sessionId, "session-gen1")
})

test("an unknown sessionIndex fails with the valid indices and the command to see them", async () => {
  const h = harness()
  const advise = createAdvise(h.deps)
  await advise({ task: "first" }, h.cwd)
  await assert.rejects(
    () => advise({ task: "nope", followUp: true, sessionIndex: 9 }, h.cwd),
    (error: Error) => {
      assert.match(error.message, /session #9/)
      assert.match(error.message, /#1/)
      assert.match(error.message, /\/dsh-sessions/)
      return true
    },
  )
})

test("followUp with no sessions at all says how to start one", async () => {
  const h = harness()
  const advise = createAdvise(h.deps)
  await assert.rejects(
    () => advise({ task: "hello?", followUp: true }, h.cwd),
    /no adviser sessions yet/i,
  )
})

test("two projects keep separate sessions", async () => {
  const h = harness()
  const other = join(h.cwd, "..", "other")
  mkdirSync(other, { recursive: true })
  const advise = createAdvise(h.deps)
  await advise({ task: "in project one" }, h.cwd)
  const elsewhere = await advise({ task: "in project two" }, other)
  assert.equal(elsewhere.details.index, 1, "the other project's store starts at 1")
  assert.equal(h.project().list()[0]?.title, "in-project-one")
})

test("a run's artifact is named after the session index it belongs to", async () => {
  const h = harness()
  const advise = createAdvise(h.deps)
  const result = await advise({ task: "first" }, h.cwd)
  assert.match(result.details.artifactPath, /\/runs\/1-\d+\.md$/, "artifacts carry the session index, never 0")
  const project = h.project()
  project.remove(1)
  const { existsSync } = await import("node:fs")
  assert.equal(existsSync(result.details.artifactPath), false, "deleting the session takes its artifact with it")
})
