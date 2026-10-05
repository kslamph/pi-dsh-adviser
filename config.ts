/**
 * Configuration and dsh profile ownership for pi-dsh.
 *
 * pi owns the adviser's provider route and model; dsh owns everything else. This
 * module reads the extension's configuration, materializes a dsh profile that
 * serves it, and remembers which dsh session the last run left open.
 *
 * Profile writes are row-scoped: the extension replaces only the rows it owns
 * (`llm-pi-ai` and `agent-default-model`) and leaves every other row in the
 * patch document byte-identical, so a profile shared with hand-written overrides
 * survives a model switch.
 */

import { copyFileSync, mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import type { DshCommand } from "./resolve.ts"

/** One model a configured provider serves. */
export interface ModelSpec {
  id: string
  name?: string
  contextWindow?: number
  maxTokens?: number
  /**
   * Request modalities the model accepts. dsh's pi-ai routes declare `text` and
   * `image` only; a model that also takes audio or video still declares the two
   * it can be asked for here.
   */
  input?: ("text" | "image")[]
}

/** One provider route written into the dsh profile. */
export interface ProviderSpec {
  displayName?: string
  apiKeyEnv: string
  api: "openai-completions" | "openai-responses" | "anthropic-messages"
  baseURL: string
  compat?: Record<string, unknown>
  headers?: Record<string, string>
  models: ModelSpec[]
}

/** Extension configuration, read from the user's `config.json`. */
export interface DshConfig {
  /** dsh runtime profile the adviser runs in; pi creates and maintains it. */
  dshProfile: string
  /** npx fallback spec used when no `dsh` is on PATH. */
  dshPackage: string
  /** Root of the per-project session stores. */
  projectsDir: string
  /** Provider routes written into the dsh profile. */
  providers: Record<string, ProviderSpec>
  /** Route and model a run uses when the caller names none. */
  model: { provider: string; id: string }
  /** Wall-clock limit for one run. */
  timeoutMs: number
  /** Model-facing result cap; the full answer is written to a file and referenced. */
  maxResultChars: number
  /** Inactivity hours after which a session is pruned on load; 0 disables. */
  pruneAfterHours: number
  /** Whether deletion also removes dsh's own session directory. */
  purgeDsshSessions: boolean
  /** Provider routes that dsh plugins contribute and pi-dsh must not try to describe itself. */
  dshProviders: string[]
  /** Whether the effective model came from the config file or an environment override. */
  modelSource: "config file" | "PI_DSH_DEFAULT_MODEL"
}

const EXTENSION_DIR = dirname(new URL(import.meta.url).pathname)

/** Home directory for pi-dsh's own state, overridable so tests never touch the real one. */
function homeBase(): string {
  return process.env.PI_DSH_TEST_HOME ?? homedir()
}

/** Directory holding the user's configuration, session stores, and run logs. */
export function userStateDir(): string {
  return join(homeBase(), ".pi", "agent", "pi-dsh")
}

/** The user's configuration file, created from the shipped template when absent. */
export function userConfigPath(): string {
  return join(userStateDir(), "config.json")
}

/** Directory holding this extension's files. */
export function extensionDir(): string {
  return EXTENSION_DIR
}

/** Absolute path of the dsh home holding profiles. */
export function dshHome(): string {
  return process.env.DSH_HOME ?? join(homeBase(), ".dsh")
}

/** Absolute path of one profile's patch document. */
export function profilePatchPath(profile: string): string {
  return join(dshHome(), "profiles", profile, "cordis.patch.yml")
}

/** Absolute path of one profile directory. */
export function profileDir(profile: string): string {
  return join(dshHome(), "profiles", profile)
}

/** Absolute path of the directory holding dsh's own session logs. */
export function dshSessionsRoot(): string {
  return join(dshHome(), "sessions")
}

/** Defaults for every optional configuration field. */
const DEFAULTS = {
  dshProfile: "pi-advisor",
  dshPackage: "@deepseek-ai/dsh@0.2.0-rc.2",
  timeoutMs: 900_000,
  maxResultChars: 20_000,
  pruneAfterHours: 168,
  purgeDsshSessions: false,
} as const

/**
 * Tell the user what to do about a configuration problem.
 *
 * @param reason - what is wrong with the configuration
 * @param field - the field at fault, when one specific field is
 * @returns an actionable, single-line message
 */
function configError(reason: string, field?: string): string {
  const where = userConfigPath()
  const subject = field === undefined ? "" : ` Field \`${field}\` is the problem.`
  return (
    `pi-dsh: ${reason}${subject} Edit ${where} to fix it — it is your file, created from the` +
    ` extension's config.example.json. Each provider needs \`apiKeyEnv\`, \`api\`, \`baseURL\`, and at` +
    ` least one model, and \`model\` must name one of them. If you are not sure what to write, ask your` +
    ` coding agent to configure pi-dsh for you.`
  )
}

/**
 * Read the user's configuration, applying the documented precedence exactly.
 *
 * The shipped template is only ever copied, never read as a layer; the user file is parsed whole
 * so a placeholder value can never silently misroute a run; the three env overrides each replace
 * one scalar after parsing.
 *
 * @returns the validated configuration
 * @throws when the user file is absent, unparsable, or lacks a required field
 */
export function loadConfig(): DshConfig {
  const path = userConfigPath()
  if (!existsSync(path)) {
    mkdirSync(dirname(path), { recursive: true })
    copyFileSync(join(EXTENSION_DIR, "config.example.json"), path)
    throw new Error(
      `pi-dsh: I created your configuration at ${path} from the extension's config.example.json.`
      + ` It needs a provider and a \`model\` before the adviser can run — edit that file, or ask your`
      + ` coding agent to configure one for you.`,
    )
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"))
  } catch {
    throw new Error(configError("your configuration file is not valid JSON", undefined))
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(configError("your configuration file must contain a JSON object"))
  }
  const config = parsed as Partial<DshConfig>
  if (config.providers === undefined || Object.keys(config.providers).length === 0) {
    throw new Error(configError("no usable provider is configured", "providers"))
  }
  if (config.model?.provider === undefined) {
    throw new Error(configError("no default model is configured", "model.provider"))
  }
  if (config.model?.id === undefined) {
    throw new Error(configError("no default model is configured", "model.id"))
  }

  const envProfile = process.env.PI_DSH_DSH_PROFILE
  const envProjectsDir = process.env.PI_DSH_PROJECTS_DIR
  const envModel = process.env.PI_DSH_DEFAULT_MODEL
  const projectsDir = envProjectsDir !== undefined && envProjectsDir.length > 0
    ? envProjectsDir
    : config.projectsDir ?? join(userStateDir(), "projects")
  const envOverride = parseDefaultModel(envModel)

  return {
    dshProfile: envProfile !== undefined && envProfile.length > 0 ? envProfile : config.dshProfile ?? DEFAULTS.dshProfile,
    dshPackage: config.dshPackage ?? DEFAULTS.dshPackage,
    projectsDir,
    providers: config.providers,
    model: envOverride ?? config.model,
    timeoutMs: config.timeoutMs ?? DEFAULTS.timeoutMs,
    maxResultChars: config.maxResultChars ?? DEFAULTS.maxResultChars,
    pruneAfterHours: config.pruneAfterHours ?? DEFAULTS.pruneAfterHours,
    purgeDsshSessions: config.purgeDsshSessions ?? DEFAULTS.purgeDsshSessions,
    dshProviders: config.dshProviders ?? [],
    modelSource: envOverride === undefined ? "config file" : "PI_DSH_DEFAULT_MODEL",
  }
}

/**
 * Save the chosen model into the user's configuration file.
 *
 * A model switch has to outlive the command that made it: the profile row pi writes is regenerated
 * from the configuration on every run, so the file is the only place a choice can persist. Only the
 * `model` key is replaced, so keys this version does not know about survive untouched, and the
 * previous content is kept once so a bad write can be undone by hand.
 *
 * @param config - the configuration whose profile is being switched
 * @param model - the route and model new runs use
 * @returns the written config path and the backup path
 * @throws when the existing configuration cannot be read, leaving it untouched
 */
export function saveModel(config: DshConfig, model: { provider: string; id: string }): { path: string; backupPath: string } {
  const path = userConfigPath()
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"))
  } catch {
    throw new Error(configError("your configuration file could not be read, so the model was not changed"))
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(configError("your configuration file must contain a JSON object, so the model was not changed"))
  }
  const document = parsed as Record<string, unknown>
  document.model = model
  const backupPath = `${path}.bak`
  const tempPath = `${path}.tmp`
  mkdirSync(dirname(path), { recursive: true })
  copyFileSync(path, backupPath)
  writeFileSync(tempPath, `${JSON.stringify(document, null, 2)}\n`)
  renameSync(tempPath, path)
  void config
  return { path, backupPath }
}

