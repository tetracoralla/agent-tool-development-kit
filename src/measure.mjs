import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, rmdir, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { performance } from 'node:perf_hooks'
import { promisify } from 'node:util'
import { DEFAULT_CHECK_DEADLINE_MS, MAX_OUTPUT_BYTES, PROJECT_FILE } from './constants.mjs'
import { loadProject } from './contracts.mjs'
import { DeveloperKitError, publicError } from './errors.mjs'
import { readBoundedJson } from './json.mjs'
import { requireDirectory, resolveDeclaredFile } from './paths.mjs'
import { extractArchive, openMcpProbeSession, requireReadOnlyProbeTool } from './probe.mjs'

const execFileAsync = promisify(execFile)
const WARMUP_CALLS = 3

function timestamp() {
  return new Date().toISOString().replaceAll(':', '').replaceAll('.', '-')
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

function serializedBytes(value) {
  const bytes = Buffer.byteLength(JSON.stringify(value))
  if (bytes > MAX_OUTPUT_BYTES) throw new DeveloperKitError('MEASURE_RESULT_LIMIT_EXCEEDED', 'A measured runtime result exceeds the serialized result limit.')
  return bytes
}

async function persistMeasurementResult(observationRoot, result) {
  await mkdir(observationRoot, { recursive: true })
  try {
    await writeFile(join(observationRoot, 'result.json'), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 })
  } catch (error) {
    // Remove only a still-empty directory. A partially or previously written
    // observation remains available for recovery and diagnosis.
    await rmdir(observationRoot).catch(() => {})
    throw error
  }
}

async function providerRss(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return { status: 'unavailable', reason: 'provider-pid-unavailable' }
  try {
    const { stdout } = await execFileAsync('/bin/ps', ['-o', 'rss=', '-p', String(pid)], { timeout: 2000, maxBuffer: 4096 })
    const kibibytes = Number(stdout.trim())
    if (!Number.isFinite(kibibytes) || kibibytes < 0) return { status: 'unavailable', reason: 'provider-rss-invalid' }
    return { status: 'observed', bytes: kibibytes * 1024, scope: 'direct-provider-process-only' }
  } catch {
    return { status: 'unavailable', reason: 'provider-rss-observation-failed' }
  }
}

async function successCall(session, probe, signal) {
  const started = performance.now()
  const result = await session.client.callTool({ name: probe.tool, arguments: probe.arguments }, undefined, {
    timeout: session.integration.runtime.timeoutMs,
    maxTotalTimeout: session.integration.runtime.timeoutMs,
    signal,
  })
  if (result.isError === true) throw new DeveloperKitError('MEASURE_PROBE_ERROR', 'The declared success probe returned a tool error during measurement.')
  const bytes = serializedBytes(result)
  return { durationMs: rounded(performance.now() - started), resultBytes: bytes }
}

async function contextCost(root, project, session) {
  const toolBytes = session.listing.tools.map((tool) => Buffer.byteLength(JSON.stringify(tool)))
  const skillFiles = []
  for (const carrier of project.carriers.filter((item) => item.kind === 'skill')) {
    const path = await resolveDeclaredFile(root, carrier.path, 'Skill carrier')
    const info = await stat(path)
    skillFiles.push({ path: carrier.path, bytes: info.size })
  }
  return {
    mcpCatalog: {
      tools: session.listing.tools.length,
      serializedUtf8Bytes: session.catalogBytes,
      largestToolUtf8Bytes: toolBytes.length === 0 ? 0 : Math.max(...toolBytes),
    },
    skills: {
      files: skillFiles,
      totalBytes: skillFiles.reduce((sum, item) => sum + item.bytes, 0),
    },
    note: 'Serialized byte counts are carrier measurements, not model-token counts.',
  }
}

function validateArtifact(project, descriptor, integration) {
  if (descriptor?.id !== project.package.componentId || descriptor?.version !== project.version
    || JSON.stringify(descriptor?.integration) !== JSON.stringify(integration)) {
    throw new DeveloperKitError('MEASURE_PROJECT_ARTIFACT_DRIFT', 'The measured component differs from the current project declaration.')
  }
}

