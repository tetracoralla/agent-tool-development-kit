import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { createGzip } from 'node:zlib'
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import tarStream from 'tar-stream'
import { checkProject } from './check.mjs'
import {
  COMPONENT_SCHEMA_VERSION,
  DEFAULT_CHECK_DEADLINE_MS,
  MAX_COMPONENT_ARCHIVE_BYTES,
  MAX_COMPONENT_EXPANDED_BYTES,
  MAX_COMPONENT_FILES,
  MAX_COMPONENT_PATH_BYTES,
  PROJECT_FILE,
  TOOL_INTEGRATION_SCHEMA_VERSIONS,
} from './constants.mjs'
import { loadProject } from './contracts.mjs'
import { DeveloperKitError, publicError } from './errors.mjs'
import { readBoundedJson } from './json.mjs'
import { requireDirectory, requireRelativePath } from './paths.mjs'
import { runProjectCommand } from './runner.mjs'

const FIXED_TIME = new Date('2000-01-01T00:00:00.000Z')

function timestamp() {
  return new Date().toISOString().replaceAll(':', '').replaceAll('.', '-')
}

async function state(path) {
  try {
    return await lstat(path)
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

function inside(root, path) {
  const rel = relative(root, path)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

async function outputTarget(root, declaredPath) {
  const safe = requireRelativePath(declaredPath, 'package artifact path').replaceAll('\\', '/')
  if (!safe.endsWith('.tar.gz')) throw new DeveloperKitError('PACKAGE_ARTIFACT_INVALID', 'The package artifact must end with .tar.gz.')
  const target = resolve(root, ...safe.split('/'))
  if (!inside(root, target)) throw new DeveloperKitError('PATH_ESCAPE', 'The package artifact escapes the repository.')
  const parts = safe.split('/').filter((item) => item !== '.' && item !== '')
  let current = root
  for (const part of parts.slice(0, -1)) {
    current = join(current, part)
    const info = await state(current)
    if (info === null) continue
    if (info.isSymbolicLink()) throw new DeveloperKitError('PATH_SYMLINK_REJECTED', 'The package artifact parent may not contain a symbolic link.')
    if (!info.isDirectory()) throw new DeveloperKitError('PACKAGE_ARTIFACT_INVALID', 'The package artifact parent contains a non-directory entry.')
  }
  return { target, relative: safe }
}

async function ensureOutputParent(root, output) {
  await mkdir(dirname(output.target), { recursive: true })
  const parts = output.relative.split('/').filter((item) => item !== '.' && item !== '')
  let current = root
  for (const part of parts.slice(0, -1)) {
    current = join(current, part)
    const info = await lstat(current)
    if (info.isSymbolicLink()) throw new DeveloperKitError('PATH_SYMLINK_REJECTED', 'The package artifact parent may not contain a symbolic link.')
    if (!info.isDirectory()) throw new DeveloperKitError('PACKAGE_ARTIFACT_INVALID', 'The package artifact parent contains a non-directory entry.')
  }
  const parentReal = await realpath(dirname(output.target))
  if (!inside(root, parentReal)) throw new DeveloperKitError('PATH_ESCAPE', 'The package artifact parent escapes the repository.')
}

function exactKeys(value, allowed, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new DeveloperKitError('TOOL_INTEGRATION_INVALID', `${label} must be an object.`)
  }
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key))
  if (unexpected.length > 0) {
    throw new DeveloperKitError('TOOL_INTEGRATION_INVALID', `${label} contains unsupported fields.`, { fields: unexpected.slice(0, 32) })
  }
}

function boundedString(value, label, maximum = 1024) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maximum || /[\u0000\r\n]/u.test(value)) {
    throw new DeveloperKitError('TOOL_INTEGRATION_INVALID', `${label} is invalid.`)
  }
  return value
}

function componentPath(value, label) {
  boundedString(value, label, MAX_COMPONENT_PATH_BYTES)
  if (value.includes('\\') || value.startsWith('/') || /^[A-Za-z]:/u.test(value) || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new DeveloperKitError('TOOL_INTEGRATION_INVALID', `${label} must be a contained POSIX relative path.`)
  }
  const normalized = posix.normalize(value)
  if (normalized !== value || normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    throw new DeveloperKitError('TOOL_INTEGRATION_INVALID', `${label} must be a canonical contained relative path.`)
  }
  return value
}

