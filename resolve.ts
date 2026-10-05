/**
 * How the extension invokes dsh.
 *
 * A user may have dsh installed globally, or may have nothing but node. Both must work, so the
 * resolved answer is a command with leading arguments rather than a bare executable: `dsh` on PATH
 * is used directly, and otherwise the pinned package is fetched through `npx`. Resolution happens
 * once per pi session and caches its result, including the negative case, because a miss costs
 * seconds that no command should pay twice.
 *
 * @module resolve
 */

import { accessSync, constants } from "node:fs"
import { join } from "node:path"
import type { DshConfig } from "./config.ts"

/** A resolved dsh invocation: the program, its leading arguments, and which route produced it. */
export interface DshCommand {
  /** The program to spawn. */
  command: string
  /** Arguments that precede the dsh flags this extension builds. */
  args: string[]
  /** Which resolution route produced this command. */
  route: "path" | "npx"
}

/** Options that narrow resolution, used by tests and by the doctor command. */
export interface ResolveOptions {
  /** Set false to report the "dsh not installed" error instead of falling back to npx. */
  allowNpx?: boolean
}

/** The session cache; reset only by tests and `/reload`. */
let cached: DshCommand | undefined

/**
 * Forget the cached command so the next resolution runs again.
 *
 * @returns {void}
 */
export function resetDshCommandCache(): void {
  cached = undefined
}

/**
 * Resolve the dsh command for a configuration, without consulting or filling the cache.
 *
 * @param config - the configuration naming the fallback package
 * @param which - lookup for a program on PATH, injected so resolution is testable
 * @param options - whether the npx fallback is permitted
 * @returns the resolved command
 * @throws when neither route can produce a command
 */
export function resolveDshCommand(
  config: DshConfig,
  which: (bin: string) => string | undefined,
  options: ResolveOptions = {},
): DshCommand {
  const installed = which("dsh")
  if (installed !== undefined) return { command: "dsh", args: [], route: "path" }
  if (options.allowNpx === false) throw new Error(notInstalledMessage())
  const spec = config.dshPackage.split(" ")[0] ?? config.dshPackage
  return { command: "npx", args: ["-y", spec], route: "npx" }
}

/**
 * Resolve the dsh command once per pi session.
 *
 * @param config - the configuration naming the fallback package
 * @returns the resolved command
 * @throws when neither route can produce a command
 */
export function dshCommandFor(config: DshConfig): DshCommand {
  if (cached !== undefined) return cached
  cached = resolveDshCommand(config, whichOnPath)
  return cached
}

/**
 * Find a program on PATH without shelling out.
 *
 * @param bin - the program name
 * @returns its absolute path, or undefined when PATH does not offer it
 */
function whichOnPath(bin: string): string | undefined {
  const entries = (process.env.PATH ?? "").split(":").filter((entry) => entry.length > 0)
  for (const entry of entries) {
    const candidate = join(entry, bin)
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      // Not executable here; keep looking.
    }
  }
  return undefined
}

/**
 * The message shown when dsh cannot be reached by either route.
 *
 * @returns an actionable message naming both ways out
 */
function notInstalledMessage(): string {
  return (
    "pi-dsh: I could not find `dsh` on your PATH, and I will not fetch it silently. Either install"
    + " it once with `npm i -g @deepseek-ai/dsh`, or let pi-dsh run it through `npx` by fixing your"
    + " network or proxy so `npx -y @deepseek-ai/dsh` works. Run /dsh-doctor to see which route is in"
    + " use."
  )
}
