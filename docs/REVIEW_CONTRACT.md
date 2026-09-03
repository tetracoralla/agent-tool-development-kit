# Agent Tool Development Kit review contract

This contract is the minimum product-specific review coverage, not a completion
script. Reconstruct the current CLI, project schema, templates, Skill, package,
and Agent Host integration before using these leads, then perform an independent
discovery pass from the current product model and visible commands.

## Development regression

- Parse, type, unit, integration, package, legal, and repository checks use the
  current source and finish without modifying adjacent repositories.
- Project schema, runtime validation, generated examples, and CLI help remain
  mechanically aligned.
- Every fixed guard, ambiguity, drift, limit, or recovery defect has the
  smallest negative regression.

## Project authority and mutation

- Inspect a valid project plus missing, malformed, unsupported-version, unknown
  field, absolute-path, parent-path, URI, symlink, special-file, and oversized
  declarations.
- Verify project commands execute without a shell and that cancellation or
  timeout terminates the complete child tree and releases admission.
- Exercise init and pack collision, exact replacement authority, staging
  cleanup, dry-run parity, interrupted publication, and rollback. No ordinary
  failure may hide a created or replaced artifact.
- Rebuild identical payload bytes twice and compare the complete archive digest;
  reject source-root aliases, file-URI leakage, links, special files, duplicate
  archive paths, incomplete identity, empty legal material, and malformed SBOM.
- For Agent Host v0.3, reject missing or unknown discovery fields, invalid or
  mismatched Skill roots, escaped/URI/oversized identity and launcher paths,
  missing `SKILL.md`, invalid or repeated version argv, absent discovery runtime
  bytes, and provider-owned launcher collisions. Keep v0.2 and the independent
  v0.5 shape covered separately.
- Change a valid integration during a project check and during the package
  command; both sequences must fail closed before archive publication.
- Verify reports contain repository-relative paths, stable errors, explicit
  skipped/unavailable lanes, and complete-envelope byte bounds.

## Layer and contract integrity

- A project with no Capability or Procedure declaration is not failed for
  lacking them.
- A declared Capability runs current provider-manifest drift, canonical adapter
  conformance, and live transport conformance as separate lanes.
- A declared Procedure runs current manifest, result, stage-binding, and
  composition checks as applicable, without copying either standard.
- Candidate lint may reject an Agent-authored proposal but never chooses a
  layer, route, provider, claim, readiness state, or next action.
- Opportunity discovery starts from one closed authorized-material manifest.
  Local files and repository/Skill selections are exact and bounded; reference
  sources are not fetched; directories, private histories, sibling repositories,
  and generic Skill roots are not crawled. The result persists no raw content
  and preserves the difference between observed tool calls and unavailable
  Skill activation, non-use reason, semantic effect, or result adoption. An
  `agent-trace` input preserves its adapter identity, content policy,
  truncation, provenance, and unknowns; a material manifest never substitutes
  for upstream sensitive-content consent. A
  consequential adoption/effect claim requires a controlled task-native
  comparison or contemporaneous explicit Agent assessment.
- Under an explicitly authorized broad-history scope, verify corpus coverage
  and opportunity recall separately. Reproduce a multi-label root-job pass,
  inspect bounded representatives, contradictions, and outliers, and require a
  disposition for every material semantic cluster before accepting a
  portfolio-wide “no Provider opportunity found” assessment. Parsing/counting
  all records, one lexical route, or one preselected infrastructure hypothesis
  is insufficient. External research must challenge the surviving portfolio,
  not only the first selected candidate.
- Proposal init binds current material bytes but produces an explicitly
  incomplete draft. Proposal check rejects placeholders, material drift,
  unlisted source references, missing counterevidence, missing simpler
  alternatives, and lost unknowns while never choosing a layer or approving
  development.
- Direct Runtime compatibility is reported separately from semantic
  conformance, installed availability, credentials, permissions, endpoint
  health, and business acceptance.

## Agent route and installation

- Install the packaged developer environment into isolated Agent Host state and
  verify CLI and Skill versions agree.
- In fresh Codex and ZCode sessions, issue ordinary authorized-material,
  new-project, and existing-project requests; record Skill activation, CLI calls, retries,
  generic fallback, and result bytes. Use host-native activation observations
  when available; otherwise report activation from the controlled Agent trace,
  not from passive Skill inventory.
- The ordinary Agent catalog must not gain a persistent Developer Kit MCP tool.
  If a developer-only MCP adapter exists later, measure its complete catalog
  cost and verify disabled-state absence.
- Package and probe one ordinary provider-native tool, one Capability provider,
  and one Procedure implementation, across at least two implementation
  languages. Preserve provider-specific errors and semantics.
- Standalone preview must read or write no Agent Host state or Agent-app
  configuration. Direct probe calls require current closed read-only annotations,
  cover one expected success and one expected error, bound every result, and
  clean the extracted runtime after success, mismatch, timeout, and cancellation.

## Performance and recovery

- Measure cold and warm CLI startup, representative inspect/check/pack/probe
  latency, sustained use, tail behavior, peak resource use, cancellation,
  cleanup, and subsequent recovery.
- Use the packaged Developer Kit self-baseline for CLI startup and the packed
  provider measurement for direct runtime calls; neither can substitute for
  the other or for a comparable fresh-Agent task.
- Make an extracted MCP runtime accept stdio but withhold its initialize reply.
  The API and CLI must return one bounded `MEASURE_RUNTIME_CONNECT_TIMEOUT`,
  close the Provider process, remove the extracted runtime, retain a written
  failure result without leaving empty observation directories, and complete a
  subsequent successful measurement after the runtime is repaired.
- Make another runtime immediately reject initialize with JSON-RPC `-32001`.
  The Kit's own deadline must not be inferred from that remote numeric code;
  API and CLI must return a separate bounded runtime-connect failure, perform
  the same cleanup, and recover after repair.
- Pre-cancel an MCP connection and cancel another while initialize is pending.
  Pre-cancel must not construct a transport or spawn a Provider. Measure and
  probe must use their own stable cancellation errors; API and signal-driven
  CLI cancellation must persist bounded results, clean child and temporary
  resources, leave no empty observation directory, and recover afterward.
- Enforce cumulative input, file, check-count, timeout, log, result, and artifact
  inventory bounds. Large diagnostics go to ignored artifacts and cannot flood
  the Agent response.
- Compare Agent-mediated and direct structured routes only under comparable
  inputs and environments. Do not infer universal savings or a performance
  PASS without an owned threshold.

## Verdict lanes

Report separately:

- development regression;
- project-contract and mutation safety;
- Capability and Procedure conformance, when declared;
- isolated Codex runtime;
- isolated ZCode runtime;
- optional Claude compatibility runtime when a user-owned supplier is available;
- performance, load, and Agent economics;
- external documentation and fresh-developer usability;
- owner business and experience acceptance.

Finish with `tools-dev workspace escalations`, naming any standards drift,
Agent Host integration issue, Direct Runtime conflict, duplicate abstraction,
shared resource risk, or adjacent repository change still required. Local green
checks do not compose into workspace or external-release acceptance.
