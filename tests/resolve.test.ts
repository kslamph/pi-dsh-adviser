import { test } from "node:test"
import assert from "node:assert/strict"
import { resolveDshCommand, resetDshCommandCache, dshCommandFor } from "../resolve.ts"
import type { DshConfig } from "../config.ts"
import { fakeDshPathDir, withPath, withTempHome } from "./helpers.ts"

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

test("resolveDshCommand never consults the cache but dshCommandFor does", async () => {
  withTempHome()
  // A stub dsh on a private PATH makes the `path` route deterministic here; relying on the
  // machine's own PATH made this test pass only where dsh happened to be installed.
  const first = await withPath("/nonexistent-bin", () => {
    resetDshCommandCache()
    const resolved = dshCommandFor(config())
    assert.equal(resolved.route, "npx")
    return resolved
  })
  await withPath(fakeDshPathDir(), () => {
    const cached = dshCommandFor(config())
    assert.deepEqual(cached, first, "the cached command is reused even after PATH changes")
    resetDshCommandCache()
    assert.equal(dshCommandFor(config()).route, "path", "a fresh resolution sees the stub")
  })
  resetDshCommandCache()
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
