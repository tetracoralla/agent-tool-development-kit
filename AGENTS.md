# Agent Tool Development Kit repository contract

Read `docs/PRODUCT_MODEL.md`, `docs/PROJECT_CONTRACT.md`, and
`docs/REVIEW_CONTRACT.md` before changing product behavior, project schemas,
templates, packaging, Agent integration, or installation flows.

This repository owns the external developer experience for creating,
adopting, checking, packaging, and isolated-runtime probing of one Agent tool
product. Its deterministic CLI is the engineering source of truth. Its Skill
owns only unresolved architecture guidance, routing, and interpretation of CLI
results. Agent Host owns installation, host connection, health, update,
rollback, and removal.

## Product boundary

- Do not turn the kit into a Capability or Procedure standard, provider
  registry, marketplace, workflow engine, Agent OS, release approval service,
  or model-facing generic provider invocation surface.
- The developer or their selected Agent proposes whether a product needs a
  Skill, Tool, Capability, Procedure, MCP carrier, CLI, API, library, or human
  surface. Deterministic checks may reject malformed or contradictory declared
  facts; they must not choose those layers or claim product quality, value,
  readiness, publication authority, or owner acceptance.
- Capability and Procedure support is conditional. Reuse their current public
  schemas and runners through explicit versioned dependencies or user-supplied
  paths; never copy their semantic models into this repository.
- Direct Runtime is an optional host execution target for already selected,
  structured, read-only calls. The kit may check and measure compatibility; it
  must not redefine Direct Runtime admission or expose a generic invoke tool.
- The default developer installation carries a CLI and one thin Skill. Do not
  add a persistent MCP server to the ordinary Agent catalog without a verified
  host that cannot use the CLI and a current catalog-cost assessment.

## Safety and artifact rules

- Resolve project-controlled paths against one explicit workspace root. Reject
  absolute, parent, URI, special-file, and symlink escape.
- Represent commands as executable plus argument arrays. Do not run project
  command strings through a shell.
- Keep packed-runtime shutdown claims scoped to what the Kit owns and observes.
  On POSIX this is the isolated process group; a Provider running with
  `OPENADAM_PROBE_MODE=1` must not daemonize, create another session/process
  group, or otherwise escape that scope.
- Scaffold and package through a complete preflight. Dry-run must perform the
  same path, collision, overwrite, and output-boundary checks without writing.
- Never overwrite existing project files unless the caller names the exact
  replace target and the product contract permits it. Preserve a recoverable
  rollback path for material generated-file replacement.
- Keep mutable runtime state, credentials, local paths, check output, and
  benchmarks out of tracked product configuration. Store current observations
  under ignored `.verify/` or a caller-selected output directory.
- Bound complete JSON and human-readable outputs. Ordinary results use
  repository-relative paths and stable error codes; verbose logs are written to
  an artifact instead of flooding Agent context.

## Validation and change discipline

Report development regression, project-contract checks, contract conformance,
isolated Agent runtime, performance and Agent economics, and owner business or
experience acceptance separately. A generated report or green command controls
only its named observable.

Run `npm run check` before proposing repository completion. Run packaged CLI,
scaffold, pack, and isolated-host sequences separately when those surfaces
change. Preserve adjacent repositories as read-only unless the owner has
separately authorized their integration work. Do not commit, push, publish,
install into the user's live Agent environment, sign, or deploy without
explicit owner authorization.
