# Developer Kit pilot matrix

This matrix records current, rerunnable observations used to validate the
product boundary. It is not a compatibility registry, provider ranking,
substitution claim, or publication approval.

| Lane | Current route | Observation |
| --- | --- | --- |
| Provider-native Node | `test/pack.test.mjs` fixture | deterministic pack, valid/error direct MCP probe, packed-runtime measurement |
| Capability, Python | Python MCP fixture in `test/pack.test.mjs` | dedicated `capability-conformance` lane, component executor, pack and valid/error probe |
| Capability, Node | Capability Contracts `run-conformance.mjs` with Migratory Time | six current time-zone cases passed on 2026-09-01 |
| Capability witness, Python | Capability Contracts `run-conformance.mjs` with `python-zoneinfo` | the same six current cases passed on 2026-09-01; test witness only |
| Procedure, Node | Procedure Contracts `run-conformance.mjs` with Dependency Preflight | three current result-conformance cases passed on 2026-09-01; local pilot only |
| Host distribution | isolated Agent Host release build with `developer` profile | 13-component catalog validated; Developer Kit remained outside `agentComponents` |
| Codex carrier | real Codex CLI with an empty temporary `CODEX_HOME` | Skill-only plugin, generated exact CLI launcher, no `.mcp.json`, doctor OK, owned uninstall |
| ZCode carrier | Agent Host isolated carrier checks with an empty ZCode configuration root | immutable Skill projection and exact CLI launcher are the primary external-developer route; current `0.1.4` admission is rechecked in the Agent Host release lane before this row is treated as current installed evidence |
| Optional Claude-compatible carrier | real Claude CLI with an empty temporary `CLAUDE_CONFIG_DIR` | immutable Skill link, exact CLI version probe, doctor OK, owned MCP/Skill uninstall; no official Claude model dependency or natural-selection claim |
| Developer Kit performance | packaged `0.1.3` component, `npm run measure:self -- --iterations 30 --concurrency 8` | 2026-09-02 local baseline: 15,813-byte lazy CLI; 47.930 ms cold; 47.745 ms warm p50 / 50.489 ms p95; 98.393 bounded eight-way starts/s; 39,436,288-byte one-process RSS; 7,599 default Skill bytes plus 13,599 on-demand discovery/worksheet bytes; zero MCP servers; material inspect 93.971 ms, opportunity init 105.157 ms, and opportunity check 106.529 ms; no threshold and no model call |
| Authorized material and opportunity contract | closed schemas plus packaged `materials inspect` and `opportunity init/check` | exact selected local files or opaque references only; no directory crawl or reference fetch; bounded hashes bind current bytes; proposal check validates source bindings, counterevidence, simpler alternatives, and unknowns without recommending a layer or approving development |
| Local opportunity dogfood | three selected archived Codex task references, one current Agent Host snapshot reference, and two exact installed ZCode Skill files | the checked proposal retained all six sources and concluded only a Skill-layer hypothesis: reuse current Armorial before considering another Provider, Capability, or Procedure; tool invocation and runtime outcome were partial, while Skill activation, non-use reason, semantic effect, and result adoption remained unavailable or not observed |
| Fresh Codex opportunity case | temporary Codex Home containing only installed Developer Kit `0.1.1`, one owner-authorized bounded summary, ordinary unbranded prompt | Agent naturally activated the installed Skill and proposed existing Armorial Skill/launcher reuse rather than a duplicate Provider, Capability, or Procedure; non-use, effect, quality, and adoption remained unknown. The multi-turn task reported 199,244 cumulative input Tokens, 171,776 cached, and 3,904 output; this is whole-harness task cost, not Skill bytes. Version `0.1.2` closes the broad generic Skill-root inventory attempt observed in this run. |

The JavaScript and Python package/probe routes exercise two implementation
languages. Capability and Procedure standards remain owned by their respective
repositories; the Developer Kit stores only the exact conformance argv selected
by the provider repository. A declared Capability or Procedure manifest fails
project validation when its dedicated conformance lane is absent.

The bounded local opportunity-discovery run used exact caller-selected sources,
including one current Agent Host snapshot, as neutral leads. It did not copy
raw task transcripts into this repository and did not crawl archived tasks,
Skills, repositories, or directories. The selected Agent authored the proposal;
the deterministic check only verified the closed shape, current material
binding, contradictions, alternatives, and preserved unknowns. Counts and task
recurrence were not used as rankings.

Still outside these observations: a public registry install, Developer ID
signed/notarized distribution, a genuine Windows build and fresh host flow,
Linux host flows, another physical
device, exhaustive history mining, credentials, external privacy/legal
authorization, and owner business/experience acceptance. ZCode fresh-model
selection remains a separate deferred validation lane when the configured model
quota is available. Local timings and one older fresh Codex case are current
machine observations, not portable performance or utility claims.
