# Agent tool project contract

## Job

The project declaration gives the Developer Kit enough current, explicit facts
to inspect, check, package, and probe one repository without guessing its
architecture. It is developer configuration, not a portable Capability or
Procedure standard.

The initial schema identity is `openadam.agent-tool-project.v0.1`. The schema
will be implemented under `schemas/` and versioned when its meaning changes.

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
  Agent Host v0.2 integration when the project supports packaging;
- exact component-relative legal files and an owner-supplied SPDX expression;
- two to eight bounded read-only runtime probes, including at least one
  expected success and one expected tool or protocol error.

Unknown fields fail validation. Paths may not be absolute, parent-relative,
URIs, links, or special files. Command arguments are passed directly to the
executable; no shell expansion is performed. Environment values and credentials
are never stored in the declaration.

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