function stringArray(value, label, minimum = 0) {
  if (!Array.isArray(value) || value.length < minimum || value.length > 128
    || value.some((item) => typeof item !== 'string' || item.length === 0)
    || new Set(value).size !== value.length) {
    throw new DeveloperKitError('TOOL_INTEGRATION_INVALID', `${label} is invalid.`)
  }
  return value
}

function validateIntegration(value, componentId) {
  exactKeys(value, ['schemaVersion', 'displayName', 'summary', 'codex', 'runtime', 'ownership'], 'tool integration')
  if (!TOOL_INTEGRATION_SCHEMA_VERSIONS.includes(value.schemaVersion)) {
    throw new DeveloperKitError('TOOL_INTEGRATION_UNSUPPORTED', `Only ${TOOL_INTEGRATION_SCHEMA_VERSIONS.join(' or ')} is supported by this Developer Kit version.`)
  }
  boundedString(value.displayName, 'tool display name', 80)
  boundedString(value.summary, 'tool summary', 180)

  exactKeys(value.codex, ['marketplaceRoot', 'marketplace', 'pluginRoot', 'plugin', 'identityFiles'], 'Codex integration')
  componentPath(value.codex.marketplaceRoot, 'Codex marketplace root')
  componentPath(value.codex.pluginRoot, 'Codex plugin root')
  if (!/^[a-z][a-z0-9-]*$/u.test(value.codex.marketplace ?? '') || !/^[a-z][a-z0-9-]*$/u.test(value.codex.plugin ?? '')) {
    throw new DeveloperKitError('TOOL_INTEGRATION_INVALID', 'Codex marketplace and plugin ids must use lower-case hyphen-case.')
  }
  if (value.codex.plugin !== componentId) {
    throw new DeveloperKitError('TOOL_INTEGRATION_INVALID', 'The Codex plugin id must equal package.componentId.')
  }
  for (const path of stringArray(value.codex.identityFiles, 'Codex identity files', 2)) componentPath(path, 'Codex identity file')

  const runtimeKeys = ['transport', 'executor', 'command', 'args', 'cwd', 'workspaceEnvironment', 'expectedTools', 'timeoutMs']
  if (value.schemaVersion === 'openadam.agent-host-tool-integration.v0.5') runtimeKeys.push('optionalPathEnvironment')
  exactKeys(value.runtime, runtimeKeys, 'runtime integration')
  if (value.runtime.transport !== 'mcp-stdio' || !['component', 'suite-node'].includes(value.runtime.executor)) {
    throw new DeveloperKitError('TOOL_INTEGRATION_INVALID', 'The runtime must use MCP stdio and a component or suite-node executor.')
  }
  componentPath(value.runtime.command, 'runtime command')
  componentPath(value.runtime.cwd, 'runtime working directory')
  stringArray(value.runtime.args, 'runtime arguments')
  const workspaceEnvironment = stringArray(value.runtime.workspaceEnvironment, 'workspace environment')
  if (workspaceEnvironment.some((name) => !/^[A-Z][A-Z0-9_]*$/u.test(name))) {
    throw new DeveloperKitError('TOOL_INTEGRATION_INVALID', 'Workspace environment names must use upper-case identifier syntax.')
  }
  const optionalPathEnvironment = value.schemaVersion === 'openadam.agent-host-tool-integration.v0.5'
    ? stringArray(value.runtime.optionalPathEnvironment ?? [], 'optional path environment')
    : []
  if (optionalPathEnvironment.some((name) => !/^[A-Z][A-Z0-9_]*$/u.test(name))) {
    throw new DeveloperKitError('TOOL_INTEGRATION_INVALID', 'Optional path environment names must use upper-case identifier syntax.')
  }
  if (optionalPathEnvironment.some((name) => workspaceEnvironment.includes(name))) {
    throw new DeveloperKitError('TOOL_INTEGRATION_INVALID', 'Workspace and optional path environment names must be distinct.')
  }
  stringArray(value.runtime.expectedTools, 'expected tools', 1)
  if (!Number.isSafeInteger(value.runtime.timeoutMs) || value.runtime.timeoutMs < 1000 || value.runtime.timeoutMs > 30000) {
    throw new DeveloperKitError('TOOL_INTEGRATION_INVALID', 'The runtime timeout must be an integer from 1000 to 30000 milliseconds.')
  }

  exactKeys(value.ownership, ['uninstall'], 'integration ownership')
  if (value.ownership.uninstall !== 'agent-host-created-only') {
    throw new DeveloperKitError('TOOL_INTEGRATION_INVALID', 'The only supported uninstall ownership is agent-host-created-only.')
  }
  return value
}

