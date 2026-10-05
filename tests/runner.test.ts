import { test } from "node:test"
import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { adviserEnv, run } from "../runner.ts"
import type { DshCommand } from "../resolve.ts"
import type { RunResult } from "../runner.ts"

/** A fake child process that emits a scripted event stream. */
function fakeChild(lines: string[]): EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: () => void } {
  const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill: () => void }
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.kill = () => undefined
  queueMicrotask(() => {
    for (const line of lines) child.stdout.write(`${line}\n`)
    child.stdout.end()
    child.emit("close", 0)
  })
  return child
}

/** Record what was spawned and return a child that reports a successful one-step run. */
function recordingSpawner(calls: { command: string; args: string[] }[], envs?: NodeJS.ProcessEnv[]) {
  return ((command: string, args: string[], options?: { env?: NodeJS.ProcessEnv }) => {
    calls.push({ command, args })
    envs?.push(options?.env ?? {})
    return fakeChild([
      JSON.stringify({ type: "session", sessionId: "session-abc" }),
      JSON.stringify({ type: "status", phase: "step_end", step: 2, usage: { inputTokens: 10, outputTokens: 4, totalTokens: 30 } }),
      JSON.stringify({ type: "status", phase: "turn_end", reason: { kind: "completed" } }),
      JSON.stringify({ type: "final", text: "the answer" }),
    ]) as never
  }) as never
}

const base = { profile: "pi-advisor", cwd: "/tmp", task: "do the thing", timeoutMs: 5000 }

test("a plain run spawns dsh with the profile, json, and task flags", async () => {
  const calls: { command: string; args: string[] }[] = []
  const result: RunResult = await run({ ...base, dshCommand: { command: "dsh", args: [], route: "path" }, spawnFn: recordingSpawner(calls) })
  assert.deepEqual(calls, [{ command: "dsh", args: ["--profile", "pi-advisor", "--json", "--", "do the thing"] }])
  assert.equal(result.sessionId, "session-abc")
  assert.equal(result.text, "the answer")
  assert.equal(result.steps, 2)
  assert.equal(result.usage.totalTokens, 30)
})

test("the npx route puts its leading arguments before the dsh flags", async () => {
  const calls: { command: string; args: string[] }[] = []
  const command: DshCommand = { command: "npx", args: ["-y", "@deepseek-ai/dsh@0.2.0-rc.2"], route: "npx" }
  await run({ ...base, dshCommand: command, spawnFn: recordingSpawner(calls) })
  assert.deepEqual(calls, [{
    command: "npx",
    args: ["-y", "@deepseek-ai/dsh@0.2.0-rc.2", "--profile", "pi-advisor", "--json", "--", "do the thing"],
  }])
})

test("a resumed run passes the session id before the task", async () => {
  const calls: { command: string; args: string[] }[] = []
  await run({ ...base, sessionId: "session-xyz", spawnFn: recordingSpawner(calls) })
  assert.deepEqual(calls[0]?.args, ["--profile", "pi-advisor", "--json", "--session-id", "session-xyz", "--", "do the thing"])
})

test("the default command is dsh on PATH", async () => {
  const calls: { command: string; args: string[] }[] = []
  await run({ ...base, spawnFn: recordingSpawner(calls) })
  assert.equal(calls[0]?.command, "dsh")
})

test("an error outcome still raises a RunError carrying dsh's own text", async () => {
  const spawnFn = (() => fakeChild([
    JSON.stringify({ type: "status", phase: "turn_end", reason: { kind: "error" } }),
    JSON.stringify({ type: "final", text: "the model refused" }),
  ])) as never
  await assert.rejects(() => run({ ...base, spawnFn }), /the model refused/)
})

test("capability overlays are passed as --patch before the profile flags", async () => {
  const calls: { command: string; args: string[] }[] = []
  await run({ ...base, patchPaths: ["/tmp/off.yml", "/tmp/also-off.yml"], spawnFn: recordingSpawner(calls) })
  assert.deepEqual(calls[0]?.args, [
    "--patch", "/tmp/off.yml", "--patch", "/tmp/also-off.yml",
    "--profile", "pi-advisor", "--json", "--", "do the thing",
  ])
})

test("the child is scrubbed: only the allowlist and the named extras are forwarded", () => {
  const env = adviserEnv(["DEMO_KEY", "OPENCODE_API_KEY"], {
    PATH: "/usr/bin",
    HOME: "/home/user",
    DEMO_KEY: "keep-me",
    OPENCODE_API_KEY: "keep-me-too",
    DSH_HOME: "/home/user/.dsh",
    PI_DSH_DSH_PROFILE: "pi-advisor",
    npm_config_registry: "https://registry.npmjs.org",
    AWS_SECRET_ACCESS_KEY: "must-not-travel",
    GITHUB_TOKEN: "must-not-travel",
    OPENAI_API_KEY: "must-not-travel",
    SSH_AUTH_SOCK: "/tmp/agent.sock",
    EMPTY: undefined,
  })
  assert.deepEqual(env, {
    PATH: "/usr/bin",
    HOME: "/home/user",
    DEMO_KEY: "keep-me",
    OPENCODE_API_KEY: "keep-me-too",
    DSH_HOME: "/home/user/.dsh",
    PI_DSH_DSH_PROFILE: "pi-advisor",
    npm_config_registry: "https://registry.npmjs.org",
  })
})

test("a key the adviser needs but pi cannot infer is dropped unless it is named", () => {
  const source = { PATH: "/usr/bin", OPENCODE_API_KEY: "plugin-key" }
  assert.equal(adviserEnv([], source).OPENCODE_API_KEY, undefined, "not forwarded by default")
  assert.equal(adviserEnv(["OPENCODE_API_KEY"], source).OPENCODE_API_KEY, "plugin-key", "forwarded once named")
})

test("a run passes its own environment to the child rather than pi's", async () => {
  const calls: { command: string; args: string[] }[] = []
  const envs: NodeJS.ProcessEnv[] = []
  process.env.PI_DSH_LEAK_CANARY = "leaked"
  try {
    await run({ ...base, env: adviserEnv([], { PATH: "/usr/bin", PI_DSH_LEAK_CANARY: "leaked" }), spawnFn: recordingSpawner(calls, envs) })
    assert.deepEqual(envs[0], { PATH: "/usr/bin", PI_DSH_LEAK_CANARY: "leaked" }, "the allowlisted names travel and nothing else does")
  } finally {
    delete process.env.PI_DSH_LEAK_CANARY
  }
})
