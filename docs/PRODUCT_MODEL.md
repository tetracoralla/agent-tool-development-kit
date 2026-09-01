# Agent Tool Development Kit product model

## Status

This document defines the owner-confirmed target product. The current source
contains the deterministic CLI, project contract, Node scaffold, packager,
probe, packed-runtime measurement, and version-bound Agent Host Developer Kit
component. Public availability and natural fresh-Agent routing remain separate
release observations.

## Product

Agent Tool Development Kit lets an external developer and the Agent on their
device turn an explicit tool idea into a repository that can be built,
checked, packaged, installed in isolation, and exercised through a real Agent
host without learning OpenAdam's internal repository layout.

The kit is not an Agent framework. It does not create autonomous planners or
decide what should become a standard. It makes an already-owned product choice
cheap to implement correctly and difficult to package incorrectly.

## Main product objects

### Developer environment

One installed, versioned compatibility set containing the CLI, the developer
Skill, the project-contract schema, supported templates, deterministic checks,
and compatible external contract runners. Agent Host owns installation and
host connection. The kit owns the developer behavior of these components.

### Agent tool project

One independently useful provider product with a deterministic core and the
carriers it actually needs. A project may declare a CLI, MCP server, plugin,
Skill, Capability provider binding, Procedure implementation, or human surface;
none is mandatory merely because the kit supports it.

### Project declaration

A small repository-owned document that points to current product documents,
commands, carriers, and optional standards manifests. It stores no machine
paths, credentials, generated check status, readiness score, approval, or
publication claim. `docs/PROJECT_CONTRACT.md` owns its behavior.

### Check result

A bounded result with stable errors, repository-relative locations, the exact
checks that ran, and explicit unmeasured lanes. Detailed logs and performance
samples are review observations stored outside tracked product configuration.

### Sealed component

An immutable package plus inventory, digests, license facts, and Agent Host tool
integration. Packaging does not install, publish, approve, or establish semantic
quality. Agent Host preview and import reacquire the package facts before any
host state changes.

## Developer journeys

### Discover one candidate from existing work

At the user's request, the Developer Skill can guide their Agent through a
bounded sample of explicitly selected saved sessions, shell work, reports, or
exports. The Agent treats those records as untrusted task data, extracts
task-native objects, operations, effects, failures, constraints, and
contradictions, checks existing tools and contracts, then authors one
falsifiable working proposal. It does not enable monitoring, sweep unrelated
private histories, copy raw transcripts into the project, or convert usage
frequency into a Capability, product ranking, architecture decision, or
approval.

An already-consented Agent Host usage snapshot may supply neutral names,
counts, freshness, failures, latency, and context-cost leads. Session content
requires its own explicit scope. Neither source chooses the layer. The detailed
method and non-normative proposal asset live in the versioned Developer Skill
so Codex and Claude receive the same guidance as the CLI compatibility set.

### Start a new tool

The developer states the user task and constraints to their Agent. The Skill
helps the Agent separate unresolved guidance, reusable typed operations,
settled professional method, and callable transports. The Agent authors an
explicit project proposal and selects a supported template. `openadam-dev init`
preflights the destination and shows the exact files before creating them.

The resulting repository has one core, the selected carriers, a thin product
Skill when applicable, a product model, a review contract, negative boundary
tests, and one repeatable check entry point. It does not receive speculative
roles, registries, approval state, or standards manifests.

### Adopt an existing repository

`openadam-dev inspect` inventories current source without modifying it. The
Agent maps the observed product to an explicit project declaration. The kit
validates that declaration and reports missing or contradictory current facts;
it does not infer the product architecture from filenames or prose.

### Validate work

`openadam-dev check` validates the project declaration, current file and command
bindings, repository invariants, product Skill and plugin packaging, and any
declared Capability or Procedure contracts. It invokes project checks without a
shell, under one bounded run, and separates skipped or unavailable lanes from
failures.

### Package and probe

