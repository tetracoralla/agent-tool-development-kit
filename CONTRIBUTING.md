# Contributing

Use Node.js 22 or later, npm, Git, and Python 3 on macOS or Linux. Clone this
repository, run `npm ci`, then `npm run check`. The checks include a fresh
sealed component build and execution; no Agent account or model call is needed.

The CLI and its closed schemas own deterministic behavior. The developer Skill
owns task framing and interpretation. Preserve user files, explicit path and
command boundaries, complete output limits, cancellation, and truthful effects.
For a bug fix, include a regression that fails on the original behavior.

Generated projects are incomplete until their author implements their domain
logic, schemas, tests, legal material, Skill, and probes. Do not remove that
guard merely to make a generated project pass.

Submit a pull request describing the concrete user problem, final behavior,
checks run, and material limitations. Keep credentials, personal paths,
transcripts, generated reports, and installed-host configuration out of commits.

Source is Apache-2.0. npm publication, installer distribution, and a generated
provider's license are separate choices. A passing check does not authorize a
release or establish that an Agent saved reasoning, time, or money.
