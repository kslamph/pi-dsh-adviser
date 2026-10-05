import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { loadConfig, saveModel, userConfigPath } from "../config.ts"
import type { DshConfig } from "../config.ts"
import { minimalConfig, stateDirOf, withTempHome, writeUserConfig } from "./helpers.ts"

function clearEnv(): void {
  delete process.env.PI_DSH_DSH_PROFILE
  delete process.env.PI_DSH_PROJECTS_DIR
  delete process.env.PI_DSH_DEFAULT_MODEL
}

test("absent user config is created from the template, then reported as needing a provider", () => {
  const home = withTempHome()
  clearEnv()
  const path = userConfigPath()
  assert.throws(
    () => loadConfig(),
    (error: Error) => {
      assert.match(error.message, /config\.json/)
      assert.match(error.message, /provider/)
      assert.doesNotMatch(error.message, /ENOENT|SyntaxError/)
      return true
    },
  )
  assert.ok(existsSync(path), "template was copied to the user config path")
  assert.equal(path, join(stateDirOf(home), "config.json"))
  assert.doesNotThrow(() => JSON.parse(readFileSync(path, "utf8")))
})

test("the copied template is never read as a configuration layer", () => {
  const home = withTempHome()
  clearEnv()
  writeUserConfig(home, minimalConfig({ dshProfile: "user-choice" }))
  // The template's own values must not bleed into a user file that omits them.
  assert.equal(loadConfig().dshProfile, "user-choice")
})

test("the user file is parsed whole and required fields are errors, never example fallbacks", () => {
  const home = withTempHome()
  clearEnv()
  writeUserConfig(home, minimalConfig({ providers: undefined }))
  assert.throws(() => loadConfig(), /providers/)
  writeUserConfig(home, minimalConfig({ model: undefined }))
  assert.throws(() => loadConfig(), /model/)
  writeUserConfig(home, minimalConfig({ model: { provider: "demo" } }))
  assert.throws(() => loadConfig(), /model\.id/)
  writeUserConfig(home, minimalConfig({ providers: {} }))
  assert.throws(() => loadConfig(), /providers/)
})

test("documented defaults apply for every optional field", () => {
  const home = withTempHome()
  clearEnv()
  writeUserConfig(home, minimalConfig())
  const config = loadConfig()
  assert.equal(config.dshProfile, "pi-advisor")
  assert.equal(config.dshPackage, "@deepseek-ai/dsh@0.2.0-rc.2")
  assert.equal(config.projectsDir, join(stateDirOf(home), "projects"))
  assert.equal(config.timeoutMs, 900_000)
  assert.equal(config.maxResultChars, 20_000)
  assert.equal(config.pruneAfterHours, 168)
  assert.equal(config.purgeDsshSessions, false)
})

test("each env override replaces exactly one scalar, and empty values are ignored", () => {
  const home = withTempHome()
  clearEnv()
  writeUserConfig(home, minimalConfig())
  process.env.PI_DSH_DSH_PROFILE = "env-profile"
  process.env.PI_DSH_PROJECTS_DIR = "/tmp/env-projects"
  process.env.PI_DSH_DEFAULT_MODEL = "demo/env-model"
  try {
    const config = loadConfig()
    assert.equal(config.dshProfile, "env-profile")
    assert.equal(config.projectsDir, "/tmp/env-projects")
    assert.deepEqual(config.model, { provider: "demo", id: "env-model" })
    // The provider table is untouched by the environment.
    assert.deepEqual(Object.keys(config.providers), ["demo"])
    process.env.PI_DSH_DEFAULT_MODEL = ""
    assert.deepEqual(loadConfig().model, { provider: "demo", id: "demo-1" })
  } finally {
    clearEnv()
  }
})

test("malformed JSON names the file without leaking internals", () => {
  const home = withTempHome()
  clearEnv()
  writeUserConfig(home, "{ not json ")
  assert.throws(
    () => loadConfig(),
    (error: Error) => {
      assert.match(error.message, /config\.json/)
      assert.doesNotMatch(error.message, /SyntaxError|ENOENT|at Object/)
      return true
    },
  )
})