/**
 * Parse the `PI_DSH_DEFAULT_MODEL` override, which is written `provider/id`.
 *
 * @param value - the override value, possibly absent or empty
 * @returns the route and model, or undefined to keep the configured one
 */
function parseDefaultModel(value: string | undefined): { provider: string; id: string } | undefined {
  if (value === undefined || value.length === 0) return undefined
  const separator = value.lastIndexOf("/")
  if (separator <= 0 || separator === value.length - 1) return undefined
  return { provider: value.slice(0, separator), id: value.slice(separator + 1) }
}

/** Scalars YAML would read as a non-string: booleans, nulls, and YAML 1.1 words. */
const YAML_NON_STRING = /^(?:true|false|null|yes|no|on|off|y|n|~)$/i

/**
 * Quote one YAML scalar so it always reads back as the string it is.
 *
 * Headers and ids are strings end to end: an unquoted `false` reads as a
 * boolean, and a header dict typed as strings then rejects the whole provider
 * row. Numbers stay plain because the schema expects numbers there.
 *
 * @param value - the scalar to write
 * @returns the YAML representation
 */
function yamlScalar(value: string | number): string {
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : JSON.stringify(String(value))
  const plain = /^[A-Za-z0-9_./@:+-]+$/.test(value) && !YAML_NON_STRING.test(value) && !/^[-+]?[0-9.]/.test(value)
  return plain ? value : JSON.stringify(value)
}

