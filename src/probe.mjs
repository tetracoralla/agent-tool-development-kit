import { createReadStream, createWriteStream } from 'node:fs'
import { chmod, lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { performance } from 'node:perf_hooks'
import { createGunzip } from 'node:zlib'
import { pipeline } from 'node:stream/promises'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
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
import { resolveDeclaredFile, requireDirectory } from './paths.mjs'
import { runProjectCommand } from './runner.mjs'

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

export async function extractArchive(archive, destination) {
  const extract = tarStream.extract()
  const paths = new Set()
  let files = 0
  let bytes = 0
  extract.on('entry', (header, stream, next) => {
    const handle = async () => {
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
      await pipeline(stream, createWriteStream(target, { flags: 'wx', mode: header.mode & 0o111 ? 0o755 : 0o644 }))
      await chmod(target, header.mode & 0o111 ? 0o755 : 0o644)
    }
    handle().then(next, (error) => extract.destroy(error))
  })
  await pipeline(createReadStream(archive), createGunzip(), extract)
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

async function defaultHostPreview({ artifact, spdx, workspaceRoot, logDirectory, signal, remainingMs }) {
  const located = await locateAgentHost()
  if (!located.available || located.executable === null) {
    throw new DeveloperKitError('AGENT_HOST_UNAVAILABLE', 'Install the current Agent Host to validate the packaged component boundary.')
  }
  const args = [
    'component', 'preview', '--artifact', artifact, '--license-spdx', spdx,
    '--workspace-root', workspaceRoot, '--standalone', '--json',
  ]
  const command = await runProjectCommand({
    command: { executable: located.executable, args, timeoutMs: Math.min(remainingMs, 120_000) },
    cwd: workspaceRoot,
    logDirectory,
    signal,
    remainingMs,
    includeOutput: true,
  })
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

async function waitForTransportClose(closed) {
  let timer
  const timeout = new Promise((resolveTimeout) => {
    timer = setTimeout(resolveTimeout, 5000)
    timer.unref?.()
  })
  try {
    await Promise.race([closed, timeout])
  } finally {
    clearTimeout(timer)
  }
}

export async function openMcpProbeSession({
  extractedRoot,
  descriptor,
  workspaceRoot,
  home,
  signal,
  connectTimeoutCode = 'PROBE_RUNTIME_CONNECT_TIMEOUT',
  connectFailureCode = 'PROBE_RUNTIME_CONNECT_FAILED',
}) {
  const integration = descriptor.integration
  const runtimeCommand = contained(extractedRoot, integration.runtime.command, 'runtime command')
  const runtimeCwd = contained(extractedRoot, integration.runtime.cwd, 'runtime working directory')
  const commandInfo = await lstat(runtimeCommand)
  if (commandInfo.isSymbolicLink() || !commandInfo.isFile()) throw new DeveloperKitError('PROBE_RUNTIME_INVALID', 'The runtime command is not one real extracted file.')
  const environment = Object.fromEntries(['PATH', 'LANG', 'LC_ALL'].flatMap((name) => process.env[name] === undefined ? [] : [[name, process.env[name]]]))
  environment.HOME = home
  environment.TMPDIR = join(home, 'tmp')
  environment.OPENADAM_PROBE_MODE = '1'
  for (const name of integration.runtime.workspaceEnvironment ?? []) environment[name] = workspaceRoot
  await mkdir(environment.TMPDIR, { recursive: true })

  const transport = new StdioClientTransport({
    command: integration.runtime.executor === 'suite-node' ? process.execPath : runtimeCommand,
    args: integration.runtime.executor === 'suite-node' ? [runtimeCommand, ...integration.runtime.args] : integration.runtime.args,
    cwd: runtimeCwd,
    env: environment,
    stderr: 'pipe',
    maxBufferSize: MAX_OUTPUT_BYTES,
  })
  let resolveTransportClosed
  const transportClosed = new Promise((resolveClosed) => {
    resolveTransportClosed = resolveClosed
  })
  transport.onclose = resolveTransportClosed
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
  let connectTimer
  const connectDeadline = new Promise((_, reject) => {
    connectTimer = setTimeout(() => reject(localConnectTimeout), integration.runtime.timeoutMs)
    connectTimer.unref?.()
  })
  try {
    await Promise.race([
      client.connect(transport, { signal }),
      connectDeadline,
    ])
  } catch (error) {
    await client.close().catch(() => {})
    await waitForTransportClose(transportClosed)
    if (error === localConnectTimeout) {
      throw new DeveloperKitError(
        connectTimeoutCode,
        'The packed runtime did not complete MCP initialization within its declared timeout.',
        { timeoutMs: integration.runtime.timeoutMs },
      )
    }
    throw new DeveloperKitError(
      connectFailureCode,
      'The packed runtime failed or rejected MCP initialization.',
      { protocolCode: Number.isSafeInteger(error?.code) ? error.code : null },
    )
  } finally {
    clearTimeout(connectTimer)
  }
  try {
    const listing = await client.listTools(undefined, { timeout: integration.runtime.timeoutMs, maxTotalTimeout: integration.runtime.timeoutMs, signal })
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
      close: () => client.close(),
    }
  } catch (error) {
    await client.close().catch(() => {})
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

async function defaultMcpProbe({ extractedRoot, descriptor, probes, workspaceRoot, home, signal }) {
  const session = await openMcpProbeSession({ extractedRoot, descriptor, workspaceRoot, home, signal })
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
        const result = await client.callTool({ name: probe.tool, arguments: probe.arguments }, undefined, {
          timeout: integration.runtime.timeoutMs,
          maxTotalTimeout: integration.runtime.timeoutMs,
          signal,
        })
        bytes = resultBytes(result)
        outcome = result.isError === true ? 'tool-error' : 'success'
      } catch (error) {
        if (error?.code !== -32602) throw new DeveloperKitError('PROBE_CALL_FAILED', `Runtime probe ${probe.id} failed outside its declared result contract.`, { protocolCode: error?.code ?? null })
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
    await session.close().catch(() => {})
  }
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
  const started = performance.now()
  const root = await requireDirectory(rootInput)
  const loaded = await loadProject(root, declaredPath)
  if (loaded.project.package === undefined) throw new DeveloperKitError('PACKAGE_NOT_DECLARED', 'The project does not declare a packaged Agent tool.')
  const artifact = await resolveDeclaredFile(root, loaded.project.package.artifact, 'package artifact')
  const integration = await readBoundedJson(join(root, ...loaded.project.package.integration.replaceAll('\\', '/').split('/')), 'Agent Host integration')
  const observationRoot = join(root, '.verify', 'openadam-dev', `${timestamp()}-probe`)
  await mkdir(observationRoot, { recursive: true })
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'oadp-'))
  const extractedRoot = join(temporaryRoot, 'component')
  const workspaceRoot = join(temporaryRoot, 'workspace')
  const home = join(temporaryRoot, 'home')
  await mkdir(extractedRoot)
  await mkdir(workspaceRoot)
  await mkdir(home)
  try {
    const remainingMs = Math.floor(deadlineMs - (performance.now() - started))
    if (remainingMs <= 0) throw new DeveloperKitError('PROBE_DEADLINE_EXCEEDED', 'The probe deadline expired before Agent Host preview.')
    const host = await (dependencies.hostPreview ?? defaultHostPreview)({
      artifact,
      spdx: loaded.project.package.legal.spdx,
      workspaceRoot,
      logDirectory: join(observationRoot, 'agent-host-preview'),
      signal,
      remainingMs,
    })
    const extraction = await extractArchive(artifact, extractedRoot)
    const descriptor = await readBoundedJson(join(extractedRoot, 'component.json'), 'component descriptor')
    if (descriptor?.id !== loaded.project.package.componentId || descriptor?.version !== loaded.project.version
      || JSON.stringify(descriptor?.integration) !== JSON.stringify(integration)) {
      throw new DeveloperKitError('PROBE_PROJECT_ARTIFACT_DRIFT', 'The packaged component identity or integration differs from the current project declaration.')
    }
    if (host.preview.binding?.id !== descriptor.id || host.preview.binding?.version !== descriptor.version) {
      throw new DeveloperKitError('AGENT_HOST_RESULT_INVALID', 'Agent Host preview identity differs from the extracted component.')
    }
    const direct = await (dependencies.mcpProbe ?? defaultMcpProbe)({
      extractedRoot,
      descriptor,
      probes: loaded.project.package.probes,
      workspaceRoot,
      home,
      signal,
    })
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
      cleanup: 'completed',
    }
    await writeFile(join(observationRoot, 'result.json'), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 })
    return result
  } catch (error) {
    if (error instanceof DeveloperKitError) {
      const observationDirectory = relative(root, observationRoot)
      const result = {
        schemaVersion: 'openadam.developer-kit-probe.v0.1',
        status: 'error',
        project: { id: loaded.project.id, version: loaded.project.version },
        error: publicError(error),
        observationDirectory,
        cleanup: 'completed',
      }
      await writeFile(join(observationRoot, 'result.json'), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 })
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
      cleanup: 'completed-or-not-required',
    }
  }
}