test("config.json fields override env defaults for provider routes that the file owns", () => {
  const home = withTempHome()
  clearEnv()
  writeUserConfig(
    home,
    minimalConfig({ dshPackage: "@deepseek-ai/dsh@9.9.9", pruneAfterHours: 0, purgeDsshSessions: true }),
  )
  const config = loadConfig()
  assert.equal(config.dshPackage, "@deepseek-ai/dsh@9.9.9")
  assert.equal(config.pruneAfterHours, 0)
  assert.equal(config.purgeDsshSessions, true)
})

test("state never lands in the real home while a test home is set", () => {
  const home = withTempHome()
  clearEnv()
  assert.equal(userConfigPath(), join(stateDirOf(home), "config.json"))
  assert.doesNotMatch(userConfigPath(), /^\/home\//, "the test home must win over the real one")
})

test("dshProviders defaults to empty and passes a declared list through", () => {
  const home = withTempHome()
  clearEnv()
  writeUserConfig(home, minimalConfig())
  assert.deepEqual(loadConfig().dshProviders, [])
  writeUserConfig(home, minimalConfig({ dshProviders: ["zenfree", "zenfree.res"] }))
  assert.deepEqual(loadConfig().dshProviders, ["zenfree", "zenfree.res"])
})

test("modelSource says whether the file or the environment supplied the model", () => {
  const home = withTempHome()
  clearEnv()
  writeUserConfig(home, minimalConfig())
  assert.equal(loadConfig().modelSource, "config file")
  process.env.PI_DSH_DEFAULT_MODEL = "demo/from-env"
  try {
    assert.equal(loadConfig().modelSource, "PI_DSH_DEFAULT_MODEL")
  } finally {
    clearEnv()
  }
})

test("saveModel rewrites only model, keeps unknown keys, and leaves one backup", () => {
  const home = withTempHome()
  clearEnv()
  writeUserConfig(home, minimalConfig({ futureOption: 42, timeoutMs: 5000 }))
  const before = readFileSync(userConfigPath(), "utf8")

  const saved = saveModel(loadConfig(), { provider: "zenfree", id: "fledge-alpha-free" })

  const after = JSON.parse(readFileSync(saved.path, "utf8"))
  assert.deepEqual(after.model, { provider: "zenfree", id: "fledge-alpha-free" })
  assert.equal(after.futureOption, 42, "a key this version does not know survives")
  assert.equal(after.timeoutMs, 5000)
  assert.equal(readFileSync(saved.backupPath, "utf8"), before, "the backup holds the exact previous content")
  assert.deepEqual(loadConfig().model, { provider: "zenfree", id: "fledge-alpha-free" })
})

test("saveModel writes the file, but an env override still wins when loading", () => {
  const home = withTempHome()
  clearEnv()
  writeUserConfig(home, minimalConfig())
  process.env.PI_DSH_DEFAULT_MODEL = "demo/from-env"
  try {
    saveModel(loadConfig(), { provider: "zenfree", id: "some-model" })
    assert.deepEqual(loadConfig().model, { provider: "demo", id: "from-env" })
    assert.equal(loadConfig().modelSource, "PI_DSH_DEFAULT_MODEL")
  } finally {
    clearEnv()
  }
})

test("saveModel refuses to overwrite a config it cannot read", () => {
  const home = withTempHome()
  clearEnv()
  writeUserConfig(home, "{ not json ")
  const path = userConfigPath()
  assert.throws(() => saveModel({ ...minimalShape(), } as never, { provider: "x", id: "y" }), /config\.json/)
  assert.equal(readFileSync(path, "utf8"), "{ not json ", "the unreadable file is left exactly as it was")
})

/** A config shape good enough for saveModel, which only needs the file on disk. */
function minimalShape(): Partial<DshConfig> {
  return {
    dshProfile: "pi-advisor",
    dshPackage: "x",
    projectsDir: "/tmp/x",
    providers: {},
    model: { provider: "demo", id: "demo-1" },
    timeoutMs: 1,
    maxResultChars: 1,
    pruneAfterHours: 1,
    purgeDsshSessions: false,
  }
}