/**
 * Render the `llm-pi-ai` provider row from configuration.
 *
 * @param providers - every provider route to declare
 * @returns the row's YAML lines, including the leading row id
 */
function providerRow(providers: Record<string, ProviderSpec>): string {
  const lines = ["- id: llm-pi-ai", "  name: \"@deepseek-ai/dsh-llm-pi-ai\"", "  config:", "    providers:"]
  for (const [key, provider] of Object.entries(providers)) {
    lines.push(`      ${yamlScalar(key)}:`)
    if (provider.displayName !== undefined) lines.push(`        displayName: ${yamlScalar(provider.displayName)}`)
    lines.push(`        apiKeyEnv: ${yamlScalar(provider.apiKeyEnv)}`)
    lines.push(`        api: ${yamlScalar(provider.api)}`)
    lines.push(`        baseURL: ${yamlScalar(provider.baseURL)}`)
    if (provider.compat !== undefined) {
      lines.push("        compat:")
      for (const [name, value] of Object.entries(provider.compat)) {
        lines.push(`          ${yamlScalar(name)}: ${yamlScalar(String(value))}`)
      }
    }
    if (provider.headers !== undefined) {
      lines.push("        headers:")
      for (const [name, value] of Object.entries(provider.headers)) {
        lines.push(`          ${yamlScalar(name)}: ${yamlScalar(value)}`)
      }
    }
    lines.push("        models:")
    for (const model of provider.models) {
      lines.push(`          - id: ${yamlScalar(model.id)}`)
      if (model.name !== undefined) lines.push(`            name: ${yamlScalar(model.name)}`)
      if (model.input !== undefined) lines.push(`            input: [${model.input.join(", ")}]`)
      if (model.contextWindow !== undefined) lines.push(`            contextWindow: ${model.contextWindow}`)
      if (model.maxTokens !== undefined) lines.push(`            maxTokens: ${model.maxTokens}`)
    }
  }
  return lines.join("\n")
}