async function digestFile(path, leakagePatterns = [], componentRelativePath = undefined) {
  const hash = createHash('sha256')
  const patterns = leakagePatterns.map((item) => Buffer.from(item)).filter((item) => item.length > 0)
  const overlapLength = Math.max(256, ...patterns.map((item) => item.length - 1))
  let overlap = Buffer.alloc(0)
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk)
    if (patterns.length > 0) {
      const searchable = Buffer.concat([overlap, chunk])
      const text = searchable.toString('utf8')
      if (patterns.some((pattern) => searchable.includes(pattern)) || /file:\/\/\/(?:Users|home|C:\/Users)\//u.test(text)) {
        throw new DeveloperKitError('PACKAGE_SOURCE_PATH_LEAK', 'The staged component contains a source-machine path.', componentRelativePath === undefined ? undefined : { path: componentRelativePath })
      }
      overlap = overlapLength === 0 ? Buffer.alloc(0) : searchable.subarray(Math.max(0, searchable.length - overlapLength))
    }
  }
  return `sha256:${hash.digest('hex')}`
}

export async function inventoryComponent(root, sourceRoots, temporaryRoot) {
  const files = []
  let bytes = 0
  const sourceAliases = [...new Set(sourceRoots.flatMap((path) => [
    path,
    path.startsWith('/private/') ? path.slice('/private'.length) : null,
    path.startsWith('/var/') ? `/private${path}` : null,
  ]).filter(Boolean))]
  const leakagePatterns = [
    ...sourceAliases.flatMap((path) => [path, `file://${path}`]),
    temporaryRoot,
    `file://${temporaryRoot}`,
  ]

  async function walk(directory) {
    const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))
    for (const entry of entries) {
      const path = join(directory, entry.name)
      const info = await lstat(path)
      const rel = relative(root, path).split(sep).join('/')
      componentPath(rel, 'component file path')
      if (rel === 'component.json') throw new DeveloperKitError('PACKAGE_RESERVED_FILE', 'The package command may not create reserved component.json.')
      if (info.isSymbolicLink()) throw new DeveloperKitError('PACKAGE_SYMLINK_REJECTED', `The staged component contains a symbolic link: ${rel}`)
      if (info.isDirectory()) {
        await walk(path)
        continue
      }
      if (!info.isFile()) throw new DeveloperKitError('PACKAGE_SPECIAL_FILE_REJECTED', `The staged component contains a special file: ${rel}`)
      bytes += info.size
      if (files.length >= MAX_COMPONENT_FILES || bytes > MAX_COMPONENT_EXPANDED_BYTES) {
        throw new DeveloperKitError('PACKAGE_LIMIT_EXCEEDED', 'The staged component exceeds fixed file-count or expanded-byte limits.', {
          maximumFiles: MAX_COMPONENT_FILES,
          maximumExpandedBytes: MAX_COMPONENT_EXPANDED_BYTES,
        })
      }
      const executable = (info.mode & 0o111) !== 0
      const sha256 = await digestFile(path, leakagePatterns, rel)
      await chmod(path, executable ? 0o755 : 0o644)
      await utimes(path, FIXED_TIME, FIXED_TIME)
      files.push({ path: rel, sha256, bytes: info.size, executable })
    }
  }
  await walk(root)
  if (files.length === 0) throw new DeveloperKitError('PACKAGE_EMPTY', 'The package command did not stage any component files.')
  return files.sort((left, right) => left.path.localeCompare(right.path))
}

function requireInventoryPath(paths, value, label) {
  const normalized = componentPath(value, label)
  if (!paths.has(normalized)) throw new DeveloperKitError('PACKAGE_FILE_MISSING', `${label} is absent from the staged component.`, { path: normalized })
  return normalized
}

