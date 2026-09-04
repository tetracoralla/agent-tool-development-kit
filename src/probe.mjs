import { createReadStream, createWriteStream } from 'node:fs'
import { chmod, lstat, mkdir, mkdtemp, rm, rmdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { performance } from 'node:perf_hooks'
import { createGunzip } from 'node:zlib'
import { pipeline } from 'node:stream/promises'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import tarStream from 'tar-stream'
import {
  DEFAULT_CHECK_DEADLINE_MS,
  MAX_COMPONENT_EXPANDED_BYTES,
  MAX_COMPONENT_FILES,
  MAX_OUTPUT_BYTES,
  PROJECT_FILE,
} from './constants.mjs'
import { loadProject } from './contracts.mjs'
import { locateAgentHost } from './doctor.mjs'
import { DeveloperKitError, publicError } from './errors.mjs'
import { readBoundedJson } from './json.mjs'
import { OwnedMcpStdioTransport } from './owned-mcp-stdio-transport.mjs'
import { resolveDeclaredFile, requireDirectory } from './paths.mjs'
import { runProjectCommand } from './runner.mjs'
import {
  cleanupRuntimeAfterCloseout,
  cleanupRuntimeRoot,
  createRuntimeBudget,
  runRuntimeCloseout,
  runtimeCancellationError,
  runtimeCloseoutStatus,
} from './runtime-budget.mjs'

function timestamp() {
  return new Date().toISOString().replaceAll(':', '').replaceAll('.', '-')
}

function safeArchivePath(raw) {
  const value = raw.replace(/^\.\//u, '').replace(/\/$/u, '')
  if (value.length === 0 || value.length > 1024 || value.includes('\\') || value.startsWith('/')
    || /^[A-Za-z]:/u.test(value) || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new DeveloperKitError('PROBE_ARCHIVE_UNSAFE', 'The component archive contains an unsafe path.')
  }
  const parts = value.split('/')
  if (parts.some((part) => part === '' || part === '.' || part === '..')) {
    throw new DeveloperKitError('PROBE_ARCHIVE_UNSAFE', 'The component archive contains a non-canonical path.')
  }
  return value
}

export async function extractArchive(archive, destination, { signal } = {}) {
  const extract = tarStream.extract()
  const paths = new Set()
  let files = 0
  let bytes = 0
  extract.on('entry', (header, stream, next) => {
    const handle = async () => {
      signal?.throwIfAborted()
      if (/^\.\/?$/u.test(header.name) && header.type === 'directory') {
        stream.resume()
        await new Promise((resolveStream, reject) => stream.once('end', resolveStream).once('error', reject))
        return
      }
      const path = safeArchivePath(header.name)
      if (paths.has(path)) throw new DeveloperKitError('PROBE_ARCHIVE_UNSAFE', 'The component archive repeats a path.')
      paths.add(path)
      const target = join(destination, ...path.split('/'))
      const relation = relative(destination, target)
      if (relation === '..' || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
        throw new DeveloperKitError('PROBE_ARCHIVE_UNSAFE', 'The component archive escapes the probe directory.')
      }
      if (header.type === 'directory') {
        await mkdir(target, { recursive: true })
        stream.resume()
        await new Promise((resolveStream, reject) => stream.once('end', resolveStream).once('error', reject))
        return
      }
      if (header.type !== 'file' || !Number.isSafeInteger(header.size) || header.size < 0) {
        throw new DeveloperKitError('PROBE_ARCHIVE_UNSAFE', 'The component archive contains a link, special file, or invalid size.')
      }
      files += 1
      bytes += header.size
      if (files > MAX_COMPONENT_FILES + 1 || bytes > MAX_COMPONENT_EXPANDED_BYTES + 1024 * 1024) {
        throw new DeveloperKitError('PROBE_ARCHIVE_LIMIT_EXCEEDED', 'The component archive exceeds the probe extraction limits.')
      }
      await mkdir(dirname(target), { recursive: true })
      await pipeline(
        stream,
        createWriteStream(target, { flags: 'wx', mode: header.mode & 0o111 ? 0o755 : 0o644 }),
        { signal },
      )
      await chmod(target, header.mode & 0o111 ? 0o755 : 0o644)
    }
    handle().then(next, (error) => extract.destroy(error))
  })
  await pipeline(createReadStream(archive), createGunzip(), extract, { signal })
  if (!paths.has('component.json')) throw new DeveloperKitError('PROBE_DESCRIPTOR_MISSING', 'The component archive does not contain component.json.')
  return { files, expandedBytes: bytes }
}

function parseHostJson(commandResult) {
  const raw = commandResult.status === 'ok' ? commandResult.stdout : commandResult.stderr || commandResult.stdout
  let value
  try {
    value = JSON.parse(raw)
  } catch {
    throw new DeveloperKitError('AGENT_HOST_RESULT_INVALID', 'Agent Host did not return one bounded JSON result.')
  }
  if (commandResult.status !== 'ok' || value?.status === 'error') {
    const code = value?.error?.code
    if (code === 'CLI_USAGE') {
      throw new DeveloperKitError('AGENT_HOST_UPGRADE_REQUIRED', 'The installed Agent Host does not support standalone component preview yet.')
    }
    throw new DeveloperKitError('AGENT_HOST_PREVIEW_FAILED', 'Agent Host rejected the component archive.', {
      hostCode: typeof code === 'string' ? code : 'UNKNOWN',
    })
  }
  if (value?.schemaVersion !== 'openadam.agent-host-local-component-preview.v0.1' || value?.status !== 'ready') {
    throw new DeveloperKitError('AGENT_HOST_RESULT_INVALID', 'Agent Host returned an unsupported preview result.')
  }
  return value
}

async function defaultHostPreview({ artifact, spdx, workspaceRoot, logDirectory, signal, budget, remainingMs }) {
  const stopSignal = budget?.signal ?? signal
  const located = await locateAgentHost({ signal: stopSignal, timeout: Math.max(1, Math.min(remainingMs + 50, 3000)) })
  if (budget === undefined) throwIfRuntimeCancelled(signal, 'PROBE_CANCELLED')
  else budget.throwIfStopped()
  if (!located.available || located.executable === null) {
    throw new DeveloperKitError('AGENT_HOST_UNAVAILABLE', 'Install the current Agent Host to validate the packaged component boundary.')
  }
  const args = [
    'component', 'preview', '--artifact', artifact, '--license-spdx', spdx,
    '--workspace-root', workspaceRoot, '--standalone', '--json',
  ]
  const hostCommandLimitMs = Math.min(remainingMs + 50, 120_000)
  const command = await runProjectCommand({
    command: { executable: located.executable, args, timeoutMs: hostCommandLimitMs },
    cwd: workspaceRoot,
    logDirectory,
    signal: stopSignal,
    remainingMs: hostCommandLimitMs,
    includeOutput: true,
  })
  if (budget === undefined) throwIfRuntimeCancelled(signal, 'PROBE_CANCELLED')
  else budget.throwIfStopped()
  const preview = parseHostJson(command)
  return {
    source: located.source,
    preview,
    command: {
      status: command.status,
      exitCode: command.exitCode,
      reason: command.reason,
      durationMs: command.durationMs,
      stdoutBytes: command.stdoutBytes,
      stderrBytes: command.stderrBytes,
    },
  }
}

function contained(root, value, label) {
  const parts = safeArchivePath(value).split('/')
  const target = resolve(root, ...parts)
  const relation = relative(root, target)
  if (relation === '..' || relation.startsWith(`..${sep}`) || isAbsolute(relation)) {
    throw new DeveloperKitError('PROBE_DESCRIPTOR_INVALID', `${label} escapes the extracted component.`)
  }
  return target
}

function resultBytes(value) {
  const bytes = Buffer.byteLength(JSON.stringify(value))
  if (bytes > MAX_OUTPUT_BYTES) {
    throw new DeveloperKitError('PROBE_RESULT_LIMIT_EXCEEDED', `A runtime probe result exceeds ${MAX_OUTPUT_BYTES} serialized bytes.`)
  }
  return bytes
}

async function persistProbeResult(observationRoot, result, { signal } = {}) {
  await mkdir(observationRoot, { recursive: true })
  try {
    await writeFile(join(observationRoot, 'result.json'), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600, signal })
  } catch (error) {
    await rmdir(observationRoot).catch(() => {})
    throw error
  }
}

async function closeMcpClient(client, transport, budget, failureCode) {
  let closeError
  try {
    // The SDK clears its transport reference as soon as Provider stdout closes.
    // Close the Kit-owned transport directly so an already-exited root cannot
    // make the SDK skip descendant/process-group cleanup.
    await transport.close()
    await client.close()
  } catch (error) {
    closeError = error
  } finally {
    budget?.recordRuntimeTermination(transport, transport.termination)
  }
  if (!['confirmed', 'not-required'].includes(transport.termination.status) || closeError !== undefined) {
    throw new DeveloperKitError(
      failureCode,
      'The Developer Kit could not confirm termination of the packed Provider process scope.',
      { runtimeTermination: transport.termination },
    )
  }
  return transport.termination
}

function boundedProtocolCode(error) {
  return Number.isInteger(error?.code) && error.code >= -2_147_483_648 && error.code <= 2_147_483_647
    ? error.code
    : null
}

async function persistCloseoutResult(persist, observationRoot, result) {
  return runRuntimeCloseout((signal) => persist(observationRoot, result, { signal }))
}

export function throwIfRuntimeCancelled(signal, code = 'PROBE_CANCELLED') {
  if (signal?.aborted) throw runtimeCancellationError(code)
}

export async function runMcpRequest(operation, {
  budget,
  signal,
  cancellationCode = 'PROBE_CANCELLED',
  failureCode,
  failureMessage,
  passthroughProtocolCodes = [],
} = {}) {
  try {
    if (budget !== undefined) return await budget.run(operation)
    throwIfRuntimeCancelled(signal, cancellationCode)
    if (signal === undefined) return await operation()
  } catch (error) {
    if (error instanceof DeveloperKitError || failureCode === undefined || passthroughProtocolCodes.includes(error?.code)) throw error
    throw new DeveloperKitError(failureCode, failureMessage, { protocolCode: boundedProtocolCode(error) })
  }
  const localCancellation = Object.freeze({ kind: 'openadam-local-operation-cancellation' })
  let cancel
  const cancellation = new Promise((_, reject) => {
    cancel = () => reject(localCancellation)
  })
  signal?.addEventListener('abort', cancel, { once: true })
  if (signal?.aborted) {
    signal.removeEventListener('abort', cancel)
    throw runtimeCancellationError(cancellationCode)
  }
  try {
    const request = Promise.resolve().then(operation)
    return await Promise.race([request, cancellation])
  } catch (error) {
    if (error === localCancellation) throw runtimeCancellationError(cancellationCode)
    if (error instanceof DeveloperKitError || failureCode === undefined || passthroughProtocolCodes.includes(error?.code)) throw error
    throw new DeveloperKitError(failureCode, failureMessage, { protocolCode: boundedProtocolCode(error) })
  } finally {
    signal?.removeEventListener('abort', cancel)
  }
}

export async function openMcpProbeSession({
  extractedRoot,
  descriptor,
  workspaceRoot,
  home,
  signal,
  budget,
  connectTimeoutCode = 'PROBE_RUNTIME_CONNECT_TIMEOUT',
  connectFailureCode = 'PROBE_RUNTIME_CONNECT_FAILED',
  connectCancellationCode = 'PROBE_CANCELLED',
  catalogFailureCode = 'PROBE_RUNTIME_CATALOG_FAILED',
  terminationFailureCode = 'PROBE_RUNTIME_TERMINATION_FAILED',
}) {
  const cancellationError = () => runtimeCancellationError(connectCancellationCode)
  if (budget === undefined) throwIfRuntimeCancelled(signal, connectCancellationCode)
  else budget.throwIfStopped()
  const integration = descriptor.integration
  const runtimeCommand = contained(extractedRoot, integration.runtime.command, 'runtime command')
  const runtimeCwd = contained(extractedRoot, integration.runtime.cwd, 'runtime working directory')
  const commandInfo = budget === undefined
    ? await lstat(runtimeCommand)
    : await budget.run(() => lstat(runtimeCommand))
  if (commandInfo.isSymbolicLink() || !commandInfo.isFile()) throw new DeveloperKitError('PROBE_RUNTIME_INVALID', 'The runtime command is not one real extracted file.')
  const environment = Object.fromEntries(['PATH', 'LANG', 'LC_ALL'].flatMap((name) => process.env[name] === undefined ? [] : [[name, process.env[name]]]))
  environment.HOME = home
  environment.TMPDIR = join(home, 'tmp')
  environment.OPENADAM_PROBE_MODE = '1'
  for (const name of integration.runtime.workspaceEnvironment ?? []) environment[name] = workspaceRoot
  if (budget === undefined) await mkdir(environment.TMPDIR, { recursive: true })
  else await budget.run(() => mkdir(environment.TMPDIR, { recursive: true }))
  if (budget === undefined) throwIfRuntimeCancelled(signal, connectCancellationCode)
  else budget.throwIfStopped()

  const transport = new OwnedMcpStdioTransport({
    command: integration.runtime.executor === 'suite-node' ? process.execPath : runtimeCommand,
    args: integration.runtime.executor === 'suite-node' ? [runtimeCommand, ...integration.runtime.args] : integration.runtime.args,
    cwd: runtimeCwd,
    env: environment,
    stderr: 'pipe',
    maxBufferSize: MAX_OUTPUT_BYTES,
  })
  let stderrBytes = 0
  transport.stderr?.on('data', (chunk) => {
    stderrBytes += chunk.length
    if (stderrBytes > MAX_OUTPUT_BYTES) void transport.close().catch(() => {})
  })
  const client = new Client({ name: 'openadam-developer-kit-probe', version: '0.1.0' })
  // MCP uses -32001 both for its own request timeout and for a Provider-sent
  // JSON-RPC error carrying that number. Only this private sentinel establishes
  // that the Developer Kit's declared initialization deadline actually fired.
  const localConnectTimeout = Object.freeze({ kind: 'openadam-local-connect-timeout' })
  const localConnectCancellation = Object.freeze({ kind: 'openadam-local-connect-cancellation' })
  let connectTimer
  const connectDeadline = new Promise((_, reject) => {
    connectTimer = setTimeout(() => reject(localConnectTimeout), integration.runtime.timeoutMs)
    connectTimer.unref?.()
  })
  let cancelConnect
  const connectCancellation = new Promise((_, reject) => {
    cancelConnect = () => reject(localConnectCancellation)
  })
  const stopSignal = budget?.signal ?? signal
  stopSignal?.addEventListener('abort', cancelConnect, { once: true })
  if (stopSignal?.aborted) cancelConnect()
  try {
    await Promise.race([
      client.connect(transport),
      connectDeadline,
      connectCancellation,
    ])
  } catch (error) {
    try {
      await closeMcpClient(client, transport, budget, terminationFailureCode)
    } catch (closeError) {
      throw closeError
    }
    if (budget?.cause() !== null) throw budget.error()
    if (error === localConnectTimeout) {
      throw new DeveloperKitError(
        connectTimeoutCode,
        'The packed runtime did not complete MCP initialization within its declared timeout.',
        { timeoutMs: integration.runtime.timeoutMs },
      )
    }
    if (error === localConnectCancellation) {
      if (budget !== undefined) throw budget.error()
      throw cancellationError()
    }
    throw new DeveloperKitError(
      connectFailureCode,
      'The packed runtime failed or rejected MCP initialization.',
      { protocolCode: boundedProtocolCode(error) },
    )
  } finally {
    clearTimeout(connectTimer)
    stopSignal?.removeEventListener('abort', cancelConnect)
  }
  try {
    const listing = await runMcpRequest(
      () => client.listTools(undefined, { timeout: integration.runtime.timeoutMs, maxTotalTimeout: integration.runtime.timeoutMs }),
      {
        budget,
        signal,
        cancellationCode: connectCancellationCode,
        failureCode: catalogFailureCode,
        failureMessage: 'The packed runtime failed or rejected MCP tool catalog discovery.',
      },
    )
    const catalogBytes = resultBytes(listing.tools)
    const byName = new Map(listing.tools.map((tool) => [tool.name, tool]))
    if (integration.runtime.expectedTools.some((name) => !byName.has(name))) throw new DeveloperKitError('PROBE_TOOL_MISSING', 'The direct probe catalog omits an expected tool.')
    return {
      client,
      transport,
      integration,
      listing,
      byName,
      catalogBytes,
      stderrBytes: () => stderrBytes,
      close: () => closeMcpClient(client, transport, budget, terminationFailureCode),
    }
  } catch (error) {
    try {
      await closeMcpClient(client, transport, budget, terminationFailureCode)
    } catch (closeError) {
      throw closeError
    }
    throw error
  }
}

export function requireReadOnlyProbeTool(session, probe) {
  const tool = session.byName.get(probe.tool)
  if (tool === undefined) throw new DeveloperKitError('PROBE_TOOL_MISSING', `Runtime probe ${probe.id} targets an unavailable tool.`)
  if (tool.annotations?.readOnlyHint !== true || tool.annotations?.destructiveHint === true || tool.annotations?.openWorldHint === true) {
    throw new DeveloperKitError('PROBE_EFFECT_BOUNDARY_UNSAFE', `Runtime probe ${probe.id} cannot auto-call a tool without closed read-only annotations.`)
  }
  return tool
}

async function defaultMcpProbe({ extractedRoot, descriptor, probes, workspaceRoot, home, signal, budget }) {
  const session = await openMcpProbeSession({ extractedRoot, descriptor, workspaceRoot, home, signal, budget })
  const { client, integration, byName } = session
  try {
    const results = []
    for (const probe of probes) {
      requireReadOnlyProbeTool(session, probe)
      const started = performance.now()
      let outcome
      let bytes = 0
      let protocolCode = null
      try {
        const result = await runMcpRequest(
          () => client.callTool({ name: probe.tool, arguments: probe.arguments }, undefined, {
            timeout: integration.runtime.timeoutMs,
            maxTotalTimeout: integration.runtime.timeoutMs,
          }),
          {
            budget,
            signal,
            cancellationCode: 'PROBE_CANCELLED',
            failureCode: 'PROBE_CALL_FAILED',
            failureMessage: `Runtime probe ${probe.id} failed outside its declared result contract.`,
            passthroughProtocolCodes: [-32602],
          },
        )
        bytes = resultBytes(result)
        outcome = result.isError === true ? 'tool-error' : 'success'
      } catch (error) {
        if (error instanceof DeveloperKitError) throw error
        if (error?.code !== -32602) throw error
        outcome = 'protocol-error'
        protocolCode = error.code
      }
      const durationMs = Math.round((performance.now() - started) * 1000) / 1000
      results.push({ id: probe.id, tool: probe.tool, expectation: probe.expectation, outcome, status: outcome === probe.expectation ? 'ok' : 'error', durationMs, resultBytes: bytes, protocolCode })
    }
    return {
      status: results.every((item) => item.status === 'ok') ? 'ok' : 'error',
      catalog: { tools: [...byName.keys()].sort(), count: byName.size, canonicalUtf8Bytes: session.catalogBytes },
      probes: results,
      stderrBytes: session.stderrBytes(),
    }
  } finally {
    await session.close()
  }
}

function finalProbeError(caught, budget, closeout) {
  if (closeout.runtimeTermination.status === 'unconfirmed') {
    return new DeveloperKitError(
      'PROBE_RUNTIME_TERMINATION_FAILED',
      'The Developer Kit could not confirm termination of the packed Provider process scope.',
      { runtimeTermination: closeout.runtimeTermination },
    )
  }
  if (closeout.cleanup !== 'completed') {
    return new DeveloperKitError(
      'PROBE_RUNTIME_CLEANUP_FAILED',
      'The Developer Kit could not complete bounded runtime cleanup.',
      {
        pendingOperations: closeout.pendingOperations,
        temporaryRuntime: closeout.temporaryRuntime,
        priorCode: caught instanceof DeveloperKitError ? caught.code : null,
      },
    )
  }
  return budget.cause() === null ? caught : budget.error()
}

function summarizedHost(value) {
  return {
    source: value.source,
    command: value.command,
    binding: value.preview.binding,
    component: value.preview.component,
    health: {
      firstLaunchMs: value.preview.health?.firstLaunchMs,
      repeatLaunchMs: value.preview.health?.repeatLaunchMs,
      tools: value.preview.health?.first?.tools ?? value.preview.component.expectedTools,
    },
    assessment: value.preview.assessment,
  }
}

export async function probeProject(rootInput, {
  declaredPath = PROJECT_FILE,
  deadlineMs = DEFAULT_CHECK_DEADLINE_MS,
  signal,
} = {}, dependencies = {}) {
  const budget = createRuntimeBudget({
    deadlineMs,
    signal,
    cancellationCode: 'PROBE_CANCELLED',
    deadlineCode: 'PROBE_DEADLINE_EXCEEDED',
  })
  let temporaryRoot
  let root
  let loaded
  let observationRoot
  try {
    budget.throwIfStopped()
    root = await budget.run(() => requireDirectory(rootInput))
    loaded = await budget.run(() => loadProject(root, declaredPath))
    if (loaded.project.package === undefined) throw new DeveloperKitError('PACKAGE_NOT_DECLARED', 'The project does not declare a packaged Agent tool.')
    const artifact = await budget.run(() => resolveDeclaredFile(root, loaded.project.package.artifact, 'package artifact'))
    const integration = await budget.run(() => readBoundedJson(join(root, ...loaded.project.package.integration.replaceAll('\\', '/').split('/')), 'Agent Host integration'))
    budget.throwIfStopped()
    observationRoot = join(root, '.verify', 'openadam-dev', `${timestamp()}-probe`)
    await budget.run(() => mkdir(observationRoot, { recursive: true }))
    temporaryRoot = await budget.run(() => mkdtemp(join(tmpdir(), 'oadp-')))
    const extractedRoot = join(temporaryRoot, 'component')
    const workspaceRoot = join(temporaryRoot, 'workspace')
    const home = join(temporaryRoot, 'home')
    await budget.run(() => Promise.all([mkdir(extractedRoot), mkdir(workspaceRoot), mkdir(home)]))
    budget.throwIfStopped()
    const remainingMs = budget.remainingMs()
    const host = await budget.run(() => (dependencies.hostPreview ?? defaultHostPreview)({
      artifact,
      spdx: loaded.project.package.legal.spdx,
      workspaceRoot,
      logDirectory: join(observationRoot, 'agent-host-preview'),
      signal: budget.signal,
      budget,
      remainingMs,
    }))
    budget.throwIfStopped()
    const extraction = await budget.run(() => extractArchive(artifact, extractedRoot, { signal: budget.signal }))
    const descriptor = await budget.run(() => readBoundedJson(join(extractedRoot, 'component.json'), 'component descriptor'))
    if (descriptor?.id !== loaded.project.package.componentId || descriptor?.version !== loaded.project.version
      || JSON.stringify(descriptor?.integration) !== JSON.stringify(integration)) {
      throw new DeveloperKitError('PROBE_PROJECT_ARTIFACT_DRIFT', 'The packaged component identity or integration differs from the current project declaration.')
    }
    if (host.preview.binding?.id !== descriptor.id || host.preview.binding?.version !== descriptor.version) {
      throw new DeveloperKitError('AGENT_HOST_RESULT_INVALID', 'Agent Host preview identity differs from the extracted component.')
    }
    budget.throwIfStopped()
    const direct = await budget.run(() => (dependencies.mcpProbe ?? defaultMcpProbe)({
      extractedRoot,
      descriptor,
      probes: loaded.project.package.probes,
      workspaceRoot,
      home,
      signal: budget.signal,
      budget,
    }))
    await budget.run(() => rm(temporaryRoot, { recursive: true, force: true }))
    temporaryRoot = undefined
    const result = {
      schemaVersion: 'openadam.developer-kit-probe.v0.1',
      status: direct.status,
      project: { id: loaded.project.id, version: loaded.project.version },
      artifact: { path: loaded.project.package.artifact, sourceParity: 'not-established-by-probe' },
      host: summarizedHost(host),
      direct,
      extraction,
      observationDirectory: relative(root, observationRoot),
      environment: {
        credentialsInherited: false,
        agentHostState: 'not-read-or-written',
        agentAppConfiguration: 'not-read-or-written',
        workspace: 'temporary-empty',
        processSandbox: 'not-enforced',
      },
      deadline: {
        requestedMs: deadlineMs,
        closeoutBudgetMs: budget.closeoutBudgetMs,
        closeoutScope: ['pending-operations', 'provider-process-scope', 'temporary-cleanup', 'failure-observation'],
      },
      cleanup: 'completed',
    }
    budget.throwIfStopped()
    await budget.run(() => persistProbeResult(observationRoot, result, { signal: budget.signal }))
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
      })
      temporaryRoot = undefined
      const cleanup = runtimeCloseoutStatus(pendingOperations, temporaryRuntime, runtimeTermination)
      error = finalProbeError(caught, budget, { pendingOperations, runtimeTermination, temporaryRuntime, cleanup })
      const observationDirectory = relative(root, observationRoot)
      const result = {
        schemaVersion: 'openadam.developer-kit-probe.v0.1',
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
        await persistCloseoutResult(persistProbeResult, observationRoot, result)
        observationPersisted = true
      } catch {}
      error.details = {
        ...(error.details !== null && typeof error.details === 'object' ? error.details : {}),
        ...(observationPersisted ? { observationDirectory } : { observationPersistence: 'failed' }),
      }
      error.cleanup = cleanup
    } else if (observationRoot !== undefined) {
      await rmdir(observationRoot).catch(() => {})
    }
    throw error
  } finally {
    if (temporaryRoot !== undefined) await cleanupRuntimeRoot(temporaryRoot)
    budget.close()
  }
}

export async function safeProbeProject(...args) {
  try {
    return await probeProject(...args)
  } catch (error) {
    if (!(error instanceof DeveloperKitError)) throw error
    const observationDirectory = error.details?.observationDirectory
    return {
      schemaVersion: 'openadam.developer-kit-probe.v0.1',
      status: 'error',
      error: publicError(error),
      ...(typeof observationDirectory === 'string' ? { observationDirectory } : {}),
      cleanup: error.cleanup ?? 'not-established',
    }
  }
}