/**
 * Render the `agent-default-model` row.
 *
 * @param model - the route and model new runs use
 * @returns the row's YAML lines, including the leading row id
 */
function modelRow(model: { provider: string; id: string }): string {
  return [
    "- id: agent-default-model",
    "  name: \"@deepseek-ai/dsh-agent-default-model\"",
    "  config:",
    `    provider: ${yamlScalar(model.provider)}`,
    `    model: ${yamlScalar(model.id)}`,
  ].join("\n")
}

/**
 * Split a patch document into its top-level rows, keeping each row's text.
 *
 * @param document - the patch document
 * @returns the leading comment block followed by one entry per top-level row
 */
function splitRows(document: string): { header: string[]; rows: { id: string; text: string }[] } {
  const lines = document.split("\n")
  const header: string[] = []
  const rows: { id: string; text: string }[] = []
  let current: { id: string; lines: string[] } | undefined
  for (const line of lines) {
    const isRow = line.startsWith("- id:") || line.startsWith("- insert:")
    if (isRow) {
      if (current !== undefined) rows.push({ id: current.id, text: current.lines.join("\n") })
      current = { id: line.startsWith("- insert:") ? "insert" : line.slice("- id:".length).trim(), lines: [line] }
      continue
    }
    if (current === undefined) {
      if (line.trim().length > 0 || header.length > 0) header.push(line)
    } else {
      current.lines.push(line)
    }
  }
  if (current !== undefined) rows.push({ id: current.id, text: current.lines.join("\n") })
  return { header, rows }
}

/** The comment block this extension writes at the top of every patch document it owns. */
const MANAGED_HEADER = [
  "# Managed in part by the pi-dsh extension: the llm-pi-ai and agent-default-model rows",
  "# are rewritten from pi-dsh config.json. Other rows are left untouched.",
]

/** Time budget for creating a profile; a cold npx download needs more than a minute. */
const PROFILE_INIT_TIMEOUT_MS = 180_000

/**
 * Create the profile when absent and write pi's rows into its patch document.
 *
 * @param config - the configuration naming the dsh profile, its providers, and the model
 * @param command - the resolved dsh command, so a user without a global install still works
 * @param spawnSyncFn - test seam for the profile bootstrap
 * @returns the profile's patch path
 */
export function ensureProfile(
  config: DshConfig,
  command: DshCommand,
  spawnSyncFn: typeof spawnSync = spawnSync,
): string {
  const dir = profileDir(config.dshProfile)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
    const init = spawnSyncFn(
      command.command,
      [...command.args, "--profile", config.dshProfile, "--from-default-profile", "headless"],
      { encoding: "utf8", timeout: PROFILE_INIT_TIMEOUT_MS },
    )
    if (init.status !== 0) {
      throw new Error(
        `pi-dsh: could not create the dsh profile ${config.dshProfile}: ${init.stderr?.trim() ?? init.error?.message ?? "unknown error"}`,
      )
    }
  }
  const path = profilePatchPath(config.dshProfile)
  let existing = ""
  if (existsSync(path)) existing = readFileSync(path, "utf8")
  const { header, rows } = splitRows(existing)
  const owned = new Map<string, string>([
    ["llm-pi-ai", providerRow(config.providers)],
    ["agent-default-model", modelRow(config.model)],
  ])
  const kept = rows.filter((row) => !owned.has(row.id))
  // Drop previously written managed header lines so repeated runs do not stack them up.
  const head = header.filter((line) => line.trim().length > 0 && !MANAGED_HEADER.includes(line.trim()))
  const document = [...MANAGED_HEADER, ...head, ...kept.map((row) => row.text), ...[...owned.values()], ""].join("\n")
  writeFileSync(path, document)
  return path
}

/**
 * Point the dsh profile at a different model, leaving every other field alone.
 *
 * @param config - the configuration whose dsh profile to update
 * @param model - the route and model new runs use
 * @param command - the resolved dsh command used when the profile must be created
 * @returns the patch path that was written
 */
export function setModel(config: DshConfig, model: { provider: string; id: string }, command: DshCommand): string {
  return ensureProfile({ ...config, model }, command)
}
