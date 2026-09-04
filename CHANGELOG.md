# Changelog

## 0.1.5 - 2026-09-04

### Fixed

- Apply one cumulative Developer Kit deadline to provider admission, catalog
  discovery, direct calls, concurrent measurement, and result persistence.
- Normalize MCP catalog and call rejection or transport failure into stable
  probe/measure errors while retaining only a bounded numeric protocol code.
- Keep caller cancellation, Developer Kit deadline expiry, Provider rejection,
  and operating-system transport termination distinct through cleanup and
  subsequent recovery.
- Bound deadline/cancellation closeout for transport closure, temporary-runtime
  cleanup, and failure observation persistence.
- Own the declared packed MCP Provider process scope: isolate a POSIX process
  group or capture the Windows process tree, apply bounded EOF/TERM/KILL
  escalation, and report cleanup complete only after that scope and the
  temporary runtime are confirmed absent. Processes that violate the probe
  contract by escaping the owned scope remain explicitly unobservable.
- Retain the extracted runtime when pending work does not settle or the owned
  process scope cannot be confirmed absent, instead of removing files that
  possible live work may still use.