async function validatePayload(root, project, integration, files) {
  const paths = new Set(files.map((item) => item.path))
  const marketplaceFile = requireInventoryPath(paths, `${integration.codex.marketplaceRoot}/.agents/plugins/marketplace.json`, 'Codex marketplace manifest')
  const pluginIdentity = integration.codex.identityFiles.map((path) => requireInventoryPath(paths, `${integration.codex.pluginRoot}/${path}`, 'Codex plugin identity file'))
  const command = requireInventoryPath(paths, integration.runtime.command, 'runtime command')
  const legal = Object.fromEntries(Object.entries(project.package.legal)
    .filter(([key]) => key !== 'spdx')
    .map(([key, path]) => [key, requireInventoryPath(paths, path, `legal ${key}`)]))

  const pluginPath = `${integration.codex.pluginRoot}/.codex-plugin/plugin.json`
  requireInventoryPath(paths, pluginPath, 'Codex plugin manifest')
  const plugin = await readBoundedJson(join(root, ...pluginPath.split('/')), 'Codex plugin manifest')
  if (plugin?.name !== integration.codex.plugin || plugin?.version !== project.version) {
    throw new DeveloperKitError('PACKAGE_IDENTITY_MISMATCH', 'The Codex plugin identity differs from the component id or project version.')
  }

  const marketplace = await readBoundedJson(join(root, ...marketplaceFile.split('/')), 'Codex marketplace manifest')
  const expectedPluginPath = `./${posix.relative(integration.codex.marketplaceRoot, integration.codex.pluginRoot)}`
  const matches = Array.isArray(marketplace?.plugins)
    ? marketplace.plugins.filter((entry) => entry?.name === integration.codex.plugin && entry?.source?.source === 'local' && entry?.source?.path === expectedPluginPath)
    : []
  if (marketplace?.name !== integration.codex.marketplace || matches.length !== 1) {
    throw new DeveloperKitError('PACKAGE_IDENTITY_MISMATCH', 'The marketplace does not contain exactly one matching local plugin entry.')
  }

  const sbom = await readBoundedJson(join(root, ...legal.sbom.split('/')), 'SPDX SBOM')
  if (sbom?.spdxVersion !== 'SPDX-2.3' || sbom?.dataLicense !== 'CC0-1.0' || !Array.isArray(sbom?.packages) || sbom.packages.length === 0) {
    throw new DeveloperKitError('PACKAGE_SBOM_INVALID', 'The staged SBOM must be a non-empty SPDX 2.3 JSON document.')
  }
  for (const path of Object.values(legal)) {
    const item = files.find((file) => file.path === path)
    if (item?.bytes === 0) throw new DeveloperKitError('PACKAGE_LEGAL_FILE_EMPTY', `The staged legal file is empty: ${path}`)
  }

  return {
    identityFiles: [...new Set([marketplaceFile, ...pluginIdentity, ...Object.values(legal)])].sort(),
    entrypoints: { mcp: command },
    legal,
  }
}

export async function archiveComponent(root, descriptorBytes, files, archivePath) {
  const pack = tarStream.pack()
  const gzip = createGzip({ level: 9, mtime: 0 })
  const output = createWriteStream(archivePath, { flags: 'wx', mode: 0o600 })
  const completion = pipeline(pack, gzip, output)
  const entries = [
    { path: 'component.json', bytes: descriptorBytes, mode: 0o644 },
    ...files.map((item) => ({ path: item.path, source: join(root, ...item.path.split('/')), mode: item.executable ? 0o755 : 0o644 })),
  ].sort((left, right) => left.path.localeCompare(right.path))

  try {
    for (const entry of entries) {
      if (entry.bytes !== undefined) {
        await new Promise((resolveEntry, reject) => {
          pack.entry({ name: entry.path, size: entry.bytes.length, mode: entry.mode, uid: 0, gid: 0, uname: 'root', gname: 'wheel', mtime: FIXED_TIME }, entry.bytes, (error) => error ? reject(error) : resolveEntry())
        })
      } else {
        const info = await stat(entry.source)
        await new Promise((resolveEntry, reject) => {
          const target = pack.entry({ name: entry.path, size: info.size, mode: entry.mode, uid: 0, gid: 0, uname: 'root', gname: 'wheel', mtime: FIXED_TIME }, (error) => error ? reject(error) : resolveEntry())
          createReadStream(entry.source).once('error', reject).pipe(target)
        })
      }
    }
    pack.finalize()
    await completion
  } catch (error) {
    pack.destroy(error)
    await completion.catch(() => {})
    throw error
  }
  const info = await stat(archivePath)
  if (info.size <= 0 || info.size > MAX_COMPONENT_ARCHIVE_BYTES) {
    throw new DeveloperKitError('PACKAGE_ARCHIVE_LIMIT_EXCEEDED', 'The component archive exceeds the fixed archive-byte limit.', {
      maximumBytes: MAX_COMPONENT_ARCHIVE_BYTES,
      actualBytes: info.size,
    })
  }
  return { bytes: info.size, sha256: await digestFile(archivePath) }
}