export async function measureProject(rootInput, {
  declaredPath = PROJECT_FILE,
  deadlineMs = DEFAULT_CHECK_DEADLINE_MS,
  iterations = 20,
  concurrency = 4,
  signal,
} = {}) {
  const overallStarted = performance.now()
  const root = await requireDirectory(rootInput)
  const loaded = await loadProject(root, declaredPath)
  if (loaded.project.package === undefined) throw new DeveloperKitError('PACKAGE_NOT_DECLARED', 'The project does not declare a packaged Agent tool.')
  const probe = loaded.project.package.probes.find((item) => item.expectation === 'success')
  if (probe === undefined) throw new DeveloperKitError('MEASURE_SUCCESS_PROBE_REQUIRED', 'Performance measurement requires one declared read-only success probe.')
  const artifact = await resolveDeclaredFile(root, loaded.project.package.artifact, 'package artifact')
  const integration = await readBoundedJson(join(root, ...loaded.project.package.integration.replaceAll('\\', '/').split('/')), 'Agent Host integration')
  const observationRoot = join(root, '.verify', 'openadam-dev', `${timestamp()}-measure`)
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'oadm-'))
  const extractedRoot = join(temporaryRoot, 'component')
  const workspaceRoot = join(temporaryRoot, 'workspace')
  await mkdir(extractedRoot)
  await mkdir(workspaceRoot)
  try {
    await extractArchive(artifact, extractedRoot)
    const descriptor = await readBoundedJson(join(extractedRoot, 'component.json'), 'component descriptor')
    validateArtifact(loaded.project, descriptor, integration)

    const coldHome = join(temporaryRoot, 'cold-home')
    await mkdir(coldHome)
    const coldStarted = performance.now()
    const cold = await openMcpProbeSession({
      extractedRoot,
      descriptor,
      workspaceRoot,
      home: coldHome,
      signal,
      connectTimeoutCode: 'MEASURE_RUNTIME_CONNECT_TIMEOUT',
      connectFailureCode: 'MEASURE_RUNTIME_CONNECT_FAILED',
      connectCancellationCode: 'MEASURE_CANCELLED',
    })
    let coldCall
    let coldRss
    try {
      requireReadOnlyProbeTool(cold, probe)
      const readyMs = rounded(performance.now() - coldStarted)
      coldCall = await successCall(cold, probe, signal)
      coldRss = await providerRss(cold.transport.pid)
      coldCall = { readyMs, ...coldCall, totalMs: rounded(performance.now() - coldStarted) }
    } finally {
      await cold.close().catch(() => {})
    }

    const warmHome = join(temporaryRoot, 'warm-home')
    await mkdir(warmHome)
    const warm = await openMcpProbeSession({
      extractedRoot,
      descriptor,
      workspaceRoot,
      home: warmHome,
      signal,
      connectTimeoutCode: 'MEASURE_RUNTIME_CONNECT_TIMEOUT',
      connectFailureCode: 'MEASURE_RUNTIME_CONNECT_FAILED',
      connectCancellationCode: 'MEASURE_CANCELLED',
    })
    let measurement
    try {
      requireReadOnlyProbeTool(warm, probe)
      const context = await contextCost(root, loaded.project, warm)
      for (let index = 0; index < WARMUP_CALLS; index += 1) await successCall(warm, probe, signal)
      const rssBefore = await providerRss(warm.transport.pid)
      const warmDurations = []
      for (let index = 0; index < iterations; index += 1) warmDurations.push((await successCall(warm, probe, signal)).durationMs)

      const sustainedStarted = performance.now()
      const sustainedDurations = []
      for (let offset = 0; offset < iterations; offset += concurrency) {
        const width = Math.min(concurrency, iterations - offset)
        const results = await Promise.all(Array.from({ length: width }, () => successCall(warm, probe, signal)))
        sustainedDurations.push(...results.map((item) => item.durationMs))
      }
      const sustainedMs = performance.now() - sustainedStarted

      const cancelled = new AbortController()
      cancelled.abort()
      let cancellationObserved = false
      try {
        await successCall(warm, probe, cancelled.signal)
      } catch {
        cancellationObserved = true
      }
      const recovery = await successCall(warm, probe, signal)
      const rssAfter = await providerRss(warm.transport.pid)
      const resource = {
        cold: coldRss,
        warmBefore: rssBefore,
        warmAfter: rssAfter,
        warmDeltaBytes: rssBefore.status === 'observed' && rssAfter.status === 'observed' ? rssAfter.bytes - rssBefore.bytes : null,
        caveat: 'RSS covers the direct provider process, not descendants or host-wide pressure.',
      }
      measurement = {
        cold: coldCall,
        warm: distribution(warmDurations),
        sustained: {
          concurrency,
          calls: iterations,
          elapsedMs: rounded(sustainedMs),
          callsPerSecond: rounded(iterations / (sustainedMs / 1000)),
          latency: distribution(sustainedDurations),
        },
        cancellation: {
          carrierCancellationObserved: cancellationObserved,
          recoveryCallSucceeded: true,
          recoveryMs: recovery.durationMs,
          scope: 'pre-aborted client call followed by a same-session recovery call',
        },
        resource,
        context,
        providerStderrBytes: warm.stderrBytes(),
      }
    } finally {
      await warm.close().catch(() => {})
    }
    if (performance.now() - overallStarted > deadlineMs) throw new DeveloperKitError('MEASURE_DEADLINE_EXCEEDED', 'The measurement completed after its declared deadline.')
    const result = {
      schemaVersion: 'openadam.developer-kit-measurement.v0.1',
      status: 'ok',
      project: { id: loaded.project.id, version: loaded.project.version },
      artifact: { path: loaded.project.package.artifact, measuredCarrier: 'packed-mcp-stdio-runtime' },
      workload: { probeId: probe.id, tool: probe.tool, warmupCalls: WARMUP_CALLS, iterations, concurrency },
      measurement,
      assessment: {
        kind: 'baseline-only',
        thresholdsApplied: false,
        establishes: ['current-packed-runtime-latency-baseline', 'bounded-concurrent-throughput-baseline', 'client-cancellation-recovery', 'direct-provider-rss-samples', 'current-catalog-and-skill-bytes'],
        doesNotEstablish: ['performance-acceptance', 'semantic-quality', 'host-wide-resource-stability', 'production-capacity', 'model-token-cost'],
      },
      environment: { credentialsInherited: false, workspace: 'temporary-empty', processSandbox: 'not-enforced' },
      observationDirectory: relative(root, observationRoot),
      durationMs: rounded(performance.now() - overallStarted),
      cleanup: 'completed',
    }
    await persistMeasurementResult(observationRoot, result)
    return result
  } catch (error) {
    if (error instanceof DeveloperKitError) {
      const observationDirectory = relative(root, observationRoot)
      const result = {
        schemaVersion: 'openadam.developer-kit-measurement.v0.1',
        status: 'error',
        project: { id: loaded.project.id, version: loaded.project.version },
        error: publicError(error),
        observationDirectory,
        cleanup: 'completed',
      }
      await persistMeasurementResult(observationRoot, result)
      error.details = {
        ...(error.details !== null && typeof error.details === 'object' ? error.details : {}),
        observationDirectory,
      }
    }
    throw error
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true }).catch(() => {})
  }
}

export async function safeMeasureProject(...args) {
  try {
    return await measureProject(...args)
  } catch (error) {
    if (!(error instanceof DeveloperKitError)) throw error
    const observationDirectory = error.details?.observationDirectory
    return {
      schemaVersion: 'openadam.developer-kit-measurement.v0.1',
      status: 'error',
      error: publicError(error),
      ...(typeof observationDirectory === 'string' ? { observationDirectory } : {}),
      cleanup: 'completed-or-not-required',
    }
  }
}
