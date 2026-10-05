# pi-dsh

> pi-dsh is a Pi extension that turns a second agent — a DeepSeek Harness (`dsh`) runtime — into an
> external adviser. You ask a question in Pi, the adviser answers from its own clean context, and you
> can follow up on that answer without re-sending the conversation. It is meant for second opinions,
> isolated deep dives, and work that should happen in its own workspace discipline.

## Start here

- Install the extension and the harness, then confirm the environment is ready: `/dsh-doctor`.
- Write your first adviser session: `/dsh <task>`.
- Continue it later — in this project, Pi remembers it as session `#1`: `/dsh-follow <text>`.
- See what else exists: `/dsh-sessions`, `/dsh-status`, `/dsh-doctor`.

## Install

```sh
pi install <path-to-pi-dsh>
```

Pi loads the extension from `index.ts` directly; there is nothing to compile and no runtime
dependency to install.

### The dsh runtime

pi-dsh drives `dsh`, the DeepSeek Harness. It finds it in whichever of these works, and
`/dsh-status` tells you which one it used:

1. `dsh` already on your `PATH`;
2. otherwise `npx -y @deepseek-ai/dsh@<pinned version>`, which fetches and runs it for you — this
   needs network access on first use.

To install it permanently instead:

```sh
npm i -g @deepseek-ai/dsh
```

## Configure

Your configuration lives in one file:

```sh
~/.pi/agent/pi-dsh/config.json
```

The first time pi-dsh loads, it creates that file from the extension's `config.example.json` and
tells you it needs editing. Only two things are required — a provider and a default model:

```jsonc
{
  "providers": {
    "myprovider": {
      "displayName": "My Provider",          // optional, shown in listings
      "apiKeyEnv": "MY_PROVIDER_API_KEY",    // env var holding the key — never put the key here
      "api": "openai-completions",           // or "openai-responses" / "anthropic-messages"
      "baseURL": "https://api.example.com/v1",
      "compat": { "maxTokensField": "max_tokens" },  // optional; only if the endpoint needs it
      "headers": { "X-Title": "My Tool" },           // optional; extra request headers
      "models": [
        { "id": "some-model", "name": "Some Model", "input": ["text"], "contextWindow": 200000 }
      ]
    }
  },
  "model": { "provider": "myprovider", "id": "some-model" }
}
```

Then export the key and check readiness:

```sh
export MY_PROVIDER_API_KEY=…     # in the shell that starts pi
```

Three environment variables override one scalar each, for the things you switch most often:
`PI_DSH_DSH_PROFILE` (dsh profile name), `PI_DSH_PROJECTS_DIR`, and `PI_DSH_DEFAULT_MODEL`
(`provider/id`). Everything else, including every optional field — `dshProfile`, `dshPackage`,
`projectsDir`, `timeoutMs`, `maxResultChars`, `pruneAfterHours`, `purgeDsshSessions`,
`dshProviders` — is documented in [LLMS.txt](./LLMS.txt), the reference for you and for an agent
configuring this for you.

`/dsh-model` changes the default model and saves it into `config.json` (keeping the previous file
once as `config.json.bak`), so you rarely need to edit that key by hand.

## Commands

| Command | What it does |
|---|---|
| `/dsh <task>` | Start a **new** adviser session in this project; announces the new `#n` |
| `/dsh-follow <text>` | Continue this project's latest session |
| `/dsh-follow #<n> <text>` | Continue one particular session |
| `/dsh-sessions` | List this project's sessions and when each was last used |
| `/dsh-delete #<n>` | Delete one adviser session, after you confirm |
| `/dsh-status` | Project, sessions, model, dsh profile, which dsh route is in use |
| `/dsh-model [provider/model]` | Show the models you can use, or switch to one |
| `/dsh-doctor` | Check everything below and report what is wrong in plain language |

The assistant itself can also delegate to the adviser, so you can simply ask it for a second
opinion in the conversation.

### Sessions belong to a project

Each adviser session is a conversation with its own memory, owned by the project directory you
started pi in. Two projects never share sessions, and each session has an index (`#1`, `#2`, …) that
is never reused, so `#3` always means the same conversation. Pi stores them under
`~/.pi/agent/pi-dsh/projects/`, one directory per project path.

A session is meant to be short-lived: it exists while you follow up on one issue. Sessions idle for
longer than `pruneAfterHours` (7 days by default) are cleaned up when you next use the project, and
the latest session is never cleaned up. Start a new session with `/dsh` when you move to a different
question.

## Providers that come from dsh plugins

Some providers ship as a dsh plugin rather than as a route pi-dsh can describe. Install one with
dsh's own command:

```sh
dsh plugin --profile pi-advisor add dsh-llm-zenfree
export OPENCODE_API_KEY=…            # if the plugin needs a key
```

