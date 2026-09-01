# Security Policy

## Supported versions

Only the latest released `0.1.x` version is eligible for security fixes during
the developer preview. Unreleased source commits and older local artifacts are
not separate supported releases.

## Reporting a vulnerability

Use the repository's private security-advisory form when a public repository is
available. If that private form is unavailable, contact the distributor through
the same private channel that supplied the software. Do not include credentials,
private Agent transcripts, user data, or exploitable details in a public issue.

Include the affected version and carrier, operating system and architecture,
the smallest reproducible input, expected and observed behavior, and whether
the issue can cross a workspace, credential, process, package, or Agent-host
boundary. Redact secrets and personal data.

Receipt, response time, remediation, and disclosure dates are coordinated for
each report; this preview does not promise a fixed service-level agreement.

## Scope

Security reports may cover the CLI, project validation, package inventory,
archive extraction, isolated probe and measurement routes, generated
launchers, the Skill-only plugin, and the Agent Host integration contract.
Issues in an independently authored provider or Agent shell should be reported
to that product's owner unless the Developer Kit caused or widened the issue.
