import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createHandlers } from "../handlers.ts"
import type { HandlerContext, HandlerDeps } from "../handlers.ts"
import { openProject, slugFor } from "../sessions.ts"
import type { RunResult } from "../runner.ts"
import type { DshConfig } from "../config.ts"

const NOW = 1_800_000_000_000

function harness(overrides: Partial<HandlerDeps> = {}, confirm = true) {
  const home = mkdtempSync(join(tmpdir(), "pi-dsh-handlers-"))
  // saveModel writes the user config file, so the test must own that path too, and seed it the
  // way a real user has one.
  process.env.PI_DSH_TEST_HOME = home
  process.env.DSH_HOME = join(home, "dsh")
  mkdirSync(join(home, ".pi", "agent", "pi-dsh"), { recursive: true })
  writeFileSync(
    join(home, ".pi", "agent", "pi-dsh", "config.json"),
    JSON.stringify({ providers: { demo: { apiKeyEnv: "DEMO_KEY", api: "openai-completions", baseURL: "https://example.invalid", models: [{ id: "demo-1" }] } }, model: { provider: "demo", id: "demo-1" } }, null, 2),
  )
  const cwd = join(home, "work", "project")
  const config: DshConfig = {
    dshProfile: "pi-advisor",
    dshPackage: "@deepseek-ai/dsh@0.2.0-rc.2",
    projectsDir: join(home, "projects"),
    providers: { demo: { apiKeyEnv: "DEMO_KEY", api: "openai-completions", baseURL: "https://example.invalid", models: [{ id: "demo-1" }] } },
    model: { provider: "demo", id: "demo-1" },
    timeoutMs: 1000,
    maxResultChars: 20000,
    pruneAfterHours: 168,
    purgeDsshSessions: false,
    permissionMode: "workspace-write",
    disabledTools: [],
    envAllowlist: [],
    dshProviders: [] as string[],
    modelSource: "config file" as const,
  }
  const runs: { task: string; sessionId?: string; env?: NodeJS.ProcessEnv; patchPaths?: string[] }[] = []
  let nextSession = 1
  const run = (async (options: { task: string; sessionId?: string; env?: NodeJS.ProcessEnv; patchPaths?: string[] }): Promise<RunResult> => {
    runs.push({
      task: options.task,
      ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
      ...(options.env === undefined ? {} : { env: options.env }),
      ...(options.patchPaths === undefined ? {} : { patchPaths: options.patchPaths }),
    })
    const sessionId = options.sessionId ?? `session-gen${nextSession++}`
    return {
      sessionId,
      text: "the answer",
      steps: 2,
      usage: { input: 1, output: 1, cacheRead: 0, totalTokens: 2 },
      outcome: "completed",
      durationMs: 1234,
      stderr: "",
    }
  }) as unknown as HandlerDeps["run"]

  const deps: HandlerDeps = {
    loadConfig: () => config,
    dshCommand: () => ({ command: "dsh", args: [], route: "path" }),
    run,
    ensureProfile: () => join(home, "dsh", "profiles", "pi-advisor", "cordis.patch.yml"),
    setModel: () => join(home, "dsh", "profiles", "pi-advisor", "cordis.patch.yml"),
    openProject: (path: string) => openProject(path, config.projectsDir),
    prune: () => 0,
    routes: () => ({ routes: [] }),
    now: () => NOW,
    ...overrides,
  }
  const messages: { level: string; text: string }[] = []
  const entries: { type: string; details: unknown }[] = []
  const ctx: HandlerContext = {
    cwd,
    notify: (text, level) => messages.push({ level, text }),
    setStatus: () => undefined,
    confirm: async () => confirm,
    appendEntry: (type, details) => entries.push({ type, details }),
  }
  const handlers = createHandlers(deps)
  return {
    handlers,
    /** Invoke a command by name, failing the test if no such command exists. */
    run: async (name: string, args: string) => {
      const handler = handlers[name]
      assert.ok(handler !== undefined, `no such command: ${name}`)
      await handler(args, ctx)
    },
    messages, entries, runs, ctx, deps, project: () => openProject(cwd, config.projectsDir), home, config, cwd,
  }
}

