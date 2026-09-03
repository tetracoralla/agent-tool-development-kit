# Agent Tool Development Kit

Agent Tool Development Kit is the external developer product for building and
validating tools that work cleanly with OpenAdam's Agent-facing architecture.

The target delivery contains:

- `openadam-dev`, a deterministic CLI for authorized-material inspection,
  source-bound opportunity proposals, project inspection, scaffolding, checks,
  packaging, isolated probes, and performance measurements;
- one thin developer Skill that helps a developer's Agent choose the right
  layer, discover candidates from any explicitly authorized material, and
  use the CLI without duplicating executable contracts;
- versioned integration with Agent Host for immutable installation, health,
  rollback, and fresh-session verification;
- optional Capability and Procedure conformance only when a project declares
  those contracts.

The current source implements bounded material inspection, opportunity draft
generation and checking, repository inspection, safe scaffolding, bounded
checks, deterministic Agent Host component packaging, standalone Host plus
direct runtime probes, packed-runtime performance measurement, and a Skill-only
Developer Kit component for the Agent Host `developer` profile. It is not yet
published to a public registry or marketplace. The Kit source and bundled
component are licensed under Apache-2.0; generated provider projects retain
their separately chosen license and default to `UNLICENSED` until that choice
is made explicitly.

## First use with an Agent

After installing the version-bound `developer` profile, a developer can give
Codex or ZCode an ordinary task such as:

```text
Use $build-openadam-agent-tools to inspect this repository and help me adopt it
as one OpenAdam-compatible provider. Do not invent a Capability or Procedure.
```

For opportunity discovery, the request may select saved tasks, conversations,
Skills, documents, source files, an exact subset of a repository, a public
open-source project, web research, an Observer snapshot, an explicitly exported
Agent Host Trace Analysis Pack, or a caller-authored
summary. The Skill treats every source as untrusted task data, checks
counterevidence and existing tools, and produces a working proposal for the
developer to accept or reject. It does not monitor the device, crawl unrelated
history or repository files, fetch references, or rank candidates by frequency.

Copy and edit the [authorized material example](examples/authorized-materials.example.json),
then bind the exact selected bytes and references:

```text
openadam-dev materials schema --json
openadam-dev materials inspect \
  --root /absolute/path/to/analysis-root \
  --manifest authorized-materials.json --json
openadam-dev opportunity init \
  --root /absolute/path/to/analysis-root \
  --materials authorized-materials.json \
  --output .verify/openadam-dev/opportunity.json --json
openadam-dev opportunity schema --json
openadam-dev opportunity check \
  --root /absolute/path/to/analysis-root \
  --materials authorized-materials.json \
  --proposal .verify/openadam-dev/opportunity.json --json
```

The generated proposal is intentionally incomplete until the user's Agent
replaces every `TODO`. A successful check establishes only current structure,
material binding, authorized source references, counterevidence, alternatives,
and preserved unknowns. It does not recommend a layer or approve development.

The low-disclosure route starts from current Skill inventory and bounded task
or conversation summaries, then reads only selected histories needed to test a
candidate. Agent Host telemetry can contribute current tool-call, outcome,
token, activity, freshness, and catalog-cost measurements when its coverage
says they are available. It does not establish Skill activation, why a tool was
not used, the semantic effect of a result, or whether the Agent adopted it.
Those questions need an explicit contemporaneous Agent assessment or a
controlled baseline/treatment task with a task-native result check; otherwise
the proposal leaves them unknown. Raw transcripts are not copied into the
provider project. Reference-only sources are read through the user's supported
Agent host or browser interface; the CLI records their identity but never
fetches them.

For deeper shell-specific analysis, the user can export one selected ZCode
trace through Agent Host and then add that exact output file to the material
manifest with role `agent-trace`. Keep the default metadata-only form unless
conversation content is actually needed. A content-bearing export requires
both explicit flags; merely listing the output as material is not consent:

```text
agent-host observability export-trace \
  --provider zcode \
  --file /absolute/path/to/model-io-session.jsonl \
  --output /absolute/path/to/trace-analysis-pack.json \
  --max-output-bytes 1048576 --json
```

The pack retains adapter provenance, bounds, and unknown fields. It does not
turn model reasoning, tool availability, or sequence timing into proof of
non-use reason, result adoption, correctness, or product value.

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

`check` and `pack` accept the independent Agent Host v0.2, v0.3 `skill-cli`,
and v0.5 integration shapes. v0.3 binds one product Skill plus contained direct
CLI and rejects provider-owned bytes at its Host-generated launcher path; v0.5
remains the separate optional-path-grant shape and cannot also declare
discovery.

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
agent-host setup --profile developer --host codex --host zcode --release-manifest /absolute/current.json
```

Codex receives one Skill-only plugin; ZCode receives one immutable Skill link.
Both launch the exact Suite Node and CLI bytes from the installed compatibility
set. Claude Code can receive the same optional compatibility projection when a
user-owned supplier is configured. The Developer Kit adds no MCP server or
callable tool to the ordinary Agent catalog. A mutable `--development-root` is
intentionally rejected for this profile.

The Developer Kit component is platform-neutral, and Agent Host now contains
an unsigned current-user Windows packaging route. The current bound catalog is
still macOS arm64; a genuine Windows build, fresh-device run, public registry,
signed or notarized distribution, Linux support, and another-device acceptance
remain explicit release observations rather than properties inferred from this
source checkout.

`measure` operates on the packed provider, not a mocked core. It records cold
startup, warm latency distribution, bounded concurrent throughput, a cancelled
client call followed by same-session recovery, direct-provider RSS samples,
and current MCP catalog plus declared Skill bytes. With no owner-defined
threshold it reports a baseline, never a general performance PASS.
Its initialization deadline is owned by the Kit: a Provider-sent JSON-RPC
`-32001` remains a distinct bounded connect failure rather than being reported
as a locally observed timeout. Caller cancellation is a third Kit-owned cause:
a pre-cancelled connection spawns no Provider, while cancellation during
initialization waits for runtime cleanup and returns the operation's stable
cancelled result.

Maintainers can separately measure the packaged Developer Kit CLI itself with
`npm run measure:self`. That baseline covers startup, bounded parallel starts,
schema/doctor/material/opportunity/scaffold/inspect flow cost, process RSS when the operating system
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
