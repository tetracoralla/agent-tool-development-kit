#!/usr/bin/env node

import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { performance } from 'node:perf_hooks'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { extractArchive } from '../src/probe.mjs'
import { buildDeveloperComponent } from './build-developer-component.mjs'
import { DEVELOPER_KIT_VERSION } from '../src/constants.mjs'

const execFileAsync = promisify(execFile)
const repositoryRoot = fileURLToPath(new URL('../', import.meta.url))

function parseArguments(argv) {
  if (argv.length === 0) return { iterations: 20, concurrency: 4 }
  const values = { iterations: 20, concurrency: 4 }
  for (let index = 0; index < argv.length; index += 2) {
    const option = argv[index]
    const value = Number(argv[index + 1])
    if (!['--iterations', '--concurrency'].includes(option) || !Number.isSafeInteger(value)) {
      throw new Error('Usage: node scripts/measure-developer-kit.mjs [--iterations 5..200] [--concurrency 1..16]')
    }
    values[option.slice(2)] = value
  }
  if (values.iterations < 5 || values.iterations > 200 || values.concurrency < 1 || values.concurrency > 16) {
    throw new Error('iterations must be 5..200 and concurrency must be 1..16')
  }
  return values
}

function rounded(value) {
  return Math.round(value * 1000) / 1000
}

function percentile(values, ratio) {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.max(0, Math.ceil(sorted.length * ratio) - 1)]
}

function distribution(values) {
  return {
    samples: values.length,
    minMs: rounded(Math.min(...values)),
    p50Ms: rounded(percentile(values, 0.5)),
    p95Ms: rounded(percentile(values, 0.95)),
    maxMs: rounded(Math.max(...values)),
  }
}

function completeOpportunity(value) {
  if (typeof value === 'string') return value.startsWith('TODO:') ? `Completed: ${value.slice(5).trim()}` : value
  if (Array.isArray(value)) return value.map(completeOpportunity)
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, completeOpportunity(item)]))
  return value
}

function isolatedEnvironment(home) {
  const names = ['PATH', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT']
  return {
    ...Object.fromEntries(names.flatMap((name) => process.env[name] === undefined ? [] : [[name, process.env[name]]])),
    HOME: home,
    CI: '1',
    NO_COLOR: '1',
  }
}

async function invocation(runtime, args, { cwd, home }) {
  const started = performance.now()
  const result = await execFileAsync(process.execPath, [runtime, ...args], {
    cwd,
    env: isolatedEnvironment(home),
    timeout: 120_000,
    maxBuffer: 256 * 1024,
    windowsHide: true,
  })
  const parsed = JSON.parse(result.stdout)
  const succeeded = ['ok', 'ready', 'created'].includes(parsed.status)
    || typeof parsed.$schema === 'string'
  if (!succeeded) throw new Error(`packaged CLI command did not succeed: ${args.join(' ') || '--version'}`)
  return {
    durationMs: rounded(performance.now() - started),
    stdoutBytes: Buffer.byteLength(result.stdout),
    stderrBytes: Buffer.byteLength(result.stderr),
  }
}

async function recursiveFiles(root, current = root, output = []) {
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const path = join(current, entry.name)
    if (entry.isDirectory()) await recursiveFiles(root, path, output)
    else if (entry.isFile()) output.push({ path: relative(root, path), bytes: (await stat(path)).size })
  }
  return output.sort((left, right) => left.path.localeCompare(right.path))
}

async function peakResidentBytes(runtime, cwd, home) {
  if (process.platform !== 'darwin') return { status: 'unavailable', reason: 'darwin-time-required' }
  try {
    const result = await execFileAsync('/usr/bin/time', ['-l', process.execPath, runtime, '--version', '--json'], {
      cwd,
      env: isolatedEnvironment(home),
      timeout: 10_000,
      maxBuffer: 64 * 1024,
    })
    const match = result.stderr.match(/(\d+)\s+maximum resident set size/u)
    return match === null
      ? { status: 'unavailable', reason: 'maximum-rss-not-reported' }
      : { status: 'observed', bytes: Number(match[1]), scope: 'one-packaged-version-process' }
  } catch {
    return { status: 'unavailable', reason: 'maximum-rss-observation-failed' }
  }
}