test("/dsh always starts a new session and announces its index", async () => {
  const h = harness()
  await h.run("dsh", "review the auth module")
  await h.run("dsh", "now the parser")
  assert.equal(h.runs.length, 2)
  assert.deepEqual(h.project().list().map((s) => s.index), [1, 2])
  assert.match(h.messages[0]!.text, /session #1 created — continue with \/dsh-follow #1 <text>/)
  assert.match(h.messages[1]!.text, /session #2 created — continue with \/dsh-follow #2 <text>/)
  assert.equal((h.entries[0]!.details as { index: number }).index, 1)
})

test("/dsh without a task explains its own usage", async () => {
  const h = harness()
  await h.run("dsh", "   ")
  assert.equal(h.runs.length, 0)
  assert.match(h.messages[0]!.text, /usage: \/dsh <task>/)
})

test("/dsh-follow with plain text continues the latest session", async () => {
  const h = harness()
  await h.run("dsh", "first task")
  await h.run("dsh-follow", "what about the cache?")
  assert.equal(h.runs[1]!.sessionId, "session-gen1")
  assert.equal(h.project().get(1)?.runs, 2, "the follow-up is recorded against the same session")
})

test("/dsh-follow accepts #N and bare N, and ignores a number that is part of the task", async () => {
  const h = harness()
  await h.run("dsh", "first")
  await h.run("dsh", "second")
  await h.run("dsh-follow", "#2 more about the second")
  assert.equal(h.runs[2]!.sessionId, "session-gen2")
  await h.run("dsh-follow", "1 and then some")
  assert.equal(h.runs[3]!.sessionId, "session-gen1")
  await h.run("dsh-follow", "2 reasons the login flow breaks")
  assert.equal(h.runs[4]!.sessionId, "session-gen2", "a leading number with more text is an index")
  assert.equal(h.runs[4]!.task, "reasons the login flow breaks", "the index is stripped from the task")
})

test("/dsh-follow with a bare number is a usage warning, not a run", async () => {
  const h = harness()
  await h.run("dsh", "first")
  const before = h.runs.length
  await h.run("dsh-follow", "2")
  assert.equal(h.runs.length, before)
  assert.match(h.messages.at(-1)!.text, /usage/i)
})

test("/dsh-follow with no sessions warns instead of running", async () => {
  const h = harness()
  await h.run("dsh-follow", "anything")
  assert.equal(h.runs.length, 0)
  assert.match(h.messages[0]!.text, /no adviser sessions yet/i)
  assert.match(h.messages[0]!.text, /\/dsh /)
})

test("/dsh-follow naming an unknown session lists the sessions instead of running", async () => {
  const h = harness()
  await h.run("dsh", "first")
  await h.run("dsh-follow", "#9 what now")
  assert.equal(h.runs.length, 1)
  assert.match(h.messages.at(-1)!.text, /\/dsh-sessions/)
})

test("every follow-up prunes with its explicit target protected", async () => {
  const calls: { protect?: number }[] = []
  const h = harness({ prune: (_project, _hours, options) => { calls.push({ ...(options?.protect === undefined ? {} : { protect: options.protect }) }); return 0 } })
  await h.run("dsh", "first")
  await h.run("dsh", "second")
  await h.run("dsh-follow", "#1 specific question")
  assert.deepEqual(calls[0], {}, "a plain /dsh protects nothing")
  assert.deepEqual(calls[1], {})
  assert.deepEqual(calls[2], { protect: 1 })
})

test("/dsh-sessions lists ascending with a latest marker", async () => {
  const h = harness()
  await h.run("dsh", "auth race review")
  await h.run("dsh", "fix the parser")
  h.messages.length = 0
  await h.run("dsh-sessions", "")
  const text = h.messages[0]!.text
  assert.match(text, /#1 auth-race-review/)
  assert.match(text, /#2 fix-the-parser/)
  assert.match(text, /← latest/)
  assert.ok(text.indexOf("#1") < text.indexOf("#2"), "ascending order")
})

test("/dsh-sessions on a fresh project says so plainly", async () => {
  const h = harness()
  await h.run("dsh-sessions", "")
  assert.match(h.messages[0]!.text, /no adviser sessions/i)
})

test("/dsh-delete asks first, and declining changes nothing", async () => {
  const declined = harness({}, false)
  await declined.run("dsh", "first")
  await declined.run("dsh-delete", "#1")
  assert.equal(declined.project().list().length, 1, "declined means untouched")
  assert.match(declined.messages.at(-1)!.text, /kept/i)

  const accepted = harness({}, true)
  await accepted.run("dsh", "first")
  await accepted.run("dsh-delete", "#1")
  assert.equal(accepted.project().list().length, 0)
  assert.match(accepted.messages.at(-1)!.text, /deleted/i)
})

test("/dsh-delete with an invalid index never prompts", async () => {
  let prompted = false
  const h = harness({})
  h.ctx.confirm = async () => { prompted = true; return true }
  await h.run("dsh", "first")
  await h.run("dsh-delete", "#7")
  assert.equal(prompted, false)
  assert.equal(h.project().list().length, 1)
})

test("/dsh-status reports the project, sessions, model, dsh profile, and resolved route", async () => {
  const h = harness()
  await h.run("dsh", "first")
  h.messages.length = 0
  await h.run("dsh-status", "")
  const text = h.messages[0]!.text
  assert.match(text, new RegExp(h.ctx.cwd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
  assert.match(text, /latest #1 "first"/)
  assert.match(text, /demo\/demo-1/)
  assert.match(text, /pi-advisor/)
  assert.match(text, /dsh/)
})

test("/dsh-model lists routes when called bare and reports an unknown provider", async () => {
  const h = harness()
  await h.run("dsh-model", "")
  assert.match(h.messages[0]!.text, /demo\/demo-1/)
  await h.run("dsh-model", "nope/model")
  assert.equal(h.messages.at(-1)!.level, "error")
  assert.match(h.messages.at(-1)!.text, /nope/)
})

test("/dsh-doctor reports each check in plain language", async () => {
  const h = harness()
  delete process.env.DEMO_KEY
  await h.run("dsh-doctor", "")
  const text = h.messages[0]!.text
  assert.match(text, /config/i)
  assert.match(text, /dsh/i)
  assert.match(text, /DEMO_KEY/)
  assert.doesNotMatch(text, /ENOENT|at Object/)
})

test("a failed run is reported without losing dsh's own words", async () => {
  const failing = Object.assign(new Error("pi-dsh: the dsh turn failed: model refused"), { name: "RunError" })
  const h = harness({ run: (() => { throw failing }) as unknown as HandlerDeps["run"] })
  await h.run("dsh", "do a thing")
  assert.equal(h.project().list().length, 0, "a failed run records no session")
  assert.equal(h.messages.at(-1)!.level, "error")
  assert.match(h.messages.at(-1)!.text, /model refused/)
})

test("the store lives under the project's slug, not a shared directory", async () => {
  const h = harness()
  await h.run("dsh", "first")
  assert.equal(h.project().slug, slugFor(h.ctx.cwd))
})

// Plugin-provided routes: dsh plugins register adapters pi-dsh cannot describe from its own config.

function pluginHarness(routes: { route: string; entryId: string; packageName: string; apiKeyEnv?: string }[], error?: string) {
  const h = harness({ routes: () => (error === undefined ? { routes } : { routes: [], error }) })
  return h
}

const ZEN = [
  { route: "zenfree", entryId: "llm-zenfree", packageName: "dsh-llm-zenfree", apiKeyEnv: "OPENCODE_API_KEY" },
  { route: "zenfree.res", entryId: "llm-zenfree", packageName: "dsh-llm-zenfree", apiKeyEnv: "OPENCODE_API_KEY" },
]

test("/dsh-model accepts a discovered plugin route and saves the choice", async () => {
  const h = pluginHarness(ZEN)
  await h.run("dsh-model", "zenfree/fledge-alpha-free")
  assert.equal(h.messages.at(-1)!.level, "info")
  assert.match(h.messages.at(-1)!.text, /zenfree\/fledge-alpha-free/)
  assert.match(h.messages.at(-1)!.text, /config\.json/)
  assert.match(h.messages.at(-1)!.text, /config\.json\.bak/)
})

test("/dsh-model accepts a dotted plugin route without mangling the model", async () => {
  const h = pluginHarness(ZEN)
  await h.run("dsh-model", "zenfree.res/some.model")
  assert.equal(h.messages.at(-1)!.level, "info")
  assert.match(h.messages.at(-1)!.text, /zenfree\.res\/some\.model/)
})

test("/dsh-model bare lists plugin routes under their own heading", async () => {
  const h = pluginHarness(ZEN)
  await h.run("dsh-model", "")
  const text = h.messages[0]!.text
  assert.match(text, /demo:/)
  assert.match(text, /routes from dsh plugins:/)
  assert.match(text, /zenfree\.res/)
  assert.match(text, /chosen at runtime/i)
})

test("/dsh-model reports discovery failure in one line rather than failing", async () => {
  const h = pluginHarness([], "dsh could not be asked about its plugins: ENOENT")
  await h.run("dsh-model", "")
  assert.match(h.messages[0]!.text, /ENOENT/)
  assert.doesNotMatch(h.messages[0]!.text, /at Object|Error:/)
})

test("/dsh-model rejects a route nobody provides and lists the known ones", async () => {
  const h = pluginHarness(ZEN)
  await h.run("dsh-model", "nowhere/some-model")
  assert.equal(h.messages.at(-1)!.level, "error")
  assert.match(h.messages.at(-1)!.text, /nowhere/)
  assert.match(h.messages.at(-1)!.text, /zenfree/)
})

test("a route declared in dshProviders works even when discovery found nothing", async () => {
  const h = pluginHarness([])
  ;(h as unknown as { config: DshConfig }).config.dshProviders = ["manual-route"]
  await h.run("dsh-model", "manual-route/whatever")
  assert.equal(h.messages.at(-1)!.level, "info")
})

test("a pi-ai provider still rejects a model it does not list, and changes nothing", async () => {
  const h = pluginHarness(ZEN)
  const before = h.messages.length
  await h.run("dsh-model", "demo/not-a-real-model")
  assert.equal(h.messages.at(-1)!.level, "error")
  assert.match(h.messages.at(-1)!.text, /not-a-real-model/)
  assert.ok(h.messages.length > before)
})

test("/dsh-doctor reports a plugin route's credential and discovery trouble", async () => {
  const h = pluginHarness(ZEN)
  delete process.env.OPENCODE_API_KEY
  await h.run("dsh-doctor", "")
  const text = h.messages[0]!.text
  assert.match(text, /OPENCODE_API_KEY/)
  assert.match(text, /zenfree/)

  const broken = pluginHarness([], "dsh could not be asked about its plugins: ENOENT")
  await broken.run("dsh-doctor", "")
  assert.match(broken.messages[0]!.text, /ENOENT/)
  assert.doesNotMatch(broken.messages[0]!.text, /at Object/)
})

test("/dsh-status reports the discovered route count and where the model came from", async () => {
  const h = pluginHarness(ZEN)
  await h.run("dsh-status", "")
  const text = h.messages[0]!.text
  assert.match(text, /routes:\s+2 from dsh plugins/)
  assert.match(text, /model:\s+demo\/demo-1 \(config file\)/)

  const broken = pluginHarness([], "nope")
  await broken.run("dsh-status", "")
  assert.match(broken.messages.at(-1)!.text, /routes: could not check/)
})

test("switching the model never touches a real user's configuration file", async () => {
  const h = pluginHarness(ZEN)
  await h.run("dsh-model", "zenfree/some-model")
  const { existsSync, readFileSync } = await import("node:fs")
  const { userConfigPath } = await import("../config.ts")
  assert.ok(userConfigPath().startsWith(h.home), "the write stayed inside the test home")
  assert.match(readFileSync(userConfigPath(), "utf8"), /zenfree/)
})

test("the mode reaches dsh as an explicit variable, not as whatever the shell happened to export", async () => {
  const h = harness()
  await h.run("dsh", "first")
  assert.equal(h.runs[0]!.env?.DSH_PERMISSION_MODE, "workspace-write")
  assert.equal(h.runs[0]!.env?.DEMO_KEY, process.env.DEMO_KEY, "the provider key still travels")

  process.env.DSH_PERMISSION_MODE = "read-only"
  try {
    await h.run("dsh", "second")
    assert.equal(h.runs[1]!.env?.DSH_PERMISSION_MODE, "read-only", "a person's export is honoured")
  } finally {
    delete process.env.DSH_PERMISSION_MODE
  }
})

test("a session records the mode it was created under, and /dsh-sessions shows it", async () => {
  const h = harness()
  await h.run("dsh", "first")
  h.messages.length = 0
  await h.run("dsh-sessions", "")
  assert.match(h.messages[0]!.text, /workspace-write/)
  assert.equal(h.project().get(1)?.mode, "workspace-write")
})

test("/dsh-follow refuses to re-permission a session, and says why", async () => {
  const h = harness()
  await h.run("dsh", "first")
  // The session was created workspace-write; only now does the configuration ask for read-only.
  h.deps.loadConfig = () => ({ ...h.config, permissionMode: "read-only" })
  const before = h.runs.length
  await h.run("dsh-follow", "now be writable")
  assert.equal(h.runs.length, before, "no run happened")
  assert.match(h.messages.at(-1)!.text, /pins a session's permissions/)
  assert.match(h.messages.at(-1)!.text, /Start a new one with \/dsh/)
})

test("the run reports which project files the adviser changed, including a write by its own subagent", async () => {
  // The fake run mutates the tree the way a real one would, from inside the run rather than
  // between two runs, which is the only window the before/after comparison covers.
  const { mkdirSync, writeFileSync } = await import("node:fs")
  const { join } = await import("node:path")
  const h = harness({
    run: (async (options: { cwd: string; task: string }) => {
      mkdirSync(join(options.cwd, "src"), { recursive: true })
      writeFileSync(join(options.cwd, "src", "written-by-adviser.md"), "hello")
      return {
        sessionId: `session-gen${h.runs.length + 1}`,
        text: "the answer",
        steps: 1,
        usage: { input: 1, output: 1, cacheRead: 0, totalTokens: 2 },
        outcome: "completed",
        durationMs: 1,
        stderr: "",
      }
    }) as unknown as HandlerDeps["run"],
  })
  await h.run("dsh", "first")
  assert.deepEqual((h.entries.at(-1)!.details as { filesChanged: string[] }).filesChanged, [join("src", "written-by-adviser.md")])
  assert.equal((h.entries.at(-1)!.details as { changeScanComplete: boolean }).changeScanComplete, true)
})

test("a truncated answer names the file the rest of it is in", async () => {
  const h = harness()
  h.deps.loadConfig = () => ({ ...h.config, maxResultChars: 5 })
  await h.run("dsh", "first")
  const text = h.entries.at(-1)!.details as { artifactPath: string; truncated: boolean }
  assert.equal(text.truncated, true)
  assert.equal(text.artifactPath.endsWith(".md"), true)
})

test("/dsh-status names the mode, the pinned modes, and what is disabled", async () => {
  const h = harness()
  h.deps.loadConfig = () => ({ ...h.config, disabledTools: ["tool-web"] })
  await h.run("dsh", "first")
  h.messages.length = 0
  await h.run("dsh-status", "")
  const text = h.messages[0]!.text
  assert.match(text, /mode:\s+workspace-write for new sessions/)
  assert.match(text, /pinned:\s+workspace-write/)
  assert.match(text, /disabled:\s+tool-web/)
  assert.match(text, /env:\s+\d+ variables forwarded/)
})

test("/dsh-doctor reports the mode, and warns when it is danger-full-access", async () => {
  const safe = harness()
  await safe.run("dsh-doctor", "")
  assert.match(safe.messages[0]!.text, /mode for new sessions is workspace-write/)
  assert.doesNotMatch(safe.messages[0]!.text, /DSH_PERMISSION_MODE changes that/, "the stale note is gone")

  const wide = harness()
  wide.deps.loadConfig = () => ({ ...wide.config, permissionMode: "danger-full-access" })
  await wide.run("dsh-doctor", "")
  assert.match(wide.messages[0]!.text, /danger-full-access/)
})

test("/dsh-doctor says which credentials it withholds from the adviser, and spares the ones it forwards", async () => {
  const h = harness()
  process.env.PI_DSH_TEST_SECRET_TOKEN = "hunter2"
  try {
    await h.run("dsh-doctor", "")
    const note = h.messages[0]!.text.split("\n").find((line) => /credential-like/.test(line)) ?? ""
    assert.match(note, /not forwarded to dsh/)
    assert.match(note, /envAllowlist/, "and how to forward one deliberately")
    assert.doesNotMatch(note, /DEMO_KEY/, "the provider's own key is forwarded, so it is not reported as withheld")
  } finally {
    delete process.env.PI_DSH_TEST_SECRET_TOKEN
  }
})

test("/dsh-doctor names the config file and the caveat when a plugin route's key is withheld", async () => {
  const h = pluginHarness([{ route: "zenfree", entryId: "llm-zenfree", packageName: "dsh-llm-zenfree", apiKeyEnv: "OPENCODE_API_KEY" }])
  await h.run("dsh-doctor", "")
  const fail = h.messages[0]!.text.split("\n").find((line) => /not in envAllowlist/.test(line)) ?? ""
  assert.match(fail, /route zenfree needs OPENCODE_API_KEY/, "it names the route and the variable")
  assert.match(fail, /\/dsh-model at zenfree/, "and says when the route becomes reachable, so the flag reads as harmless")
  assert.match(fail, /"envAllowlist" in .*pi-dsh\/config\.json$/, "and says which file to edit")
})

test("every run re-supplies the session's own mode, because that is what dsh records", async () => {
  // Measured against dsh 0.2.0-rc.2: a session created read-only and then continued by a process
  // exporting workspace-write had *the follow-up's* value written into its log and was writable
  // from then on. Whoever supplies the mode on each run decides what the session becomes.
  const h = harness()
  await h.run("dsh", "first")
  assert.equal(h.runs[0]!.env?.DSH_PERMISSION_MODE, "workspace-write")
  await h.run("dsh-follow", "and again")
  assert.equal(h.runs[1]!.sessionId, "session-gen1")
  assert.equal(h.runs[1]!.env?.DSH_PERMISSION_MODE, "workspace-write", "the resumed session runs under its own mode")

  h.deps.loadConfig = () => ({ ...h.config, permissionMode: "read-only" })
  await h.run("dsh", "second")
  assert.equal(h.runs[2]!.env?.DSH_PERMISSION_MODE, "read-only", "a new session takes the configured mode")
  assert.equal(h.project().get(2)?.mode, "read-only")

  h.deps.loadConfig = () => ({ ...h.config, permissionMode: "workspace-write" })
  const before = h.runs.length
  await h.run("dsh-follow", "#2 widen me")
  assert.equal(h.runs.length, before, "widening a session is refused, not performed")
  assert.match(h.messages.at(-1)!.text, /pins a session's permissions/)
})