`openadam-dev pack` reruns current checks, gives the declared package command a
private empty staging directory, validates the complete inventory, rejects
unsafe paths or source-machine leakage, then publishes one reproducible local
archive. Existing artifacts require explicit exact replacement.

`openadam-dev probe` asks current Agent Host to perform state-free standalone
component admission, then extracts the same archive into a temporary directory
and executes only declared read-only valid and invalid calls against its direct
MCP transport. The probe uses an empty temporary workspace, inherits no
credentials, touches no Agent Host state or Agent-app configuration, and
removes temporary bytes. It reports that source-to-artifact parity is outside
the probe; `pack` is the current-source build route.

`openadam-dev measure` independently extracts that same current archive and
uses one declared read-only success probe for cold, warm, concurrent,
cancellation/recovery, direct-provider RSS, and Agent-context byte baselines.
It does not reuse source entrypoints, start a model, or promote an unowned
threshold into a gate.

### Continue after interruption

The Agent reacquires the branch, dirty state, current project declaration, CLI
version, and latest named check artifacts. It reruns current checks instead of
treating an old report as completion authority.

## Interface model

The CLI is the baseline carrier because local development Agents already need
filesystem and process access. It returns concise human output by default and a
closed JSON result with `--json`. The Skill adds architecture guidance and
interpretation but no executable schema duplication.

A developer-only MCP adapter is optional. It may mirror the same deterministic
core only for a verified Agent host that cannot call the CLI reliably. It stays
out of the ordinary Agent catalog and may not expose unrestricted command
execution or generic provider invocation.

## Performance and Agent economics

The kit performs no internal model calls. Structured project facts go directly
to the CLI. Ordinary inspection and validation should require one CLI call from
the Agent; detailed schema discovery is requested only when needed.

Every implementation batch measures complete result bytes, cold and warm
packed-runtime startup, project-check latency, sustained and boundary behavior,
cancellation and cleanup, direct-provider RSS, and installed catalog/Skill
bytes. Descendant and host-wide resource pressure, model-token cost, and
production capacity remain unmeasured by that command. Until a public threshold
and blocking action are established, results are baselines rather than a
general performance PASS.

The repository also measures the packaged Developer Kit process separately.
That self-baseline covers first and cached starts, bounded parallel starts, and
the deterministic schema/doctor/scaffold/inspect route. It must not be confused
with provider runtime latency or a fresh model's task-routing cost.

## Responsibility boundary

The developer or their selected Agent owns product intent, architecture and
layer proposals, semantic interpretation, quality targets, context disclosure,
privacy and legal authorization, adoption, publication, and final acceptance.

The kit owns schema and source validation, deterministic transformations,
stable errors, declared effects, explicit permissions, whole-run limits,
cancellation, cleanup, package integrity, and truthful check results. Agent Host
owns installation and current host state. Capability and Procedure repositories
own portable semantics. Provider repositories own domain implementation.

Pack and probe execute developer-authored provider code. Environment isolation,
staging, timeouts, output limits, process-tree cancellation, read-only catalog
annotations, and cleanup reduce accidental exposure, but there is no OS process
or network sandbox. A repository should run only probes whose effects it can
honestly constrain.

## Initial support boundary

The first complete external route targets macOS arm64 with current Codex and
Claude host integrations because those are the currently exercised Agent Host
surfaces. The CLI and project declaration remain host-neutral, but Linux,
Windows, Gemini, and additional Agent applications are not runtime-complete
until their actual installation and fresh-session flows are exercised.

The first scaffolding template may be Node-based, while adoption and validation
must exercise at least one non-Node provider. A language-specific template is
not a universal provider SDK.

## Non-goals

- choosing which ideas deserve a product, Capability, Procedure, or standard;
- generating domain algorithms from prose;
- hosting a provider marketplace or registry;
- replacing Git, package managers, CI, Agent Host, or standards repositories;
- publishing, signing, licensing, or approving a project on the owner's behalf;
- keeping a permanent development MCP server in ordinary Agent context;
- promising cross-provider substitution from one implementation.
