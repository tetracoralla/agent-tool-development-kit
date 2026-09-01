#!/usr/bin/env node
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { DeveloperKitError, publicError } from './errors.mjs'
import { DEFAULT_CHECK_DEADLINE_MS, DEVELOPER_KIT_VERSION, MAX_OUTPUT_BYTES } from './constants.mjs'

const USAGE = `Usage:
  openadam-dev doctor [--json]
  openadam-dev inspect [--root PATH] [--json]
  openadam-dev init node-mcp-provider --destination PATH --id ID --package-name NAME --plugin NAME --operation NAME --name TEXT --summary TEXT --author TEXT [--license SPDX] [--dry-run] [--json]
  openadam-dev check [--root PATH] [--deadline-ms NUMBER] [--json]
  openadam-dev pack [--root PATH] [--deadline-ms NUMBER] [--replace] [--json]
  openadam-dev probe [--root PATH] [--deadline-ms NUMBER] [--json]
  openadam-dev measure [--root PATH] [--deadline-ms NUMBER] [--iterations NUMBER] [--concurrency NUMBER] [--json]
  openadam-dev schema [--json]
  openadam-dev --version [--json]
  openadam-dev --help`

const COMMANDS = new Set(['doctor', 'inspect', 'init', 'check', 'pack', 'probe', 'measure', 'schema'])

function helpRequest(argv) {
  if (argv.length === 0) return true
  const help = argv.filter((item) => item === '--help' || item === '-h')
  if (help.length === 0) return false
  if (help.length !== 1 || argv.filter((item) => item === '--json').length > 1) {
    throw new DeveloperKitError('CLI_USAGE', 'Help accepts one optional --json argument')
  }
  const prefix = argv.filter((item) => item !== '--help' && item !== '-h' && item !== '--json')
  const valid = prefix.length === 0
    || (prefix.length === 1 && COMMANDS.has(prefix[0]) && prefix[0] !== 'init')
    || (prefix.length === 2 && prefix[0] === 'init' && prefix[1] === 'node-mcp-provider')
  if (!valid) throw new DeveloperKitError('CLI_USAGE', 'Help cannot be combined with command arguments')
  return true
}

