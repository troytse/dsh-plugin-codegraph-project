# Changelog

All notable changes to this plugin are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses semantic
versioning.

## [0.1.0] - 2026-09-21

### Added

- One CodeGraph MCP server per project root, launched through `npx` and shared by reference
  count across every session working in that project.
- Per-session project resolution: the session's workspace directory is resolved upward to the
  first `.codegraph/` that holds an index database, matching CodeGraph's own rule.
- Per-session tool registration: the bridged tool is registered in the agent's own scope, so
  a session only ever sees CodeGraph for the project it is in.
- Live injection: a project indexed while a session is running gets its tools within a few
  seconds, without restarting the session.
- Global version selection through the row configuration (`version`, `packageSpec`), plus a
  `codegraph-project` settings namespace for user-level overrides of the same knobs.
- Managed process ownership: every child is launched through `ctx.subprocess`, so closing a
  session releases its share, harness shutdown terminates the rest, and
  `CODEGRAPH_HOST_PPID` covers a harness killed outright.
- Optional prompt guidance for mounted sessions only, and an opt-in
  `codegraph_project_status` diagnostic tool.
- Tests: unit coverage for index resolution, configuration, schema normalization, the
  transport, the pool, agent-scope installation, and the index watcher; an integration suite
  that mounts the plugin into a real Cordis runtime against a stub MCP server; and a manual
  end-to-end script that verifies sharing, mid-flight indexing, and process reaping against
  the real CodeGraph server.
