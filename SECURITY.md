# Security

Report suspected vulnerabilities privately through
[GitHub security advisories](https://github.com/tetracoralla/agent-tool-development-kit/security/advisories/new).
Do not place credentials, private source, or user transcripts in public issues.
Include the affected revision, a minimal synthetic reproduction, and observed
effects. The current main branch is the supported source line.

The Kit executes explicitly declared developer code. Its environment filtering,
staging, timeouts, and process cleanup are not an operating-system or network
sandbox. Inspect unfamiliar projects before running their checks or probes.

`pack` seals a local artifact; `probe` validates and exercises it in temporary
state. Neither publishes it nor installs it into your Agent apps. An unconfirmed
process shutdown retains the temporary runtime and reports incomplete cleanup.