function parseArgs(argv) {
  if (argv[0] === '--version') {
    if (argv.length > 2 || (argv.length === 2 && argv[1] !== '--json')) throw new DeveloperKitError('CLI_USAGE', '--version accepts only one optional --json argument')
    return { command: 'version', json: argv.includes('--json') }
  }
  if (helpRequest(argv)) return { command: 'help', json: argv.includes('--json') }
  const options = { command: argv[0], root: process.cwd(), json: false, deadlineMs: DEFAULT_CHECK_DEADLINE_MS, iterations: 20, concurrency: 4, dryRun: false, license: 'UNLICENSED' }
  if (options.command === 'init') options.template = argv[1]
  const allowed = new Set(options.command === 'inspect'
    ? ['--root', '--json']
    : options.command === 'check' || options.command === 'probe'
      ? ['--root', '--deadline-ms', '--json']
      : options.command === 'measure'
        ? ['--root', '--deadline-ms', '--iterations', '--concurrency', '--json']
      : options.command === 'pack'
        ? ['--root', '--deadline-ms', '--replace', '--json']
      : options.command === 'init'
        ? ['--destination', '--id', '--package-name', '--plugin', '--operation', '--name', '--summary', '--author', '--license', '--dry-run', '--json']
      : ['--json'])
  const start = options.command === 'init' ? 2 : 1
  if (options.command === 'init' && (options.template === undefined || options.template.startsWith('--'))) {
    throw new DeveloperKitError('CLI_USAGE', 'init requires a template name')
  }
  const valueOptions = new Map([
    ['--destination', 'destination'], ['--id', 'id'], ['--package-name', 'packageName'],
    ['--plugin', 'plugin'], ['--operation', 'operation'], ['--name', 'name'],
    ['--summary', 'summary'], ['--author', 'author'], ['--license', 'license'],
    ['--iterations', 'iterations'], ['--concurrency', 'concurrency'],
  ])
  const seen = new Set()
  for (let index = start; index < argv.length; index += 1) {
    const arg = argv[index]
    if (!allowed.has(arg)) throw new DeveloperKitError('CLI_USAGE', `Unknown argument for ${options.command}: ${arg}`)
    if (seen.has(arg)) throw new DeveloperKitError('CLI_USAGE', `Duplicate argument for ${options.command}: ${arg}`)
    seen.add(arg)
    if (arg === '--json') {
      options.json = true
      continue
    }
    if (arg === '--dry-run') {
      options.dryRun = true
      continue
    }
    if (arg === '--replace') {
      options.replace = true
      continue
    }
    const value = argv[index + 1]
    if (value === undefined || value.startsWith('--')) throw new DeveloperKitError('CLI_USAGE', `${arg} requires a value`)
    if (arg === '--root') options.root = value
    else if (arg === '--deadline-ms') {
      const parsed = Number(value)
      if (!Number.isInteger(parsed) || parsed < 100 || parsed > DEFAULT_CHECK_DEADLINE_MS) {
        throw new DeveloperKitError('CLI_USAGE', `--deadline-ms must be an integer from 100 to ${DEFAULT_CHECK_DEADLINE_MS}`)
      }
      options.deadlineMs = parsed
    } else if (arg === '--iterations') {
      const parsed = Number(value)
      if (!Number.isInteger(parsed) || parsed < 5 || parsed > 200) throw new DeveloperKitError('CLI_USAGE', '--iterations must be an integer from 5 to 200')
      options.iterations = parsed
    } else if (arg === '--concurrency') {
      const parsed = Number(value)
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 16) throw new DeveloperKitError('CLI_USAGE', '--concurrency must be an integer from 1 to 16')
      options.concurrency = parsed
    } else options[valueOptions.get(arg)] = value
    index += 1
  }
  if (options.command === 'init') {
    for (const key of ['destination', 'id', 'packageName', 'plugin', 'operation', 'name', 'summary', 'author']) {
      if (options[key] === undefined) throw new DeveloperKitError('CLI_USAGE', `init requires --${key.replace(/[A-Z]/gu, (value) => `-${value.toLowerCase()}`)}`)
    }
  }
  return options
}

function human(result) {
  if (result.help !== undefined) return result.help
  if (result.schemaVersion === 'openadam.developer-kit-doctor.v0.1') {
    const available = result.checks.filter((check) => check.status === 'ok').length
    return `Developer environment: ${result.status} · ${available}/${result.checks.length} checks available`
  }
  if (result.schemaVersion === 'openadam.developer-kit-inspection.v0.1') {
    const declaration = result.projectDeclaration.present ? result.projectDeclaration.status : 'absent'
    return `${result.root} · ${result.packages.map((item) => item.kind).join(', ') || 'no package metadata'} · project declaration ${declaration} · ${result.discovery.files.length} relevant files`
  }
  if (result.schemaVersion === 'openadam.developer-kit-check.v0.1') {
    return result.status === 'ok'
      ? `${result.project.id} ${result.project.version} · ${result.checks.length} checks passed`
      : `${result.project?.id ?? 'Project'} · check failed${result.error?.code === undefined ? '' : ` · ${result.error.code}`}`
  }
  if (result.schemaVersion === 'openadam.developer-kit-init.v0.1') {
    return `${result.project.id} · ${result.status} · ${result.files.length} files · ${result.mutation}`
  }
  if (result.schemaVersion === 'openadam.developer-kit-pack.v0.1') {
    return result.status === 'ok'
      ? `${result.component.id} ${result.component.version} · ${result.component.files} files · ${result.artifact.path}`
      : `${result.project?.id ?? 'Project'} · pack failed${result.error?.code === undefined ? '' : ` · ${result.error.code}`}`
  }
  if (result.schemaVersion === 'openadam.developer-kit-probe.v0.1') {
    return result.status === 'ok'
      ? `${result.project.id} ${result.project.version} · Agent Host preview and ${result.direct.probes.length} runtime probes passed`
      : `${result.project?.id ?? 'Project'} · probe failed${result.error?.code === undefined ? '' : ` · ${result.error.code}`}`
  }
  if (result.schemaVersion === 'openadam.developer-kit-measurement.v0.1') {
    return result.status === 'ok'
      ? `${result.project.id} ${result.project.version} · packed runtime baseline · warm p95 ${result.measurement.warm.p95Ms} ms · ${result.measurement.sustained.callsPerSecond} calls/s`
      : `${result.project?.id ?? 'Project'} · measurement failed${result.error?.code === undefined ? '' : ` · ${result.error.code}`}`
  }
  if (result.schemaVersion === 'openadam.agent-tool-project.v0.1') return 'Agent tool project schema v0.1'
  if (result.schemaVersion === 'openadam.developer-kit-version.v0.1') return `openadam-dev ${result.version}`
  return result.status ?? 'ok'
}