async function main() {
  const { iterations, concurrency } = parseArguments(process.argv.slice(2))
  const started = performance.now()
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'oadk-self-measure-'))
  const observationRoot = join(repositoryRoot, '.verify', 'openadam-dev', `${new Date().toISOString().replaceAll(':', '').replaceAll('.', '-')}-self-measure`)
  try {
    const artifact = join(temporaryRoot, 'agent-tool-development-kit.tar.gz')
    await buildDeveloperComponent({ outputPath: artifact })
    const extracted = join(temporaryRoot, 'component')
    const home = join(temporaryRoot, 'home')
    const workspace = join(temporaryRoot, 'workspace')
    await Promise.all([mkdir(extracted), mkdir(home), mkdir(workspace)])
    await extractArchive(artifact, extracted)
    const runtime = join(extracted, 'runtime', 'openadam-dev.mjs')

    const cold = await invocation(runtime, ['--version', '--json'], { cwd: workspace, home })
    const warm = []
    for (let index = 0; index < iterations; index += 1) {
      warm.push((await invocation(runtime, ['--version', '--json'], { cwd: workspace, home })).durationMs)
    }
    const sustainedStarted = performance.now()
    const sustained = []
    for (let offset = 0; offset < iterations; offset += concurrency) {
      const width = Math.min(concurrency, iterations - offset)
      const batch = await Promise.all(Array.from({ length: width }, () => invocation(runtime, ['--version', '--json'], { cwd: workspace, home })))
      sustained.push(...batch.map((item) => item.durationMs))
    }
    const sustainedMs = performance.now() - sustainedStarted

    const destination = join(workspace, 'sample-provider')
    const flows = {}
    flows.schema = await invocation(runtime, ['schema', '--json'], { cwd: workspace, home })
    flows.doctor = await invocation(runtime, ['doctor', '--json'], { cwd: workspace, home })
    await writeFile(join(workspace, 'selected.md'), '# Selected measurement source\n')
    await writeFile(join(workspace, 'authorized-materials.json'), `${JSON.stringify({
      schemaVersion: 'openadam.authorized-material-set.v0.1',
      id: 'measurement-materials',
      title: 'Measurement materials',
      purpose: 'Measure the packaged deterministic material and opportunity route.',
      intendedProcessing: 'local-only',
      sources: [{ id: 'selected', role: 'documentation', title: 'Selected source', location: { type: 'local-file', path: 'selected.md' } }],
    })}\n`)
    flows.materials = await invocation(runtime, ['materials', 'inspect', '--root', workspace, '--manifest', 'authorized-materials.json', '--json'], { cwd: workspace, home })
    flows.opportunitySchema = await invocation(runtime, ['opportunity', 'schema', '--json'], { cwd: workspace, home })
    flows.opportunityInit = await invocation(runtime, ['opportunity', 'init', '--root', workspace, '--materials', 'authorized-materials.json', '--output', 'opportunity.json', '--json'], { cwd: workspace, home })
    const opportunity = completeOpportunity(JSON.parse(await readFile(join(workspace, 'opportunity.json'), 'utf8')))
    await writeFile(join(workspace, 'opportunity.json'), `${JSON.stringify(opportunity)}\n`)
    flows.opportunityCheck = await invocation(runtime, ['opportunity', 'check', '--root', workspace, '--materials', 'authorized-materials.json', '--proposal', 'opportunity.json', '--json'], { cwd: workspace, home })
    flows.initDryRun = await invocation(runtime, [
      'init', 'node-mcp-provider', '--destination', destination, '--id', 'org.example.sample-provider',
      '--package-name', '@example/sample-provider', '--plugin', 'sample-provider', '--operation', 'sample.run',
      '--name', 'Sample Provider', '--summary', 'A measurement-only provider scaffold.', '--author', 'Measurement Fixture',
      '--license', 'LicenseRef-Private', '--dry-run', '--json',
    ], { cwd: workspace, home })
    flows.init = await invocation(runtime, [
      'init', 'node-mcp-provider', '--destination', destination, '--id', 'org.example.sample-provider',
      '--package-name', '@example/sample-provider', '--plugin', 'sample-provider', '--operation', 'sample.run',
      '--name', 'Sample Provider', '--summary', 'A measurement-only provider scaffold.', '--author', 'Measurement Fixture',
      '--license', 'LicenseRef-Private', '--json',
    ], { cwd: workspace, home })
    flows.inspect = await invocation(runtime, ['inspect', '--root', destination, '--json'], { cwd: workspace, home })

    const skillRoot = join(extracted, 'marketplace', 'plugins', 'agent-tool-development-kit', 'skills', 'build-openadam-agent-tools')
    const skillFiles = await recursiveFiles(skillRoot)
    const pluginRoot = join(extracted, 'marketplace', 'plugins', 'agent-tool-development-kit')
    const pluginFiles = await recursiveFiles(pluginRoot)
    const defaultSkillPaths = new Set(['SKILL.md', 'agents/openai.yaml'])
    const defaultSkillFiles = skillFiles.filter((item) => defaultSkillPaths.has(item.path))
    const onDemandSkillFiles = skillFiles.filter((item) => !defaultSkillPaths.has(item.path))
    const result = {
      schemaVersion: 'openadam.developer-kit-self-measurement.v0.1',
      status: 'ok',
      artifact: { version: DEVELOPER_KIT_VERSION, carrier: 'packed-developer-kit-component' },
      workload: { iterations, concurrency },
      measurement: {
        cliStartup: { cold, warm: distribution(warm) },
        sustainedStartup: {
          calls: iterations,
          concurrency,
          elapsedMs: rounded(sustainedMs),
          callsPerSecond: rounded(iterations / (sustainedMs / 1000)),
          latency: distribution(sustained),
        },
        developerFlow: flows,
        resource: await peakResidentBytes(runtime, workspace, home),
        context: {
          mcpServers: pluginFiles.some((item) => item.path === '.mcp.json') ? 1 : 0,
          defaultSkillFiles,
          defaultSkillUtf8Bytes: defaultSkillFiles.reduce((sum, item) => sum + item.bytes, 0),
          onDemandSkillFiles,
          onDemandSkillUtf8Bytes: onDemandSkillFiles.reduce((sum, item) => sum + item.bytes, 0),
          packagedCliBytes: (await stat(runtime)).size,
          note: 'Bytes are carrier measurements, not model-token counts.',
        },
      },
      assessment: {
        kind: 'baseline-only',
        thresholdsApplied: false,
        establishes: ['packaged-cli-startup-baseline', 'bounded-parallel-startup-baseline', 'packaged-scaffold-and-inspect-baseline', 'developer-skill-and-mcp-carrier-bytes'],
        doesNotEstablish: ['performance-acceptance', 'provider-check-pack-probe-cost', 'model-token-cost', 'production-capacity'],
      },
      environment: { credentialsInherited: false, workspace: 'temporary-empty', modelCalls: 0 },
      durationMs: rounded(performance.now() - started),
      cleanup: 'completed',
      observationDirectory: relative(repositoryRoot, observationRoot),
    }
    await mkdir(observationRoot, { recursive: true })
    await writeFile(join(observationRoot, 'result.json'), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 })
    process.stdout.write(`${JSON.stringify(result)}\n`)
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true })
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error.message}\n`)
  process.exitCode = 1
})
