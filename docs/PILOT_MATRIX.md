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
| Developer Kit performance | packaged `0.1.2` component, `npm run measure:self -- --iterations 20 --concurrency 4` | 2026-09-02 local baseline: 11,484-byte lazy CLI; 45.556 ms cold; 45.155 ms warm p50 / 46.520 ms p95; 78.62 bounded four-way starts/s; 39,223,296-byte one-process RSS; 6,275 default Skill bytes plus 11,153 on-demand discovery/worksheet bytes; zero MCP servers; no threshold and no model call |
| Opportunity discovery | versioned Skill reference, non-normative proposal asset, and bounded local dogfood | explicit source consent, untrusted-session handling, supported-inventory routing, contradictions, existing-tool search, Provider/Skill/Capability/Procedure separation, and implementation handoff are packaged; one local run sampled 50 recent task summaries and four selected task histories without persisting raw transcripts; no automatic history crawl, recursive Skill/session-root inventory, ranking, or nomination |
| Fresh Codex opportunity case | temporary Codex Home containing only installed Developer Kit `0.1.1`, one owner-authorized bounded summary, ordinary unbranded prompt | Agent naturally activated the installed Skill and proposed existing Armorial Skill/launcher reuse rather than a duplicate Provider, Capability, or Procedure; non-use, effect, quality, and adoption remained unknown. The multi-turn task reported 199,244 cumulative input Tokens, 171,776 cached, and 3,904 output; this is whole-harness task cost, not Skill bytes. Version `0.1.2` closes the broad generic Skill-root inventory attempt observed in this run. |

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

Still outside these observations: a public registry install, Developer ID
signed/notarized distribution, Linux and Windows host flows, another physical
device, exhaustive history mining, credentials, external privacy/legal
authorization, and owner business/experience acceptance. Fresh Claude natural
selection remains blocked before model execution by repeated HTTP 502 responses
from the configured local inference gateway despite healthy installed Skill
projection. Local timings and one fresh Codex case are current observations,
not portable performance or utility claims.
