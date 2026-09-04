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
import {
  extractArchive,
  openMcpProbeSession,
  requireReadOnlyProbeTool,
  runMcpRequest,
} from './probe.mjs'
import {
  cleanupRuntimeAfterCloseout,
  cleanupRuntimeRoot,
  createRuntimeBudget,
  runRuntimeCloseout,
  runtimeCloseoutStatus,
} from './runtime-budget.mjs'

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

async function persistMeasurementResult(observationRoot, result, { signal } = {}) {
  await mkdir(observationRoot, { recursive: true })
  try {
    await writeFile(join(observationRoot, 'result.json'), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600, signal })
  } catch (error) {
    // Remove only a still-empty directory. A partially or previously written
    // observation remains available for recovery and diagnosis.
    await rmdir(observationRoot).catch(() => {})
    throw error
  }
}

async function persistMeasurementCloseout(observationRoot, result, budget) {
  return runRuntimeCloseout(
    (signal) => persistMeasurementResult(observationRoot, result, { signal }),
    budget.closeoutStepBudgetMs,
  )
}

async function providerRss(pid, budget) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return { status: 'unavailable', reason: 'provider-pid-unavailable' }
  try {
    budget?.throwIfStopped()
    const { stdout } = await execFileAsync('/bin/ps', ['-o', 'rss=', '-p', String(pid)], {
      timeout: Math.max(1, Math.min(2000, budget?.remainingMs() ?? 2000)),
      maxBuffer: 4096,
      signal: budget?.signal,
    })
    budget?.throwIfStopped()
    const kibibytes = Number(stdout.trim())
    if (!Number.isFinite(kibibytes) || kibibytes < 0) return { status: 'unavailable', reason: 'provider-rss-invalid' }
    return { status: 'observed', bytes: kibibytes * 1024, scope: 'direct-provider-process-only' }
  } catch (error) {
    if (budget?.cause() !== null) throw budget.error()
    return { status: 'unavailable', reason: 'provider-rss-observation-failed' }
  }
}

async function successCall(session, probe, { budget, signal } = {}) {
  const started = performance.now()
  const result = await runMcpRequest(
    () => session.client.callTool({ name: probe.tool, arguments: probe.arguments }, undefined, {
      timeout: session.integration.runtime.timeoutMs,
      maxTotalTimeout: session.integration.runtime.timeoutMs,
    }),
    {
      budget,
      signal,
      cancellationCode: 'MEASURE_CANCELLED',
      failureCode: 'MEASURE_RUNTIME_CALL_FAILED',
      failureMessage: 'The packed runtime failed or rejected the measured MCP tool call.',
    },
  )
  if (result.isError === true) throw new DeveloperKitError('MEASURE_PROBE_ERROR', 'The declared success probe returned a tool error during measurement.')
  const bytes = serializedBytes(result)
  return { durationMs: rounded(performance.now() - started), resultBytes: bytes }
}

