# dsh-plugin-codegraph-project

English | [中文](README.zh.md) | [Changelog (中文)](CHANGELOG.md)

[![npm](https://img.shields.io/npm/v/dsh-plugin-codegraph-project)](https://www.npmjs.com/package/dsh-plugin-codegraph-project)
[![CI](https://github.com/troytse/dsh-plugin-codegraph-project/actions/workflows/ci.yml/badge.svg)](https://github.com/troytse/dsh-plugin-codegraph-project/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

> **Project-scoped CodeGraph for DeepSeek Harness.** One CodeGraph MCP server per project,
> launched through `npx`, shared by every session working in that project, and visible only
> to sessions whose workspace actually has an index.

## Summary

CodeGraph is excellent and its MCP server has one structural limitation: it resolves "the
project" from its own **process working directory**. Every existing DSH integration therefore
has to answer "which project?" globally — one managed MCP row with one `cwd`, rewritten and
hot-reloaded as you move between projects.

This plugin answers it per session instead:

| Concern | How it is decided here |
| --- | --- |
| Which project is this session in? | The session's own workspace directory (`agent.session.header.cwd`), resolved upward to the first `.codegraph/` that holds a database — the same rule the CLI uses. |
| Which CodeGraph version? | Your choice, in this row's configuration (and overridable in DSH settings). |
| How many servers? | **One per project root**, reference-counted across every session in it. Two sessions in one repo share a single process; two repos get one each. |
| When may a session use the tools? | Only once its project has a real index. A project with no `.codegraph/` cannot call CodeGraph: the call is refused with a reason that states there is no index and gives the `init` command. |
| What if I index the project mid-session? | The tools are injected into that running session within a few seconds. No restart, no new session. |
| What happens to the processes? | They are launched through the harness's managed-subprocess service, so they belong to DSH: closing a session releases its share, and harness shutdown terminates what is left. |

## Install

```sh
# from npm
dsh plugin --profile web add dsh-plugin-codegraph-project

# or a local checkout
dsh plugin --profile web add link:/path/to/dsh-plugin-codegraph-project
```

Restart the profile afterwards (`dsh web`). The package ships a bundle patch, so it inserts
its own row without any composition edit. Requires Node.js 20 or newer, together with a DSH
deployment that provides `@deepseek-ai/dsh-subprocess` and `@deepseek-ai/dsh-tools`.

Nothing else is needed: the server is fetched through `npx` into a plugin-owned cache, so
there is no global CodeGraph install to manage.

## Quick start

Indexing is **your** decision, exactly as upstream intends — this plugin never runs `init`
by itself. For a project you want CodeGraph on:

```bash
npx -y @colbymchenry/codegraph@1.6.0 init -y -- /path/to/project
```

That creates `.codegraph/codegraph.db` (and nothing else in your source tree). Do it while a
session is open and the session picks the tools up within a few seconds; do it before and the
session simply starts with them.

`codegraph uninit -- /path/to/project` removes it again.

## Configuration

Set these on the plugin row in your profile's `cordis.patch.yml` (or wherever the row lives):

```yaml
- id: codegraph-project
  config:
    version: '1.6.0'
```

| Field | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Master switch. When false, nothing is spawned and no tool is registered. |
| `version` | `'1.6.0'` | **The global CodeGraph version**, passed to npx as `@colbymchenry/codegraph@<version>`. The default is the release this plugin was verified against. |
| `packageSpec` | `''` | Escape hatch: a complete package spec that wins over `version` (mirror, private registry, `file:` tarball). |
| `cacheDir` | `''` → `~/.dsh/codegraph/npm-cache` | npm cache used by npx, created if missing. Set it if DSH's `~/.npm` is not writable. |
| `serverName` | `'codegraph'` | MCP namespace; the model-facing name is `mcp__<serverName>__codegraph_explore`. |
| `toolCallTimeoutMs` | `60000` | Per-call timeout for one CodeGraph query. |
| `pollIntervalMs` | `3000` | How often an unindexed workspace is re-checked for a new index. |
| `pollMaxMs` | `0` | Stop watching an unindexed workspace after this long. `0` watches for the session's life. |
| `telemetry` | `true` | Forwards your preference through `CODEGRAPH_TELEMETRY`; this plugin never changes it. |
| `cliProbe` | `true` | Run `npx … version` once at startup and log the outcome. Diagnostics only. |
| `usageGuidance` | `true` | Add a short CodeGraph section to the prompt of mounted sessions only. |
| `diagnosticTool` | `false` | Register a `codegraph_project_status` tool reporting this session's state. |
| `allowHomeProject` | `false` | Serve an index that **is** the home directory (or the filesystem root). The plugin's equivalent of the CLI's `--force`; an index nested in a home directory is always served. |

The same subset is exposed as the DSH settings namespace `codegraph-project`
(`enabled`, `version`, `packageSpec`, `cacheDir`, `toolCallTimeoutMs`, `allowHomeProject`), where
the **user layer wins over the row configuration**. Everything is validated before it is used: an invalid
settings edit is refused and the row configuration stays in force.

### Changing the version

`version` applies to the **next** project connection. Sessions already connected keep the
version they started with — swapping the server under a live session would remove tools that
are in use. Reopen the session (or the project's last session) to move it to the new version.

### What the model sees

One tool per project connection, named exactly as the MCP bridge would name it:

```
mcp__codegraph__codegraph_explore
```

CodeGraph 1.6.0 advertises only `codegraph_explore` by default. To expose more of its tools,
set its own allowlist in the environment; this plugin passes through whatever the server
advertises and never renames or filters it:

```bash
# Child environments are scrubbed and rebuilt from the harness environment, so export it
# where the harness is started (its own row config has no `env` field):
export CODEGRAPH_MCP_TOOLS=explore,node,search,callers
```

When a session is mounted, `usageGuidance` also injects a short section naming the project
root and the available tools, and tells the model to reach for `codegraph_explore` instead of
a grep/read loop. A session without an index gets no such section.

## How it works

- **No index, no CodeGraph.** The gate is a `*.db` inside `.codegraph/`, not the directory's
  existence: CodeGraph keeps runtime files (`daemon.sock`, `codegraph.lock`, `telemetry*.json`)
  in `~/.codegraph`, and a directory holding only those is not a project. Before any project is
  live the tool is not registered at all; once one is, a session whose own workspace has no index
  still cannot call it — the guard refuses, and the refusal names the workspace and the exact
  `init` command.
- **The home directory and the filesystem root are never projects**, even when they contain a
  real index. `~/.codegraph` is both the CLI's runtime directory and the place
  `codegraph init --force -- ~` writes its database, so without this rule a single
  `~/.codegraph/codegraph.db` would become the project of *every* session under `$HOME` — and the
  tool would be offered for a codebase nobody indexed. This mirrors the CLI, which refuses to
  initialize the home directory without `--force` ("it looks like your home directory"). A real
  project nested under `$HOME` (`~/work/api`) still gets served by its own index. Set
  `allowHomeProject: true` for the plugin's equivalent of that `--force`.
- **One request may precede the connection.** A session's tool list is assembled when a model
  request starts, and connecting a project takes about two seconds (faster with `cliProbe`
  having warmed the cache). In an interactive session that means the tool is there before you
  have finished typing; a session driven programmatically may need to wait for the mount before
  its first prompt. The plugin logs one line per project mount naming the pid and tools.
- **Upward resolution.** A monorepo session in `packages/app` is served by the repository
  root's index, and the server runs with that root as its `cwd`.
- **One process per project.** The second session in the same project attaches to the
  existing server; the process is stopped when the last session releases it.
- **Live injection.** An index that appears later is detected by polling the workspace and
  the tools are registered into the live session's scope.
- **Connection loss heals.** If the server dies, the next tool call transparently reconnects;
  a failure during that reconnect is reported as a tool error rather than a silent success.
- **Cold start.** The first use of a version downloads the platform bundle (tens of
  megabytes). Sessions are never blocked by it — the tools appear when the connection is
  ready. `cliProbe` warms the same cache at startup.

### Per-session tool lists (a platform limitation)

This plugin registers its tool definitions on the **root** tool registry and enforces
per-session access with a guard, rather than registering per session. That is deliberate, and
it is the honest shape of the constraint: DSH's tool registry accepts agent-scoped
registrations, but the model's tool list is assembled with `scope: agent` — the *Agent object*,
not the scope key the registry keys its layers by — so an agent-scoped definition never reaches
the model. Measured, in the shipped 0.1.5-rc.2: with a tool registered through `agent.ctx`, the
session's own `schemas(scopeKey)` view contains it while
`systemPrompt.assemble({ agent, scope: agent })` — the call the agent loop makes — returns an
empty list. `restrict()` is evaluated against the scope key as well, so it cannot hide a tool
per session either.

What that means in practice: while at least one project is live, the CodeGraph tools are listed
for every session in the process, and the guard is what keeps a session without an index from
using them. If DSH later assembles the model's tool list from the agent's scope key, the
registration can move back to `agent.ctx` and the list becomes exactly per session.

### Process ownership (no orphans)

Every CodeGraph child is spawned through `ctx.subprocess` (the harness's managed-subprocess
service) rather than a bare `child_process`, which buys four layers of cleanup:

1. Closing a project sends SIGTERM and then SIGKILL after a grace period, and waits for the
   process **group** to be gone.
2. The plugin's own teardown (unload, reload, profile shutdown) closes every live project.
3. Disposing the subprocess service terminates and awaits every managed process — this is
   what runs during harness shutdown.
4. `CODEGRAPH_HOST_PPID` is set to the harness pid, so CodeGraph's own orphan watchdog exits
   the server even if the harness is killed without any chance to clean up.

Closing stdin is tried first, because CodeGraph exits within milliseconds of stdin EOF; the
signals are the backstop for a wedged server.

## Diagnostics

| Symptom | Cause and fix |
| --- | --- |
| No codegraph tool, log says `not-a-project` | `.codegraph/` exists without a database. Run the `init` command above. |
| No codegraph tool, log says `missing` | No `.codegraph/` at or above the workspace, or the walk reached the repository root. Index the project. |
| Log: `could not resolve an npm launcher` | `npx` is not on the harness's `PATH`. Start DSH from a shell that has Node, or set `packageSpec` to a spec npx can still reach. |
| Log: `could not create the npx cache directory` | `cacheDir` is not writable. Point it somewhere writable. |
| Log: a `manifest`/download error | npm could not fetch the bundle (offline, mirror without platform packages, private registry). Set `packageSpec` to a reachable spec. |
| Tool call: "the MCP server is not responding" | The server crashed and the reconnect attempt failed. The log carries the captured stderr tail. |
| Session still on an old version | Sessions keep the version they connected with. Reopen the session. |
| A private registry needs credentials | The harness scrubs credentials out of child environments. Use a cache directory pre-populated with the package, or a `file:`/tarball `packageSpec`. |

Set `diagnosticTool: true` to get a `codegraph_project_status` tool that reports the resolved
project root, why tools are or are not present, the live server pid per project, and the exact
init command for the current version.

## Development

```bash
npm test          # unit + integration, all against a stub MCP server (no network)
npm run lint      # node --check on every source file

# Manual checks against the REAL CodeGraph server (need a warm npx cache or network):
node scripts/real-codegraph-e2e.mjs --version 1.6.0
                  # share one process across sessions, index a project mid-flight, reap it
node scripts/stdio-probe.mjs /path/to/indexed/project 1.6.0
                  # raw NDJSON framing, concurrent calls, stdin-EOF teardown
```

The runtime lives in `lib/`: `locate.js` (project index resolution), `config.js` (row options
and the settings namespace), `transport.js` (managed stdio transport), `pool.js` (per-project
sharing and tool sync), `agent-tools.js` (tool registration and the session guard), `poll.js`
(index watcher), and `index.js` (plugin wiring).

The test suite substitutes a stub MCP server for the real one, so it is deterministic and
offline; `scripts/real-codegraph-e2e.mjs` is the script that verifies the real protocol,
a real query, process sharing, and process reaping, and needs a warm npx cache or network.

CI runs `npm run lint` and `npm test` on Node.js 20, 22, and 24.

### Releasing

1. Add a `## [<version>]` entry to `CHANGELOG.md` (written in Chinese). The publish workflow
   refuses to ship a version the changelog does not document.
2. `npm version <patch|minor|major>` commits the bump and creates the tag; push the commit and
   the tag.
3. `.github/workflows/publish.yml` then runs the tests, checks that the tag matches
   `package.json`, checks the changelog entry, and publishes through npm trusted publishing
   (OIDC) with a provenance attestation, so no long-lived token is stored in the repository.

#### The very first release is manual

The one precondition is a working npm login for the account that owns the package: trusted
publishing authorizes the *workflow*, but nothing can create the package until a human with npm
credentials has published it once. `npm whoami` must answer with the account's name; a token
that has expired makes that fail with `401 Unauthorized` while every read-only npm command
still works, which is worth checking before assuming the package name is the problem.

Trusted publishing cannot create a package that does not exist yet — the trusted-publisher
entry lives on the package's own settings page, so the package has to exist before the workflow
can be authorized to publish it. The first version is therefore published once by hand, from a
clean `main` checkout:

```sh
# 1. publish 0.1.0 from the laptop. `--provenance=false` is required: provenance is generated
#    by CI, and `npm publish` refuses to attest from a local environment.
npm publish --provenance=false --access public

# 2. register the workflow as a trusted publisher (npm 11.15+; prompts for 2FA).
#    The four values must match the workflow exactly.
npm trust github dsh-plugin-codegraph-project \
  --file publish.yml \
  --repo troytse/dsh-plugin-codegraph-project \
  --allow-publish -y
```

Every later release is fully automated by the workflow, with provenance. If a publish run
fails after the tag was pushed, fix the commit, move the tag, and push it again:

```sh
git tag -f v<version> && git push --force origin refs/tags/v<version>
```

If GitHub does not start a run for a tag-object-only update, delete and recreate the remote tag
(`git push origin :refs/tags/v<version>` then push it again).

Run these from a normal terminal. A sandboxed shell that denies writes outside the project
(such as an agent session with `workspace-write` file policy) makes `npm login` and
`npm publish` fail with `EPERM` on `~/.npm/_cacache` — that is the file policy refusing the
write, not a broken npm cache, and no `chown` is needed.

## License

MIT