function serialize(value) {
  const output = `${JSON.stringify(value)}\n`
  if (Buffer.byteLength(output) > MAX_OUTPUT_BYTES) {
    throw new DeveloperKitError('OUTPUT_TOO_LARGE', `The result exceeds the ${MAX_OUTPUT_BYTES}-byte output limit.`)
  }
  return output
}

async function run(options, signal) {
  if (options.command === 'help') return { help: USAGE }
  if (options.command === 'doctor') return (await import('./doctor.mjs')).doctor()
  if (options.command === 'inspect') return (await import('./inspect.mjs')).inspectProject(options.root)
  if (options.command === 'init') return (await import('./init.mjs')).initProject(options)
  if (options.command === 'check') return (await import('./check.mjs')).safeCheckProject(options.root, { deadlineMs: options.deadlineMs, signal })
  if (options.command === 'pack') return (await import('./pack.mjs')).safePackProject(options.root, { deadlineMs: options.deadlineMs, replace: options.replace === true, signal })
  if (options.command === 'probe') return (await import('./probe.mjs')).safeProbeProject(options.root, { deadlineMs: options.deadlineMs, signal })
  if (options.command === 'measure') return (await import('./measure.mjs')).safeMeasureProject(options.root, { deadlineMs: options.deadlineMs, iterations: options.iterations, concurrency: options.concurrency, signal })
  if (options.command === 'schema') return (await import('./contracts.mjs')).projectSchema()
  if (options.command === 'version') return { schemaVersion: 'openadam.developer-kit-version.v0.1', status: 'ok', version: DEVELOPER_KIT_VERSION }
  throw new DeveloperKitError('CLI_USAGE', `Unknown command: ${options.command}`)
}

export async function main(argv) {
  let options = { json: argv.includes('--json') }
  const controller = new AbortController()
  const abort = () => controller.abort()
  process.once('SIGINT', abort)
  process.once('SIGTERM', abort)
  try {
    options = parseArgs(argv)
    const result = await run(options, controller.signal)
    process.stdout.write(options.json ? serialize(result) : `${human(result)}\n`)
    return result.status === 'error' ? 1 : 0
  } catch (error) {
    const value = { status: 'error', error: publicError(error) }
    process.stderr.write(options.json ? serialize(value) : `${value.error.code}: ${value.error.message}\n`)
    return error instanceof DeveloperKitError && error.code === 'CLI_USAGE' ? 2 : 1
  } finally {
    process.removeListener('SIGINT', abort)
    process.removeListener('SIGTERM', abort)
  }
}

function isEntrypoint() {
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1])
  } catch {
    return false
  }
}

if (isEntrypoint()) {
  process.exitCode = await main(process.argv.slice(2))
}
