import { test } from "node:test"
import assert from "node:assert/strict"
import { resolveDshCommand, resetDshCommandCache, dshCommandFor } from "../resolve.ts"
import type { DshConfig } from "../config.ts"
import { withTempHome } from "./helpers.ts"

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
    dshProviders: [],
    modelSource: "config file" as const,
    ...overrides,
  }
}

test("an installed dsh on PATH is used directly", () => {
  assert.deepEqual(resolveDshCommand(config(), () => "/usr/bin/dsh"), {
    command: "dsh",
    args: [],
    route: "path",
  })
})

test("without dsh on PATH the pinned npx package is used", () => {
  assert.deepEqual(resolveDshCommand(config(), () => undefined), {
    command: "npx",
    args: ["-y", "@deepseek-ai/dsh@0.2.0-rc.2"],
    route: "npx",
  })
})

test("a configured dshPackage overrides the pinned fallback spec", () => {
  const command = resolveDshCommand(config({ dshPackage: "@deepseek-ai/dsh@9.9.9" }), () => undefined)
  assert.deepEqual(command.args, ["-y", "@deepseek-ai/dsh@9.9.9"])
})

test("resolveDshCommand never consults the cache but dshCommandFor does", () => {
  withTempHome()
  resetDshCommandCache()
  let calls = 0
  const original = process.env.PATH
  process.env.PATH = "/nonexistent-bin"
  try {
    // dshCommandFor resolves through the real `which`, so point PATH somewhere without dsh.
    const first = dshCommandFor(config())
    assert.equal(first.route, "npx")
    process.env.PATH = `${original ?? ""}`
    const second = dshCommandFor(config())
    assert.deepEqual(second, first, "the cached command is reused even after PATH changes")
    calls += 1
    resetDshCommandCache()
    assert.equal(dshCommandFor(config()).route, "path")
  } finally {
    process.env.PATH = original
    resetDshCommandCache()
  }
  assert.equal(calls, 1)
})

test("with no dsh anywhere the error names both install routes", () => {
  assert.throws(
    () => resolveDshCommand(config(), () => undefined, { allowNpx: false }),
    (error: Error) => {
      assert.match(error.message, /npm i -g @deepseek-ai\/dsh/)
      assert.match(error.message, /npx/)
      return true
    },
  )
})
