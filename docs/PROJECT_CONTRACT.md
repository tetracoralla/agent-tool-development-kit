# Agent tool project contract

## Job

The project declaration gives the Developer Kit enough current, explicit facts
to inspect, check, package, and probe one repository without guessing its
architecture. It is developer configuration, not a portable Capability or
Procedure standard.

The initial schema identity is `openadam.agent-tool-project.v0.1`. The schema
is implemented under `schemas/` and versioned when its meaning changes.

## Pre-project discovery contracts

Two separate v0.1 contracts support discovery before a product repository is
chosen. They are not part of `agent-tool.json` and do not authorize creation.

`openadam.authorized-material-set.v0.1` records one purpose, intended processing
boundary, and 1–32 caller-selected sources. A local source is either one exact
file or an exact list of up to 64 files below one selected directory. A
reference source records a supported Agent-host or external identifier but is
never fetched by the CLI. Files are bounded to 1 MiB each and 8 MiB in total;
links, parent traversal, absolute paths, repeated files/references, changed
bytes during inspection, and directory crawling fail closed. Inspection emits
only relative paths, digests, byte counts, and source metadata.

An `agent-trace` source names one already-exported, exact local Trace Analysis
Pack. The material contract neither exports that pack nor authorizes selected
conversation content. Metadata-only versus content-bearing export remains an
upstream Agent Host privacy choice, and the downstream Agent must preserve the
pack's coverage, truncation, provenance, and unknown semantics.

`openadam.agent-tool-opportunity-proposal.v0.1` binds one proposal to the
current material-set id and digest. It requires task observations with source
references and limits, a seven-part observation-coverage map, counterevidence,
a simpler alternative, explicit product and human-judgment boundaries, a
caller-authored layer hypothesis, a falsifiable validation plan, and preserved
unknowns. The check rejects generated TODOs, unknown source ids, stale material
bytes, duplicate observation ids, and unreferenced observed claims. It never
returns a recommendation, score, rank, readiness, approval, repair priority, or
publication state.

## Required facts

The first version records only facts with current consumers:

- stable project id, version, human name, and one task-oriented summary;
- repository-relative product-model and review-contract paths;
- deterministic project checks represented as executable plus argument arrays,
  timeout, and named validation lane;
- declared Agent carriers and their repository-relative entry points;
- optional Capability provider and Procedure implementation manifest paths;
- a distinct `capability-conformance` or `procedure-conformance` command lane
  whenever the corresponding manifest is declared;
- one explicit package command, component id, repository-relative artifact and
  one closed Agent Host integration when the project supports packaging:
  v0.2 for the MCP execution shape, v0.3 for that shape plus one product
  `skill-cli` discovery route, or v0.5 for separately authorized optional Host
  path roots. These versions are independent shapes; v0.5 does not also accept
  v0.3 discovery;
- direct package probes set `OPENADAM_PROBE_MODE=1` in their credential-free
  temporary process. A Provider may use that signal to remove an otherwise
  open-world route from the current probe behavior and catalog annotation, but
  the flag is not a process or network sandbox. While it is set, the Provider
  must not daemonize, create a new session/process group, reparent work outside
  the Kit-owned process scope, or intentionally keep work alive after stdio
  closure; the live catalog must still report closed read-only annotations
  before the Kit makes any call;
- exact component-relative legal files and an owner-supplied SPDX expression;
- two to eight bounded read-only runtime probes, including at least one
  expected success and one expected tool or protocol error.

Unknown fields fail validation. Paths may not be absolute, parent-relative,
URIs, links, or special files. Command arguments are passed directly to the
executable; no shell expansion is performed. Environment values and credentials
are never stored in the declaration.

For a v0.3 integration, `check` and `pack` require a closed `discovery` object
before any project command runs. Its kind is exactly `skill-cli`; the Skill id
uses lower-case hyphen-case; the Skill root is exactly the declared Codex
plugin's `skills/<id>` directory; its bounded, canonical identity paths include
`SKILL.md`; and its launcher is a canonical path relative to that Skill. The
discovery runtime declares only a component or Suite Node executor, one
contained command, bounded argument arrays, and at least one unique version
argument. During packaging, the Kit additionally binds the command and Skill
identity files to the staged inventory and rejects provider bytes at or below
the Host-owned launcher path. Agent Host, rather than the Provider source or
archive, generates the launcher that forwards to the immutable runtime.
The Kit reacquires the parsed declaration after project checks and after the
package command; a semantic change during either interval fails as
`TOOL_INTEGRATION_DRIFT` instead of sealing stale integration facts.