pi-dsh notices the routes such a plugin adds, and they show up in `/dsh-model` under
`routes from dsh plugins:`. Their model list is fetched from the provider at run time, so pi-dsh
shows the routes rather than a model list; choose a model with `/dsh-model <route>/<model>`. If a
route is not detected, list it yourself with the `dshProviders` field in your config.

## What the adviser may do

The adviser is a **trusted component, not a sandboxed one**. It runs as you, inside the project
directory pi was started in, with dsh's `workspace-write` permissions. Concretely:

- **Reads are unrestricted.** dsh's file sandbox fences writes, not reads: the adviser can read any
  file this process can read, including files outside the project, your other projects, and
  `~/.pi/agent/`. There is no knob in dsh that confines reads, so treat everything reachable from
  your account as visible to it. It also has a shell and network access, so confining reads without
  confining network would be theatre.
- **Writes are confined** to the project directory and the platform temporary directory. Anything
  else is refused, and because an unattended run has nobody to ask, the refusal is immediate rather
  than a prompt.
- **It is a real agent**, not a reviewer: it runs commands, spawns its own subagents, and fetches
  from the network unless you disable those.

`permissionMode` (`read-only`, `workspace-write`, `danger-full-access`) sets the mode for **new**
sessions. Once a session has a mode, that is the mode it keeps: dsh records it in the session's own
log — at creation, or at the first later run that adopts the session — and from then on resolves the
session's permissions from that record rather than from any environment variable. It cannot be
changed afterwards. pi-dsh records the mode on the session, re-supplies it on every follow-up, and
**refuses a follow-up that asks for a different mode** rather than quietly ignoring it. Start a new
session instead. `/dsh-status` shows the mode new sessions get and the modes existing sessions hold.

The `dsh_advise` tool is capped at `workspace-write`: a model cannot widen its own permissions to
`danger-full-access`, though you can set that mode yourself for `/dsh`.

Every run reports which project files it changed, by comparing the tree before and after the run.
Writes outside the project — `/tmp`, for instance — do not appear in that list.

Each run is bounded by `timeoutMs` (15 minutes by default) and can be cancelled. Nothing pi-dsh does
touches Pi's own conversation history.

### What the adviser inherits

dsh runs as a child process, so it would otherwise inherit every credential in the shell that started
pi. pi-dsh does not do that: the child gets an allowlist — the provider keys your configuration
names, everything under `DSH_`/`PI_DSH_`, and the usual `PATH`, `HOME`, and locale variables. Name
anything else the adviser legitimately needs in `envAllowlist`:

```json
"envAllowlist": ["OPENCODE_API_KEY"]
```

`/dsh-doctor` lists the credential-like variables being withheld, and flags a plugin route whose key
is missing from `envAllowlist` — that route would fail to authenticate.

### Turning capabilities off

`disabledTools` names dsh profile rows to disable for the adviser, passed on every run as a launcher
overlay:

```json
"disabledTools": ["tool-web", "tool-subagent"]
```

Tool availability is a profile-row property rather than a session permission, so unlike the mode this
also applies to sessions that already exist. `tool-web` is the one worth considering: without it the
adviser can still read your files but cannot fetch a URL to send them to.

## If something is wrong

Run `/dsh-doctor` first: it checks your configuration, whether dsh is reachable and by which route,
whether the dsh profile was created, the permission mode new sessions would get, which credentials
are withheld from the adviser, and whether every provider key is actually set in the environment.

| Symptom | Cause and fix |
|---|---|
| `could not find dsh on your PATH` | Install it (`npm i -g @deepseek-ai/dsh`) or let the `npx` route work — it needs network or proxy access |
| `I created your configuration at …` | The first run made `config.json` from the template; add a provider and a model |
| `no usable provider is configured` | `providers` is empty or missing `apiKeyEnv` / `api` / `baseURL` / `models` |
| `your configuration file is not valid JSON` | A trailing comma or a missing quote; the file is plain JSON with no comments |
| `permissionMode must be one of …` | It is `readonly`, not `read-only`; a bad mode is an error rather than a silent downgrade |
| A plugin route fails with an auth error | Its key is not in `envAllowlist`, so the adviser cannot see it; `/dsh-doctor` names it |
| `dsh pins a session's permissions for life` | That session was created in another mode; start a new one instead of following up |
| Run fails with a provider auth error | The key is not exported in the shell that started pi; `/dsh-doctor` names the variable |
| `there is no session #7 in this project` | That index was deleted or pruned; `/dsh-sessions` lists what exists |
| The adviser cannot write outside the project | Expected: `workspace-write` covers the project directory plus the temp directory |

## For agents

[LLMS.txt](./LLMS.txt) is the machine-readable companion: what this extension is, how to verify an
environment, every configurable field and its default, how to add a provider or a plugin-provided
route, and the symptom-to-fix table above.

## Development

```sh
node --test tests/*.test.ts
```

The suite needs no network, no `dsh`, and no real configuration: it injects a temporary home, a fake
`PATH`, and captured dsh output.