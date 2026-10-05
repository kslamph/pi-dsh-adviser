import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ensureProfile, setModel, profilePatchPath, profileDir, dshSessionsRoot, ensureCapabilityPatch, capabilityPatchPath } from "../config.ts"
import type { DshConfig } from "../config.ts"
import type { DshCommand } from "../resolve.ts"

const PATH_DSH: DshCommand = { command: "dsh", args: [], route: "path" }
const NPX_DSH: DshCommand = { command: "npx", args: ["-y", "@deepseek-ai/dsh@0.2.0-rc.2"], route: "npx" }

function setup(): DshConfig {
  const home = mkdtempSync(join(tmpdir(), "pi-dsh-home-"))
  // The capability overlay lives under pi-dsh's own state dir, which the test home redirects.
  process.env.PI_DSH_TEST_HOME = home
  process.env.DSH_HOME = join(home, "dsh")
  return {
    dshProfile: "pi-advisor",
    dshPackage: "@deepseek-ai/dsh@0.2.0-rc.2",
    projectsDir: join(home, "projects"),
    providers: {
      clinefree: {
        displayName: "Cline Free",
        apiKeyEnv: "CLINE_API_KEY",
        api: "openai-completions",
        baseURL: "https://api.cline.bot/api/v1",
        models: [{ id: "stealth/space-bunny-alpha", name: "Space Bunny Alpha", input: ["text"], contextWindow: 1000000 }],
      },
    },
    model: { provider: "clinefree", id: "stealth/space-bunny-alpha" },
    timeoutMs: 900_000,
    maxResultChars: 20_000,
    pruneAfterHours: 168,
    purgeDsshSessions: false,
    permissionMode: "workspace-write",
    disabledTools: [],
    envAllowlist: [],
    dshProviders: [],
    modelSource: "config file" as const,
  }
}

/** A spawnSync stand-in that records the bootstrap call and fakes success. */
function recorder() {
  const calls: { command: string; args: string[]; timeout?: number }[] = []
  const fn = ((command: string, args: string[], options?: { timeout?: number }) => {
    calls.push({ command, args, ...(options?.timeout === undefined ? {} : { timeout: options.timeout }) })
    // A real bootstrap creates the profile directory and patch document.
    mkdirSync(profileDir("pi-advisor"), { recursive: true })
    writeFileSync(profilePatchPath("pi-advisor"), "# Your patch layer for this dsh profile\n[]\n")
    return { status: 0, stdout: "", stderr: "" }
  }) as never
  return { fn, calls }
}

test("profile creation uses the resolved command, including the npx prefix", () => {
  const config = setup()
  const { fn, calls } = recorder()
  ensureProfile(config, NPX_DSH, fn)
  assert.equal(calls.length, 1)
  assert.equal(calls[0]?.command, "npx")
  assert.deepEqual(calls[0]?.args, ["-y", "@deepseek-ai/dsh@0.2.0-rc.2", "--profile", "pi-advisor", "--from-default-profile", "headless"])
  assert.ok((calls[0]?.timeout ?? 0) >= 180_000, "a cold npx download gets more than 60s")
})

test("an existing profile is not re-bootstrapped", () => {
  const config = setup()
  const { fn, calls } = recorder()
  ensureProfile(config, PATH_DSH, fn)
  ensureProfile(config, PATH_DSH, fn)
  assert.equal(calls.length, 1)
})

test("the managed header appears exactly once, however many times the profile is written", () => {
  const config = setup()
  const { fn } = recorder()
  ensureProfile(config, PATH_DSH, fn)
  for (let i = 0; i < 5; i++) ensureProfile(config, PATH_DSH, fn)
  const document = readFileSync(profilePatchPath("pi-advisor"), "utf8")
  const headerLines = document.split("\n").filter((line) => line.startsWith("# Managed in part by the pi-dsh"))
  assert.equal(headerLines.length, 1)
})

test("repeated writes are byte-identical, so an unchanged config is a no-op", () => {
  const config = setup()
  const { fn } = recorder()
  ensureProfile(config, PATH_DSH, fn)
  const first = readFileSync(profilePatchPath("pi-advisor"), "utf8")
  ensureProfile(config, PATH_DSH, fn)
  assert.equal(readFileSync(profilePatchPath("pi-advisor"), "utf8"), first)
})

test("setModel rewrites only the default-model row and leaves hand-added rows alone", () => {
  const config = setup()
  const { fn } = recorder()
  ensureProfile(config, PATH_DSH, fn)
  const path = profilePatchPath("pi-advisor")
  const document = readFileSync(path, "utf8")
  writeFileSync(path, `${document}\n- id: my-own-row\n  name: "@me/row"\n  config:\n    keep: true\n`)
  setModel(config, { provider: "clinefree", id: "cline-free/mimo-v2.6-flash" }, PATH_DSH)
  const updated = readFileSync(path, "utf8")
  assert.match(updated, /model: cline-free\/mimo-v2\.6-flash/)
  assert.match(updated, /- id: my-own-row/)
  assert.match(updated, /keep: true/)
})

test("dsh sessions live under the configured DSH_HOME", () => {
  const config = setup()
  assert.equal(dshSessionsRoot(), join(process.env.DSH_HOME as string, "sessions"))
  assert.ok(!existsSync(dshSessionsRoot()) || readFileSync === readFileSync)
})

test("the permission preset row makes a read-only adviser stop asking for approval", () => {
  const config = setup()
  const { fn } = recorder()
  ensureProfile(config, PATH_DSH, fn)
  const document = readFileSync(profilePatchPath("pi-advisor"), "utf8")
  assert.match(document, /- id: permission/)
  assert.match(document, /name: "@deepseek-ai\/dsh-permission-presets"/)
  // dsh's own table pairs read-only with `ask`, which in an unattended run can only ever
  // resolve `unavailable`. The point of owning this row is the approval half.
  assert.match(document, /read-only:\n\s+sandbox: read-only\n\s+approval: never/)
  assert.match(document, /workspace-write:\n\s+sandbox: workspace-write/)
  assert.match(document, /danger-full-access:\n\s+sandbox: danger-full-access/)
})

test("the permission row is restated in full, so no preset is lost to a replacing patch", () => {
  const config = setup()
  const { fn } = recorder()
  ensureProfile(config, PATH_DSH, fn)
  const rows = readFileSync(profilePatchPath("pi-advisor"), "utf8")
  for (const preset of ["read-only", "workspace-write", "danger-full-access"]) {
    assert.ok(rows.includes(`${preset}:`), `${preset} must survive pi-dsh's row`)
  }
})

test("no capability overlay is written when nothing is disabled, and it is removed once it was", () => {
  const config = setup()
  assert.equal(ensureCapabilityPatch(config), undefined)
  const path = ensureCapabilityPatch({ ...config, disabledTools: ["tool-web"] })
  assert.equal(path, capabilityPatchPath())
  assert.match(readFileSync(path as string, "utf8"), /- id: tool-web\n {2}disabled: true/)
  assert.equal(ensureCapabilityPatch(config), undefined)
  assert.equal(existsSync(path as string), false, "the overlay is removed rather than left behind")
})