The package command receives exactly one generated
`OPENADAM_COMPONENT_STAGE` path and writes only the payload there. It does not
author `component.json` or the final archive. The Developer Kit inventories the
staged files, rejects links, special files, bounds and source-machine path
leakage, writes the Agent Host descriptor, normalizes metadata, and publishes a
reproducible `tar.gz`. Project commands are developer-authorized code and are
not an OS sandbox; their inherited environment is allowlisted and credential
variables are absent.

Runtime probes store explicit JSON arguments, expected transport outcome, and
the fixed effect declaration `read-only`. Automatic calls additionally require
the live MCP catalog to advertise closed read-only annotations. Probe success
means only that those exact calls behaved as declared; it is not semantic,
quality, safety, or publication acceptance.

Packed-runtime work distinguishes Developer Kit whole-operation deadline,
caller cancellation, Provider rejection, and operating-system transport
termination using Kit-owned signals. It never infers cause from an SDK or
JSON-RPC number. The one deadline starts at public operation entry and is
consumed by project/archive reads, Host preview, MCP initialization and catalog,
every call or concurrent batch, measurement, and successful persistence. After
deadline or caller cancellation, transport close, temporary cleanup, and one
failure observation may use only the separately disclosed bounded closeout
allowance. A Provider-originated rejection, including JSON-RPC `-32001`, remains
a stage-specific bounded Provider or transport failure with at most one numeric
`protocolCode`; caller cancellation remains
`MEASURE_CANCELLED` through initialization, catalog discovery, and direct
calls. Probe reports its own `PROBE_CANCELLED` across the same phases. A signal
already cancelled before check, pack, probe, or measure may not run a project
command, invoke Host preview, construct a transport, spawn a Provider, publish
an artifact, or create an observation; direct API errors are `CHECK_CANCELLED`,
`PACKAGE_CANCELLED`, `PROBE_CANCELLED`, or `MEASURE_CANCELLED`. In-flight MCP
cancellation initiates bounded owned transport closure before returning. On
POSIX the runtime is started as an isolated process group and the Kit performs
EOF, group TERM, group KILL, and group-absence confirmation. Its termination
record names that scope and reports work outside it as not observable. The
Windows source route captures the owned process tree, applies bounded
`taskkill /T` and `/F`, and confirms the captured PIDs are absent; processes
outside the captured set are likewise not observable. A failure to confirm the
owned scope is `PROBE_RUNTIME_TERMINATION_FAILED` or
`MEASURE_RUNTIME_TERMINATION_FAILED`; unsettled work or temporary-runtime
removal failure is `PROBE_RUNTIME_CLEANUP_FAILED` or
`MEASURE_RUNTIME_CLEANUP_FAILED`. A failed observation may say
`cleanup: completed` only when pending work settled, every started Provider's
owned process scope is confirmed absent, and the temporary runtime was removed.
It does not establish absence of a Provider process that violated the contract
by escaping that scope. If pending work remains unsettled or the owned scope is
unconfirmed, the extracted runtime remains retained rather than being removed
under possible live work. A closeout timeout remains distinct from Provider
success.
Measurement observation directories are created only when a result is
persisted; an early failure may not leave an empty observation directory or an
extracted runtime behind. A failure record that was successfully written is
retained for interrupted-Agent recovery.

The Kit does not embed or guess standards-runner arguments. A declared
Capability or Procedure manifest must be paired with the repository's exact
current conformance command in its dedicated lane. `check` then executes that
argv under the same deadline, environment, and result bounds as other checks.
This establishes only that the named current runner exited successfully; live
installation, permissions, endpoint health, substitution, and product quality
remain separate.

## Authority

The declaration is authored by a developer or their selected Agent and accepted
through ordinary repository review. Its existence does not establish that the
facts are current, the chosen layers fit, checks passed, the product is safe,
or publication is authorized. Every operation reacquires the referenced paths
and current command result.

The kit may report malformed declarations, missing files, version drift,
contradictory carrier facts, failed named checks, and unavailable optional
contract runners. It may not return recommended layers, readiness, ranking,
approval, allowed claims, repair priority, or publication state.

## Lifecycle

`inspect` reads a repository without creating the declaration. `init` may write
one only after complete preflight and explicit template selection. Adoption of
an existing repository requires the Agent or developer to author the declared
facts; the kit does not infer and persist them automatically.

When the schema changes, the CLI either reads the old version through an
explicit compatibility path or returns a stable unsupported-version error. It
never silently rewrites a declaration during inspection or checking.
