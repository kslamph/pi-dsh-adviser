import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { discoverDshRoutes, dshRoutesFor, resetDshRouteCache } from "../dshRoutes.ts"
import { resetDshCommandCache } from "../resolve.ts"
import { fakeDshPathDir, withPath } from "./helpers.ts"
import type { DshConfig } from "../config.ts"

const fixture = readFileSync(
  join(dirname(new URL(import.meta.url).pathname), "fixtures", "zenfree-schema.json"),
  "utf8",
)

function config(overrides: Partial<DshConfig> = {}): DshConfig {
  return {
    dshProfile: "pi-advisor",
    dshPackage: "@deepseek-ai/dsh@0.2.0-rc.2",
    projectsDir: "/tmp/whatever",
    providers: {},
    model: { provider: "demo", id: "demo-1" },
    timeoutMs: 1,
    maxResultChars: 1,
    pruneAfterHours: 1,
    purgeDsshSessions: false,
    permissionMode: "workspace-write",
    disabledTools: [],
    envAllowlist: [],
    dshProviders: [],
    modelSource: "config file" as const,
    ...overrides,
  }
}

/** A spawnSync stand-in returning a scripted result. */
function spawner(result: unknown, calls: { command: string; args: string[] }[] = []) {
  return ((command: string, args: string[]) => {
    calls.push({ command, args })
    return result
  }) as never
}

const ok = (stdout: string) => ({ status: 0, stdout, stderr: "" })

test("a plugin entry contributes every route it serves, including a dotted one", () => {
  const result = discoverDshRoutes(config(), spawner(ok(fixture)))
  assert.equal(result.error, undefined)
  const zenfree = result.routes.filter((route) => route.route.startsWith("zenfree"))
  assert.deepEqual(zenfree.map((route) => route.route).sort(), ["zenfree", "zenfree.res"])
  const chat = result.routes.find((route) => route.route === "zenfree")
  assert.equal(chat?.entryId, "llm-zenfree")
  assert.equal(chat?.packageName, "dsh-llm-zenfree")
  assert.equal(chat?.apiKeyEnv, "OPENCODE_API_KEY", "the credential hint comes from the same schema")
})

test("the pi-ai row pi owns contributes nothing", () => {
  const result = discoverDshRoutes(config(), spawner(ok(fixture)))
  assert.equal(result.routes.some((route) => route.route === "demo"), false)
  assert.equal(result.routes.some((route) => route.packageName.includes("pi-ai")), false)
})

test("an entry with no route-like property contributes nothing", () => {
  const result = discoverDshRoutes(config(), spawner(ok(fixture)))
  assert.equal(result.routes.some((route) => route.entryId === "llm-unrelated"), false)
})

test("a non-string default is ignored", () => {
  const schema = {
    "x-cordis": { entries: [{ id: "llm-odd", name: "dsh-odd", configRef: "#/$defs/c" }] },
    $defs: { c: { anyOf: [{ properties: { provider: { default: 42 }, responsesProvider: { default: "ok-route" } } }] } },
  }
  const result = discoverDshRoutes(config(), spawner(ok(JSON.stringify(schema))))
  assert.deepEqual(result.routes.map((route) => route.route), ["ok-route"])
})

test("routes are de-duplicated across entries and sorted", () => {
  const schema = {
    "x-cordis": {
      entries: [
        { id: "llm-a", name: "dsh-a", configRef: "#/$defs/a" },
        { id: "llm-b", name: "dsh-b", configRef: "#/$defs/b" },
      ],
    },
    $defs: {
      a: { anyOf: [{ properties: { provider: { default: "zeta" }, responsesProvider: { default: "alpha" } } }] },
      b: { anyOf: [{ properties: { provider: { default: "zeta" } } }] },
    },
  }
  assert.deepEqual(discoverDshRoutes(config(), spawner(ok(JSON.stringify(schema)))).routes.map((r) => r.route), ["alpha", "zeta"])
})

test("a non-zero exit, unparsable output, and a spawn failure are all reported, never thrown", () => {
  const failed = discoverDshRoutes(config(), spawner({ status: 1, stdout: "", stderr: "boom" }))
  assert.deepEqual(failed.routes, [])
  assert.match(failed.error ?? "", /boom|dsh/i)

  const garbage = discoverDshRoutes(config(), spawner(ok("not json at all")))
  assert.deepEqual(garbage.routes, [])
  assert.ok(garbage.error !== undefined)

  const thrown = discoverDshRoutes(config(), (() => { throw new Error("ENOENT dsh") }) as never)
  assert.deepEqual(thrown.routes, [])
  assert.match(thrown.error ?? "", /ENOENT|dsh/)
})

test("schema output with no entries is not an error, just no routes", () => {
  const result = discoverDshRoutes(config(), spawner(ok(JSON.stringify({ "x-cordis": { entries: [] } }))))
  assert.deepEqual(result.routes, [])
  assert.equal(result.error, undefined)
})

test("discovery invokes dsh with the profile and the schema flag", async () => {
  const calls: { command: string; args: string[] }[] = []
  // Discovery resolves the dsh command through the real PATH, so a stub keeps the assertion
  // about *how* dsh is invoked independent of whether the machine running the suite has dsh.
  await withPath(fakeDshPathDir(), () => {
    resetDshCommandCache()
    discoverDshRoutes(config({ dshProfile: "pi-advisor" }), spawner(ok(fixture), calls))
  }).finally(() => resetDshCommandCache())
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0], {
    command: "dsh",
    args: ["--profile", "pi-advisor", "--dump-config-schema"],
  })
})

test("results are cached per profile and the cache can be reset", () => {
  resetDshRouteCache()
  const first = dshRoutesFor(config(), spawner(ok(fixture)))
  assert.equal(first.routes.length > 0, true)
  const ignored = dshRoutesFor(config(), spawner(ok(JSON.stringify({ "x-cordis": { entries: [] } }))))
  assert.equal(ignored.routes.length, first.routes.length, "a cached profile is not re-discovered")
  const otherProfile = dshRoutesFor(config({ dshProfile: "web" }), spawner(ok(fixture)))
  assert.equal(otherProfile.routes.length > 0, true, "a different profile is discovered separately")
  resetDshRouteCache()
  assert.equal(dshRoutesFor(config(), spawner(ok(JSON.stringify({ "x-cordis": { entries: [] } })))).routes.length, 0)
})
test("a non-LLM row that also declares a provider is not mistaken for a route", () => {
  const result = discoverDshRoutes(config(), spawner(ok(fixture)))
  assert.equal(result.routes.some((route) => route.route === "spawn"), false)
  assert.equal(result.routes.some((route) => route.entryId.startsWith("workflow")), false)
  assert.equal(result.routes.some((route) => route.entryId.startsWith("tool-")), false)
  assert.deepEqual(result.routes.map((route) => route.route), ["zenfree", "zenfree.res"])
})
