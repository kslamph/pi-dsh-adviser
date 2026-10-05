/**
 * Which provider routes the adviser's dsh profile actually composes.
 *
 * pi-dsh knows the pi-ai routes it writes itself, but a provider can also arrive as a dsh bundle
 * with its own adapter — `dsh-llm-zenfree` is the one that prompted this. Those routes are not in
 * the composed config dump; they are in the composed config *schema*, because each plugin declares
 * the routes it serves as the defaults of its own config properties.
 *
 * Discovery never throws. A missing dsh, a plugin failure, or a schema this module cannot read is
 * reported as a message the doctor can show, because a provider listing is a convenience and must
 * never be the reason a command fails.
 *
 * @module dshRoutes
 */

import { spawnSync } from "node:child_process"
import { accessSync, constants } from "node:fs"
import { join } from "node:path"
import type { DshConfig } from "./config.ts"

/** One provider route a dsh plugin contributes. */
export interface DshRoute {
  /** The route name a model is addressed by, such as `zenfree` or `zenfree.res`. */
  route: string
  /** The profile row that declares it. */
  entryId: string
  /** The dsh bundle that provides the row. */
  packageName: string
  /** The environment variable the plugin's credential comes from, when it declares one. */
  apiKeyEnv?: string
}

/** What discovery found, or why it found nothing. */
export interface DiscoveryResult {
  /** Routes contributed by dsh plugins, de-duplicated and sorted. */
  routes: DshRoute[]
  /** One line explaining why discovery produced nothing, when that is the case. */
  error?: string
}

/**
 * Only dsh's LLM adapter rows are read. Rows like `workflow-ptc` and `tool-ralph` also declare a
 * `provider` property, but theirs is a process backend (`spawn`), not a model route — dsh names its
 * LLM rows `llm-*`, so that prefix is the filter.
 */
const ROUTE_ENTRY_PREFIX = "llm-"

/** Budget for one schema dump; it is a local process, but plugin composition is not instant. */
const DISCOVERY_TIMEOUT_MS = 120_000

/** The session cache, keyed by dsh profile so a switch of profile is not masked. */
const cachedByProfile = new Map<string, DiscoveryResult>()

/**
 * Forget the cached routes so the next call discovers them again.
 *
 * @returns {void}
 */
export function resetDshRouteCache(): void {
  cachedByProfile.clear()
}

/**
 * Ask dsh which routes the profile composes.
 *
 * @param config - the configuration naming the dsh profile
 * @param run - the spawn function, injected so tests supply captured dsh output
 * @returns the routes, or one line saying why there are none
 */
export function discoverDshRoutes(config: DshConfig, run: typeof spawnSync = spawnSync): DiscoveryResult {
  const command = resolvedCommand(config)
  let stdout: string
  try {
    const result = run(command.command, [...command.args, "--profile", config.dshProfile, "--dump-config-schema"], {
      encoding: "utf8",
      timeout: DISCOVERY_TIMEOUT_MS,
    })
    if (result.status !== 0) {
      const detail = result.stderr?.trim().split("\n").slice(-1)[0]
      return { routes: [], error: `dsh could not describe its own configuration${detail === undefined || detail.length === 0 ? "" : `: ${detail}`}` }
    }
    stdout = result.stdout ?? ""
  } catch (error) {
    return { routes: [], error: `dsh could not be asked about its plugins: ${error instanceof Error ? error.message : String(error)}` }
  }
  try {
    return { routes: routesFromSchema(stdout) }
  } catch (error) {
    return { routes: [], error: `dsh's configuration schema could not be read: ${error instanceof Error ? error.message : String(error)}` }
  }
}

/**
 * The dsh invocation discovery should use, preferring an installed dsh over the npx fallback.
 *
 * A schema dump is a configuration question, not a run, so a cached run command would make the
 * first call pay for a package download; this only accepts what is already on PATH.
 *
 * @param config - the configuration naming the fallback package
 * @returns the command discovery will use
 */
function resolvedCommand(config: DshConfig): { command: string; args: string[] } {
  const which = (bin: string): string | undefined => {
    for (const entry of (process.env.PATH ?? "").split(":").filter((part) => part.length > 0)) {
      if (existsExecutable(join(entry, bin))) return bin
    }
    return undefined
  }
  const installed = which("dsh")
  if (installed !== undefined) return { command: "dsh", args: [] }
  const spec = config.dshPackage.split(" ")[0] ?? config.dshPackage
  return { command: "npx", args: ["-y", spec] }
}

/**
 * Whether a file exists and is executable.
 *
 * @param path - the candidate path
 * @returns true when it can be run
 */
function existsExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Pull every route a composed schema declares out of dsh's schema output.
 *
 * @param stdout - the `--dump-config-schema` JSON document
 * @returns de-duplicated, sorted routes
 */
function routesFromSchema(stdout: string): DshRoute[] {
  const schema = JSON.parse(stdout) as SchemaDocument
  const entries = schema["x-cordis"]?.entries ?? []
  const found = new Map<string, DshRoute>()
  for (const entry of entries) {
    if (!entry.id.startsWith(ROUTE_ENTRY_PREFIX) || entry.id === "llm-pi-ai") continue
    const definition = resolveDefinition(schema, entry.configRef)
    if (definition === undefined) continue
    const properties = definition.anyOf?.[0]?.properties ?? {}
    const apiKeyEnv = stringDefault(properties.apiKeyEnv)
    for (const [name, property] of Object.entries(properties)) {
      if (name !== "provider" && !name.endsWith("Provider")) continue
      const route = stringDefault(property)
      if (route === undefined) continue
      found.set(route, {
        route,
        entryId: entry.id,
        packageName: entry.name,
        ...(apiKeyEnv === undefined ? {} : { apiKeyEnv }),
      })
    }
  }
  return [...found.values()].sort((a, b) => a.route.localeCompare(b.route))
}

/** A property schema that may carry a default value. */
interface PropertySchema {
  default?: unknown
}

/** One entry of dsh's composed schema. */
interface SchemaEntry {
  id: string
  name: string
  configRef?: string
}

/** The parts of dsh's schema document this module reads. */
interface SchemaDocument {
  $defs?: Record<string, { anyOf?: Array<{ properties?: Record<string, PropertySchema> }> }>
  "x-cordis"?: { entries?: SchemaEntry[] }
}

/**
 * Resolve a `#/$defs/<name>` reference into its definition.
 *
 * @param schema - the whole schema document
 * @param ref - the reference string, absent when the entry declares no config
 * @returns the definition, or undefined when it cannot be resolved
 */
function resolveDefinition(
  schema: SchemaDocument,
  ref: string | undefined,
): { anyOf?: Array<{ properties?: Record<string, PropertySchema> }> } | undefined {
  if (ref === undefined || !ref.startsWith("#/$defs/")) return undefined
  return schema.$defs?.[ref.slice("#/$defs/".length)]
}

/**
 * Read a property's default when it is a string.
 *
 * @param property - the property schema
 * @returns the default, or undefined when it is missing or not a string
 */
function stringDefault(property: PropertySchema | undefined): string | undefined {
  const value = property?.default
  return typeof value === "string" && value.length > 0 ? value : undefined
}

/**
 * Discover routes once per pi session.
 *
 * @param config - the configuration naming the dsh profile
 * @returns the routes, or one line saying why there are none
 */
export function dshRoutesFor(config: DshConfig, run?: typeof spawnSync): DiscoveryResult {
  const cached = cachedByProfile.get(config.dshProfile)
  if (cached !== undefined) return cached
  const result = discoverDshRoutes(config, run)
  cachedByProfile.set(config.dshProfile, result)
  return result
}