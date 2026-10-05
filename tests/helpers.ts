import { test } from "node:test"
import assert from "node:assert/strict"
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

/** A temp home so no test touches the real ~/.pi or ~/.dsh. */
export function withTempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "pi-dsh-test-"))
  process.env.PI_DSH_TEST_HOME = home
  return home
}

/** The pi-dsh state dir under the current temp home. */
export function stateDirOf(home: string): string {
  return join(home, ".pi", "agent", "pi-dsh")
}

/** Write a user config file under the temp home. */
export function writeUserConfig(home: string, config: unknown): string {
  const path = join(stateDirOf(home), "config.json")
  mkdirSync(stateDirOf(home), { recursive: true })
  writeFileSync(path, typeof config === "string" ? config : JSON.stringify(config, null, 2))
  return path
}

/** A minimal valid user config body for tests that only care about other fields. */
export function minimalConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    providers: { demo: { apiKeyEnv: "DEMO_KEY", api: "openai-completions", baseURL: "https://example.invalid/v1", models: [{ id: "demo-1" }] } },
    model: { provider: "demo", id: "demo-1" },
    ...overrides,
  }
}

/** Read a file that a test expects to exist. */
export function readIfPresent(path: string): string | undefined {
  return existsSync(path) ? readFileSync(path, "utf8") : undefined
}

/**
 * A PATH entry holding an executable stub named `dsh`.
 *
 * `resolveDshCommand` finds dsh by asking the real PATH whether the file is
 * executable, so a stub is enough to force the `path` route. Without this, a test
 * that asserts "dsh is used directly" passes only on a machine that happens to
 * have dsh installed and fails on CI, where nothing is installed.
 *
 * @returns the directory to put on PATH
 */
export function fakeDshPathDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-dsh-path-"))
  const stub = join(dir, "dsh")
  writeFileSync(stub, "#!/bin/sh\nexit 0\n")
  chmodSync(stub, 0o755)
  return dir
}

/**
 * Run a body with PATH set to `entries`, then restore the previous value.
 *
 * @param entries - the PATH to use, colon-separated
 * @param body - what to run
 * @returns whatever the body returns
 */
export async function withPath<T>(entries: string, body: () => T | Promise<T>): Promise<T> {
  const original = process.env.PATH
  process.env.PATH = entries
  try {
    return await body()
  } finally {
    if (original === undefined) delete process.env.PATH
    else process.env.PATH = original
  }
}
