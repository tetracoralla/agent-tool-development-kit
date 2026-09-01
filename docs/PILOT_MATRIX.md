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
| Claude carrier | real Claude CLI with an empty temporary `CLAUDE_CONFIG_DIR` | immutable Skill link, exact CLI version probe, doctor OK, owned MCP/Skill uninstall |
| Developer Kit performance | packaged component `npm run measure:self -- --iterations 20 --concurrency 4` | 2026-09-01 final-source baseline: 11,484-byte lazy CLI entry; 57.143 ms first start; 49.919 ms warm p50; 64.951 ms bounded-concurrent p95; 39,370,752-byte one-process peak RSS; 6,881 default Skill bytes plus 7,594 on-demand discovery/worksheet bytes; zero Developer Kit MCP servers; no threshold |
| Opportunity discovery | versioned Skill reference, non-normative proposal asset, and bounded local dogfood | explicit source consent, untrusted-session handling, semantic clustering, contradictions, existing-tool search, Provider/Skill/Capability/Procedure routing, and implementation handoff are packaged; one local run sampled 50 recent task summaries and four selected task histories without persisting raw transcripts; no automatic history crawl or nomination |

The JavaScript and Python package/probe routes exercise two implementation
languages. Capability and Procedure standards remain owned by their respective
repositories; the Developer Kit stores only the exact conformance argv selected
by the provider repository. A declared Capability or Procedure manifest fails
project validation when its dedicated conformance lane is absent.

The bounded local opportunity-discovery run also used one already-consented
Agent Host snapshot as a neutral lead. It found repeated deterministic
packaging/host-parity work, but also repeated review and product-selection work
whose essential meaning remains judgment. It therefore produced no new
Capability or Procedure declaration. Counts and task recurrence were not used
as rankings, and no raw prompt, argument, result, or session transcript was
copied into this repository.

Still outside these observations: a public registry install, signed/notarized
binary distribution, Linux and Windows host flows, natural selection in a
model-backed fresh Codex or Claude task, another physical device, exhaustive
history mining, credentials, external privacy/legal authorization, and owner
business/experience acceptance. Local timings are current baselines, not
portable performance claims.
