# Agent Tool Development Kit

Agent Tool Development Kit is the external developer product for building and
validating tools that work cleanly with OpenAdam's Agent-facing architecture.

The target delivery contains:

- `openadam-dev`, a deterministic CLI for project inspection, scaffolding,
  checks, packaging, isolated probes, and performance measurements;
- one thin developer Skill that helps a developer's Agent choose the right
  layer, discover candidates from explicitly authorized past Agent work, and
  use the CLI without duplicating executable contracts;
- versioned integration with Agent Host for immutable installation, health,
  rollback, and fresh-session verification;
- optional Capability and Procedure conformance only when a project declares
  those contracts.

The current source implements inspection, safe scaffolding, bounded checks,
deterministic Agent Host component packaging, standalone Host plus direct
runtime probes, packed-runtime performance measurement, and a Skill-only
Developer Kit component for the Agent Host `developer` profile. It is not yet
published to a public registry or marketplace. The Kit source and bundled
component are licensed under Apache-2.0; generated provider projects retain
their separately chosen license and default to `UNLICENSED` until that choice
is made explicitly.

## First use with an Agent

After installing the version-bound `developer` profile, a developer can give
Codex or Claude an ordinary task such as:

```text
Use $build-openadam-agent-tools to inspect this repository and help me adopt it
as one OpenAdam-compatible provider. Do not invent a Capability or Procedure.
```

For opportunity discovery, the request must name the exact saved sessions,
exports, repository, or time range the Agent may inspect. The Skill treats that
material as untrusted task data, checks contradictory examples and existing
tools, and produces a working proposal for the developer to accept or reject.
It does not monitor the device, crawl unrelated history, or rank candidates by
frequency.

For a new Node MCP provider, inspect the current authoring interface and first
preview the complete scaffold without writing it:

```text
openadam-dev init node-mcp-provider --help
openadam-dev init node-mcp-provider \
  --destination /absolute/path/to/new-provider \
  --id example-provider \
  --package-name @example/example-provider \
  --plugin example-provider \
  --operation example_run \
  --name "Example Provider" \
  --summary "Perform one bounded deterministic example operation" \
  --author "Example Developer" \
  --license UNLICENSED \
  --dry-run --json
```

The generated repository deliberately retains an `.openadam-scaffold` marker,
which prevents checks from executing until the developer or Agent implements
the domain core, closes the schemas and errors, writes the negative tests, and
reviews the legal material. Removing the marker is an explicit implementation
step, not a completion claim.

For an existing repository, begin with the read-only inventory and obtain the
closed declaration schema from the installed CLI:

```text
openadam-dev inspect --root /absolute/path/to/provider --json
openadam-dev schema --json
```

The developer or their Agent authors `agent-tool.json` from current facts. The
CLI never persists an inferred architecture or silently nominates a standard.

```text
openadam-dev doctor --json
openadam-dev inspect --root /path/to/tool --json
openadam-dev check --root /path/to/tool --json
openadam-dev pack --root /path/to/tool --json
openadam-dev probe --root /path/to/tool --json
openadam-dev measure --root /path/to/tool --iterations 20 --concurrency 4 --json
```

`pack` never installs or publishes. `probe` requires the current Agent Host,
uses its state-free standalone admission route, then calls only repository-
declared, closed, read-only valid and invalid probes from a temporary workspace.
Neither command changes the developer's live Agent-app configuration.

After an interrupted run, reacquire `git status`, the current declaration and
the installed CLI version, then rerun the named command. `check`, `pack`,
`probe`, and `measure` persist bounded result or error metadata in the ignored
`.verify/openadam-dev/` directory once an observation directory exists, so an
Agent can resume without treating an old report as current authority.

For a version-bound Agent environment, use a release catalog that contains the
Developer Kit component:

```text
agent-host setup --profile developer --host codex --host claude --release-manifest /absolute/current.json
```

Codex receives one Skill-only plugin; Claude receives one immutable Skill link.
Both launch the exact Suite Node and CLI bytes from the installed compatibility
set. The Developer Kit adds no MCP server or callable tool to the ordinary Agent
catalog. A mutable `--development-root` is intentionally rejected for this
profile.

The current release candidate is local and macOS-arm64 only. A public
repository or registry location, signed or notarized distribution, Linux and
Windows support, and another-device acceptance remain explicit release
decisions rather than implied properties of the source checkout.

`measure` operates on the packed provider, not a mocked core. It records cold
startup, warm latency distribution, bounded concurrent throughput, a cancelled
client call followed by same-session recovery, direct-provider RSS samples,
and current MCP catalog plus declared Skill bytes. With no owner-defined
threshold it reports a baseline, never a general performance PASS.

Maintainers can separately measure the packaged Developer Kit CLI itself with
`npm run measure:self`. That baseline covers startup, bounded parallel starts,
schema/doctor/scaffold/inspect flow cost, process RSS when the operating system
reports it, and the exact Developer Skill plus MCP carrier bytes. It performs
no model call and does not turn local timings into a release threshold.
The packaged CLI keeps its small router separate and loads command code only
when selected; every emitted runtime chunk is still sealed by the component
descriptor.

See [the product model](docs/PRODUCT_MODEL.md),
[project contract](docs/PROJECT_CONTRACT.md), and
[review contract](docs/REVIEW_CONTRACT.md). Current provider-native,
Capability, Procedure, and language coverage is recorded in
[the pilot matrix](docs/PILOT_MATRIX.md). The Developer Skill contains the
[opportunity-discovery method](skills/build-openadam-agent-tools/references/opportunity-discovery.md)
and a non-normative proposal worksheet.