async function contextCost(root, project, session, budget) {
  const toolBytes = session.listing.tools.map((tool) => Buffer.byteLength(JSON.stringify(tool)))
  const skillFiles = []
  for (const carrier of project.carriers.filter((item) => item.kind === 'skill')) {
    const path = await budget.run(() => resolveDeclaredFile(root, carrier.path, 'Skill carrier'))
    const info = await budget.run(() => stat(path))
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
  const budget = createRuntimeBudget({
    deadlineMs,
    signal,
    cancellationCode: 'MEASURE_CANCELLED',
    deadlineCode: 'MEASURE_DEADLINE_EXCEEDED',
  })
  let root
  let loaded
  let observationRoot
  let temporaryRoot
  try {
    budget.throwIfStopped()
    root = await budget.run(() => requireDirectory(rootInput))
    loaded = await budget.run(() => loadProject(root, declaredPath))
    if (loaded.project.package === undefined) throw new DeveloperKitError('PACKAGE_NOT_DECLARED', 'The project does not declare a packaged Agent tool.')
    const probe = loaded.project.package.probes.find((item) => item.expectation === 'success')
    if (probe === undefined) throw new DeveloperKitError('MEASURE_SUCCESS_PROBE_REQUIRED', 'Performance measurement requires one declared read-only success probe.')
    const artifact = await budget.run(() => resolveDeclaredFile(root, loaded.project.package.artifact, 'package artifact'))
    const integration = await budget.run(() => readBoundedJson(join(root, ...loaded.project.package.integration.replaceAll('\\', '/').split('/')), 'Agent Host integration'))
    observationRoot = join(root, '.verify', 'openadam-dev', `${timestamp()}-measure`)
    budget.throwIfStopped()
    temporaryRoot = await budget.run(() => mkdtemp(join(tmpdir(), 'oadm-')))
    const extractedRoot = join(temporaryRoot, 'component')
    const workspaceRoot = join(temporaryRoot, 'workspace')
    await budget.run(() => Promise.all([mkdir(extractedRoot), mkdir(workspaceRoot)]))
    await budget.run(() => extractArchive(artifact, extractedRoot, { signal: budget.signal }))
    const descriptor = await budget.run(() => readBoundedJson(join(extractedRoot, 'component.json'), 'component descriptor'))
    validateArtifact(loaded.project, descriptor, integration)

    const coldHome = join(temporaryRoot, 'cold-home')
    await budget.run(() => mkdir(coldHome))
    budget.throwIfStopped()
    const coldStarted = performance.now()
    const cold = await openMcpProbeSession({
      extractedRoot,
      descriptor,
      workspaceRoot,
      home: coldHome,
      budget,
      connectTimeoutCode: 'MEASURE_RUNTIME_CONNECT_TIMEOUT',
      connectFailureCode: 'MEASURE_RUNTIME_CONNECT_FAILED',
      connectCancellationCode: 'MEASURE_CANCELLED',
      catalogFailureCode: 'MEASURE_RUNTIME_CATALOG_FAILED',
      terminationFailureCode: 'MEASURE_RUNTIME_TERMINATION_FAILED',
    })
    let coldCall
    let coldRss
    try {
      requireReadOnlyProbeTool(cold, probe)
      const readyMs = rounded(performance.now() - coldStarted)
      coldCall = await successCall(cold, probe, { budget })
      coldRss = await providerRss(cold.transport.pid, budget)
      coldCall = { readyMs, ...coldCall, totalMs: rounded(performance.now() - coldStarted) }
    } finally {
      await cold.close()
    }

    const warmHome = join(temporaryRoot, 'warm-home')
    await budget.run(() => mkdir(warmHome))
    budget.throwIfStopped()
    const warm = await openMcpProbeSession({
      extractedRoot,
      descriptor,
      workspaceRoot,
      home: warmHome,
      budget,
      connectTimeoutCode: 'MEASURE_RUNTIME_CONNECT_TIMEOUT',
      connectFailureCode: 'MEASURE_RUNTIME_CONNECT_FAILED',
      connectCancellationCode: 'MEASURE_CANCELLED',
      catalogFailureCode: 'MEASURE_RUNTIME_CATALOG_FAILED',
      terminationFailureCode: 'MEASURE_RUNTIME_TERMINATION_FAILED',
    })
    let measurement
    try {
      requireReadOnlyProbeTool(warm, probe)
      budget.throwIfStopped()
      const context = await contextCost(root, loaded.project, warm, budget)
      for (let index = 0; index < WARMUP_CALLS; index += 1) await successCall(warm, probe, { budget })
      const rssBefore = await providerRss(warm.transport.pid, budget)
      const warmDurations = []
      for (let index = 0; index < iterations; index += 1) warmDurations.push((await successCall(warm, probe, { budget })).durationMs)

      const sustainedStarted = performance.now()
      const sustainedDurations = []
      for (let offset = 0; offset < iterations; offset += concurrency) {
        const width = Math.min(concurrency, iterations - offset)
        budget.throwIfStopped()
        const results = await budget.run(() => Promise.all(Array.from({ length: width }, () => successCall(warm, probe, { budget }))))
        sustainedDurations.push(...results.map((item) => item.durationMs))
      }
      const sustainedMs = performance.now() - sustainedStarted

      const cancelled = new AbortController()
      cancelled.abort()
      let cancellationObserved = false
      try {
        await successCall(warm, probe, { signal: cancelled.signal })
      } catch {
        cancellationObserved = true
      }
      const recovery = await successCall(warm, probe, { budget })
      budget.throwIfStopped()
      const rssAfter = await providerRss(warm.transport.pid, budget)
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
      await warm.close()
    }
    budget.throwIfStopped()
    await budget.run(() => rm(temporaryRoot, { recursive: true, force: true }))
    temporaryRoot = undefined
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
      deadline: {
        requestedMs: deadlineMs,
        closeoutBudgetMs: budget.closeoutBudgetMs,
        closeoutScope: ['pending-operations', 'provider-process-scope', 'temporary-cleanup', 'failure-observation'],
      },
      cleanup: 'completed',
    }
    await budget.run(() => persistMeasurementResult(observationRoot, result, { signal: budget.signal }))
    return result
  } catch (caught) {
    let error = budget.cause() === null ? caught : budget.error()
    if (error instanceof DeveloperKitError) {
      if (root === undefined || loaded === undefined || observationRoot === undefined) throw error
      const pendingOperations = await budget.drainPending()
      const runtimeTermination = budget.runtimeTermination()
      const temporaryRuntime = await cleanupRuntimeAfterCloseout({
        pendingOperations,
        runtimeTermination,
        temporaryRoot,
        stepBudgetMs: budget.closeoutStepBudgetMs,
      })
      temporaryRoot = undefined
      const cleanup = runtimeCloseoutStatus(pendingOperations, temporaryRuntime, runtimeTermination)
      if (runtimeTermination.status === 'unconfirmed') {
        error = new DeveloperKitError(
          'MEASURE_RUNTIME_TERMINATION_FAILED',
          'The Developer Kit could not confirm termination of the packed Provider process scope.',
          { runtimeTermination },
        )
      } else if (cleanup !== 'completed') {
        error = new DeveloperKitError(
          'MEASURE_RUNTIME_CLEANUP_FAILED',
          'The Developer Kit could not complete bounded runtime cleanup.',
          {
            pendingOperations,
            temporaryRuntime,
            priorCode: caught instanceof DeveloperKitError ? caught.code : null,
          },
        )
      } else {
        error = budget.cause() === null ? caught : budget.error()
      }
      const observationDirectory = relative(root, observationRoot)
      const result = {
        schemaVersion: 'openadam.developer-kit-measurement.v0.1',
        status: 'error',
        project: { id: loaded.project.id, version: loaded.project.version },
        error: publicError(error),
        observationDirectory,
        deadline: {
          requestedMs: deadlineMs,
          closeoutBudgetMs: budget.closeoutBudgetMs,
          closeoutScope: ['pending-operations', 'provider-process-scope', 'temporary-cleanup', 'failure-observation'],
        },
        closeout: {
          pendingOperations,
          runtimeTermination,
          temporaryRuntime,
          failureObservation: 'this-record',
          effects: {
            kitOwnedExternalStateMutation: 'none',
            providerEffects: 'not-established',
            providerProcessScope: runtimeTermination.status,
          },
        },
        cleanup,
      }
      let observationPersisted = false
      try {
        await persistMeasurementCloseout(observationRoot, result, budget)
        observationPersisted = true
      } catch {}
      error.details = {
        ...(error.details !== null && typeof error.details === 'object' ? error.details : {}),
        ...(observationPersisted ? { observationDirectory } : { observationPersistence: 'failed' }),
      }
      error.cleanup = cleanup
    }
    throw error
  } finally {
    if (temporaryRoot !== undefined) await cleanupRuntimeRoot(temporaryRoot, budget.closeoutStepBudgetMs)
    budget.close()
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
      cleanup: error.cleanup ?? 'not-established',
    }
  }
}
