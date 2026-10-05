import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { changedSince, describeChanges, snapshotWorkspace } from "../workspace.ts"

/** A small project tree: a source file, a scratch file, and a skipped vendor dir. */
function tree(): string {
  const root = mkdtempSync(join(tmpdir(), "pi-dsh-ws-"))
  mkdirSync(join(root, "src"), { recursive: true })
  mkdirSync(join(root, "node_modules", "dep"), { recursive: true })
  writeFileSync(join(root, "src", "a.ts"), "one")
  writeFileSync(join(root, "README.md"), "top")
  writeFileSync(join(root, "node_modules", "dep", "index.js"), "vendored")
  return root
}

test("a run that changes nothing reports nothing", () => {
  const root = tree()
  const before = snapshotWorkspace(root)
  const changes = changedSince(before, snapshotWorkspace(root), root)
  assert.deepEqual(changes.files, [])
  assert.equal(changes.complete, true)
  assert.equal(describeChanges(changes), undefined)
})

test("an edited file is reported by its project-relative path", () => {
  const root = tree()
  const before = snapshotWorkspace(root)
  writeFileSync(join(root, "src", "a.ts"), "two")
  utimesSync(join(root, "src", "a.ts"), new Date(), new Date(Date.now() + 2000))
  const changes = changedSince(before, snapshotWorkspace(root), root)
  assert.deepEqual(changes.files, [join("src", "a.ts")])
})

test("a file the adviser created and one it deleted are both reported", () => {
  const root = tree()
  const before = snapshotWorkspace(root)
  writeFileSync(join(root, "scratch.md"), "new")
  rmSync(join(root, "README.md"))
  const changes = changedSince(before, snapshotWorkspace(root), root)
  assert.deepEqual(changes.files, ["README.md", "scratch.md"])
})

test("generated and vendored directories are never walked", () => {
  const root = tree()
  const before = snapshotWorkspace(root)
  writeFileSync(join(root, "node_modules", "dep", "index.js"), "changed by the adviser")
  const after = snapshotWorkspace(root)
  assert.deepEqual(changedSince(before, after, root).files, [], "node_modules is not part of the report")
  assert.equal(after.files.has(join(root, "node_modules", "dep", "index.js")), false)
})

test("a scan that runs out of budget says so rather than claiming nothing changed", () => {
  const root = tree()
  let clock = 0
  const fast = () => (clock += 10_000)
  const before = snapshotWorkspace(root, fast)
  assert.equal(before.complete, false, "the time budget stops the walk")
  const changes = changedSince(before, snapshotWorkspace(root), root)
  assert.equal(changes.complete, false)
  assert.match(describeChanges(changes) ?? "no change yet", /partial scan/)
})

test("the report names the files, and marks itself partial when it is", () => {
  assert.match(describeChanges({ files: ["src/a.ts", "src/b.ts"], complete: true }) ?? "", /changed 2 file\(s\).*src\/a\.ts, src\/b\.ts/)
  assert.match(describeChanges({ files: ["src/a.ts"], complete: false }) ?? "", /partial scan/)
  assert.equal(describeChanges({ files: [], complete: false }), undefined)
})