async function outputSnapshot(path) {
  const info = await state(path)
  if (info === null) return null
  if (info.isSymbolicLink() || !info.isFile()) throw new DeveloperKitError('PACKAGE_ARTIFACT_INVALID', 'The package artifact target must be one real file.')
  return { bytes: info.size, sha256: await digestFile(path) }
}

async function assertOutputStable(path, expected) {
  const current = await outputSnapshot(path)
  if (JSON.stringify(current) !== JSON.stringify(expected)) {
    throw new DeveloperKitError('PACKAGE_ARTIFACT_CHANGED', 'The package artifact target changed during the pack operation.')
  }
}

async function publishArchive(stagedArchive, output, initial, replace, temporaryRoot) {
  await assertOutputStable(output, initial)
  if (initial !== null && !replace) throw new DeveloperKitError('PACKAGE_ARTIFACT_EXISTS', 'The package artifact already exists; pass --replace to replace the exact observed file.')
  const backup = join(temporaryRoot, 'previous.tar.gz')
  let movedPrevious = false
  try {
    if (initial !== null) {
      await rename(output, backup)
      movedPrevious = true
    }
    await rename(stagedArchive, output)
  } catch (error) {
    if (movedPrevious && await state(output) === null && await state(backup) !== null) await rename(backup, output).catch(() => {})
    throw error
  }
  if (movedPrevious) await rm(backup, { force: true }).catch(() => {})
}

function summarizedChecks(result) {
  return {
    status: result.status,
    observationDirectory: result.observationDirectory,
    checks: result.checks.map(({ id, lane, status, reason, exitCode, durationMs }) => ({ id, lane, status, reason, exitCode, durationMs })),
  }
}

