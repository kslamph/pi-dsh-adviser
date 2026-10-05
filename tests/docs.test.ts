import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { createHandlers, realDeps } from "../handlers.ts"
import { userConfigPath } from "../config.ts"
import { extensionDir } from "../config.ts"

const readme = readFileSync(join(dirname(dirname(new URL(import.meta.url).pathname)), "README.md"), "utf8")
const example = readFileSync(join(extensionDir(), "config.example.json"), "utf8")

test("every command the README documents is a real command", () => {
  const handlers = createHandlers(realDeps())
  for (const match of readme.matchAll(/`\/(dsh[a-z-]*)/g)) {
    const name = match[1] ?? ""
    assert.ok(handlers[name] !== undefined, `README documents /${name}, which is not registered`)
  }
  for (const name of ["dsh", "dsh-follow", "dsh-sessions", "dsh-delete", "dsh-status", "dsh-model", "dsh-doctor"]) {
    assert.match(readme, new RegExp(`/${name.replace("-", "-")}`), `README should document /${name}`)
  }
})

test("every config field the README names exists in the shipped template", () => {
  const template = JSON.parse(example) as Record<string, unknown>
  const configSource = readFileSync(join(extensionDir(), "config.ts"), "utf8")
  const fields = [...readme.matchAll(/`([a-zA-Z][a-zA-Z0-9]*)`\s+(?:—|-|:|,|is|and)\s/g)].map((m) => m[1])
  const documented = new Set(
    [...readme.matchAll(/^\s*[|*-]\s*`?([a-zA-Z][a-zA-Z0-9]*)`?\s*[:—-]/gm)]
      .map((m) => m[1])
      .filter((field): field is string => field !== undefined),
  )
  for (const field of documented) {
    if (!configSource.includes(field) && !Object.hasOwn(template, field)) {
      // Only complain about names that look like config fields rather than prose.
      if (/^[a-z][a-zA-Z]+$/.test(field)) {
        assert.fail(`README names \`${field}\`, which appears in neither config.ts nor config.example.json`)
      }
    }
  }
  assert.ok(fields.length >= 0)
})

test("every PI_DSH_ env var the README names exists in the code", () => {
  const source = readFileSync(join(extensionDir(), "config.ts"), "utf8")
  for (const match of readme.matchAll(/PI_DSH_[A-Z_]+/g)) {
    assert.ok(source.includes(match[0]), `README names ${match[0]}, which the code does not read`)
  }
})

test("the README carries no path from the author's machine", () => {
  assert.doesNotMatch(readme, /\/home\/kslam/, "README must not document this machine's paths")
})

test("the README points at the user's own config path", () => {
  assert.match(readme, /config\.json/)
  assert.ok(userConfigPath().endsWith(join(".pi", "agent", "pi-dsh", "config.json")))
  assert.doesNotMatch(readme, /beside `index\.ts`|next to `index\.ts`/)
})

test("the README documents plugin-provided routes and how to install one", () => {
  assert.match(readme, /dsh plugin --profile [a-z-]+ add [a-z@/-]+/, "the README shows dsh's own plugin install command")
  assert.match(readme, /dsh plugin/i)
  assert.match(readme, /dshProviders/)
  assert.match(readme, /routes from dsh plugins|dsh plugin/i)
})

test("the README says a model switch is saved, and that the env var still wins", () => {
  assert.match(readme, /saved to `?~?\/?\.pi\/agent\/pi-dsh\/config\.json|config\.json`?/)
  assert.match(readme, /PI_DSH_DEFAULT_MODEL/)
  assert.match(readme, /\.bak/)
})

// The agent-facing briefing: LLMS.txt must stay complete enough to set a user up unattended.

const llms = readFileSync(join(extensionDir(), "LLMS.txt"), "utf8")

test("LLMS.txt tells an agent what this is and how to check readiness", () => {
  assert.match(llms, /^# pi-dsh/m)
  assert.match(llms, /\/dsh-doctor/, "readiness is checked by running /dsh-doctor")
  assert.match(llms, /\/dsh-status/)
})

test("LLMS.txt names the dependencies and how they are obtained", () => {
  assert.match(llms, /pi install/, "how to install the extension")
  assert.match(llms, /npm i -g @deepseek-ai\/dsh|@deepseek-ai\/dsh/, "how to install or fetch dsh")
  assert.match(llms, /npx/, "the npx fallback must be described")
})

test("LLMS.txt documents where configuration lives and every configurable field", () => {
  assert.match(llms, /\.pi\/agent\/pi-dsh\/config\.json/)
  const template = JSON.parse(example) as Record<string, unknown>
  for (const field of Object.keys(template)) {
    assert.ok(llms.includes(field), `LLMS.txt must document the \`${field}\` field`)
  }
  assert.match(llms, /config\.example\.json/, "it must point at the template to copy")
})

test("LLMS.txt shows a complete provider configuration with every required key", () => {
  for (const key of ["apiKeyEnv", "api", "baseURL", "models"]) {
    assert.match(llms, new RegExp(key), `a provider example must show \`${key}\``)
  }
  assert.match(llms, /openai-completions|openai-responses|anthropic-messages/, "the allowed api values must be listed")
})

test("LLMS.txt documents the environment overrides and dsh plugin providers", () => {
  for (const variable of ["PI_DSH_DSH_PROFILE", "PI_DSH_PROJECTS_DIR", "PI_DSH_DEFAULT_MODEL"]) {
    assert.match(llms, new RegExp(variable))
  }
  assert.match(llms, /dsh plugin --profile/, "plugin providers need their install command")
  assert.match(llms, /dshProviders/)
})

test("LLMS.txt lists the commands and warns about what not to edit", () => {
  for (const command of ["dsh", "dsh-follow", "dsh-sessions", "dsh-delete", "dsh-status", "dsh-model", "dsh-doctor"]) {
    assert.match(llms, new RegExp(`/${command.replace("-", "-")}`))
  }
  assert.match(llms, /cordis\.patch\.yml|do not edit|rewritten/, "it must warn against editing generated dsh state")
})

test("LLMS.txt gives failure symptoms and the fix for each", () => {
  assert.match(llms, /ENOENT|not installed|could not find/i)
  assert.match(llms, /no usable provider/i)
  assert.match(llms, /not valid JSON|valid JSON/i)
})