async function persistResult(outputRoot, result) {
  await writeFile(join(outputRoot, 'result.json'), `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 })
  return result
}

export async function packProject(rootInput, {
  declaredPath = PROJECT_FILE,
  deadlineMs = DEFAULT_CHECK_DEADLINE_MS,
  replace = false,
  signal,
} = {}) {
  const started = performance.now()
  const inputRoot = resolve(rootInput)
  const root = await requireDirectory(rootInput)
  const loaded = await loadProject(root, declaredPath)
  if (loaded.project.package === undefined) throw new DeveloperKitError('PACKAGE_NOT_DECLARED', 'The project does not declare a package operation.')
  const output = await outputTarget(root, loaded.project.package.artifact)
  const initialOutput = await outputSnapshot(output.target)
  if (initialOutput !== null && !replace) throw new DeveloperKitError('PACKAGE_ARTIFACT_EXISTS', 'The package artifact already exists; pass --replace to replace the exact observed file.')

  const runId = `${timestamp()}-pack`
  const observationRoot = join(root, '.verify', 'openadam-dev', runId)
  await mkdir(observationRoot, { recursive: true })
  const checkRemaining = Math.max(100, Math.floor(deadlineMs - (performance.now() - started)))
  const validation = await checkProject(root, { declaredPath, deadlineMs: checkRemaining, signal })
  if (validation.status !== 'ok') {
    return persistResult(observationRoot, {
      schemaVersion: 'openadam.developer-kit-pack.v0.1',
      status: 'error',
      project: { id: loaded.project.id, version: loaded.project.version },
      validation: summarizedChecks(validation),
      error: { code: 'PROJECT_CHECK_FAILED', message: 'Current project checks must pass before packaging.' },
      observationDirectory: relative(root, observationRoot),
      mutation: 'not-performed',
    })
  }

  const integration = validateIntegration(await readBoundedJson(join(root, ...loaded.project.package.integration.replaceAll('\\', '/').split('/')), 'Agent Host integration'), loaded.project.package.componentId)
  const temporaryRoot = await mkdtemp(join(observationRoot, '.pack-stage-'))
  const componentRoot = join(temporaryRoot, 'component')
  const stagedArchive = join(temporaryRoot, 'component.tar.gz')
  await mkdir(componentRoot)
  try {
    const remainingMs = Math.floor(deadlineMs - (performance.now() - started))
    if (remainingMs <= 0) throw new DeveloperKitError('PACKAGE_DEADLINE_EXCEEDED', 'The pack deadline expired before the package command could start.')
    const packageCommand = await runProjectCommand({
      command: loaded.project.package.command,
      cwd: root,
      logDirectory: join(observationRoot, 'package-command'),
      signal,
      remainingMs,
      environment: { OPENADAM_COMPONENT_STAGE: componentRoot },
    })
    if (packageCommand.status !== 'ok') {
      return persistResult(observationRoot, {
        schemaVersion: 'openadam.developer-kit-pack.v0.1',
        status: 'error',
        project: { id: loaded.project.id, version: loaded.project.version },
        validation: summarizedChecks(validation),
        packageCommand,
        error: { code: 'PACKAGE_COMMAND_FAILED', message: 'The declared package command did not complete successfully.' },
        observationDirectory: relative(root, observationRoot),
        mutation: 'not-performed',
      })
    }

    const files = await inventoryComponent(componentRoot, [root, inputRoot], temporaryRoot)
    const payload = await validatePayload(componentRoot, loaded.project, integration, files)
    const descriptor = {
      schemaVersion: COMPONENT_SCHEMA_VERSION,
      id: loaded.project.package.componentId,
      version: loaded.project.version,
      kind: 'agent-tool',
      files,
      identityFiles: payload.identityFiles,
      entrypoints: payload.entrypoints,
      integration,
      legal: payload.legal,
    }
    const descriptorBytes = Buffer.from(`${JSON.stringify(descriptor, null, 2)}\n`)
    await writeFile(join(componentRoot, 'component.json'), descriptorBytes, { mode: 0o644, flag: 'wx' })
    await utimes(join(componentRoot, 'component.json'), FIXED_TIME, FIXED_TIME)
    const archive = await archiveComponent(componentRoot, descriptorBytes, files, stagedArchive)
    const descriptorSha256 = `sha256:${createHash('sha256').update(descriptorBytes).digest('hex')}`
    await ensureOutputParent(root, output)
    await publishArchive(stagedArchive, output.target, initialOutput, replace, temporaryRoot)
    return persistResult(observationRoot, {
      schemaVersion: 'openadam.developer-kit-pack.v0.1',
      status: 'ok',
      project: { id: loaded.project.id, version: loaded.project.version },
      component: {
        id: descriptor.id,
        version: descriptor.version,
        files: files.length,
        expandedBytes: files.reduce((sum, item) => sum + item.bytes, 0),
        descriptorSha256,
      },
      artifact: { path: output.relative, format: 'tar.gz', ...archive },
      license: { spdx: loaded.project.package.legal.spdx, files: Object.values(payload.legal) },
      validation: summarizedChecks(validation),
      packageCommand,
      observationDirectory: relative(root, observationRoot),
      environment: { credentialsInherited: false, networkIsolation: 'not-enforced', filesystemIsolation: 'staged-output-only-not-enforced' },
      hostAdmission: 'not-performed',
      mutation: initialOutput === null ? 'created' : 'replaced',
    })
  } catch (error) {
    if (error instanceof DeveloperKitError) {
      const observationDirectory = relative(root, observationRoot)
      await persistResult(observationRoot, {
        schemaVersion: 'openadam.developer-kit-pack.v0.1',
        status: 'error',
        project: { id: loaded.project.id, version: loaded.project.version },
        error: publicError(error),
        observationDirectory,
        mutation: 'not-performed',
      })
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

export async function safePackProject(...args) {
  try {
    return await packProject(...args)
  } catch (error) {
    if (!(error instanceof DeveloperKitError)) throw error
    const observationDirectory = error.details?.observationDirectory
    return {
      schemaVersion: 'openadam.developer-kit-pack.v0.1',
      status: 'error',
      error: publicError(error),
      ...(typeof observationDirectory === 'string' ? { observationDirectory } : {}),
      mutation: 'not-performed',
    }
  }
}
