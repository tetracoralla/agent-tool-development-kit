import { join, posix } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import {
  MAX_COMPONENT_PATH_BYTES,
  TOOL_INTEGRATION_SCHEMA_VERSIONS,
} from './constants.mjs'
import { DeveloperKitError } from './errors.mjs'
import { readBoundedJson } from './json.mjs'

const TOOL_INTEGRATION_V3 = 'openadam.agent-host-tool-integration.v0.3'
const TOOL_INTEGRATION_V5 = 'openadam.agent-host-tool-integration.v0.5'
const MAX_INTEGRATION_ARRAY_ITEMS = 128
const MAX_INTEGRATION_STRING_BYTES = 4096

function fail(message, details) {
  throw new DeveloperKitError('TOOL_INTEGRATION_INVALID', message, details)
}

function exactKeys(value, allowed, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be an object.`)
  }
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key))
  if (unexpected.length > 0) fail(`${label} contains unsupported fields.`, { fields: unexpected.slice(0, 32) })
}

function boundedString(value, label, maximum = MAX_INTEGRATION_STRING_BYTES) {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value) > maximum || /[\u0000\r\n]/u.test(value)) {
    fail(`${label} is invalid.`)
  }
  return value
}

function identifier(value, label) {
  boundedString(value, label)
  if (!/^[a-z][a-z0-9-]*$/u.test(value)) fail(`${label} must use lower-case hyphen-case.`)
  return value
}

export function componentPath(value, label) {
  boundedString(value, label, MAX_COMPONENT_PATH_BYTES)
  if (value.includes('\\') || value.startsWith('/') || /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(value)
    || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail(`${label} must be a contained POSIX relative path.`)
  }
  const normalized = posix.normalize(value)
  if (normalized !== value || normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
    fail(`${label} must be a canonical contained relative path.`)
  }
  return value
}

function stringArray(value, label, minimum = 0) {
  if (!Array.isArray(value) || value.length < minimum || value.length > MAX_INTEGRATION_ARRAY_ITEMS
    || value.some((item) => typeof item !== 'string' || item.length === 0 || Buffer.byteLength(item) > MAX_INTEGRATION_STRING_BYTES)
    || new Set(value).size !== value.length) {
    fail(`${label} is invalid.`)
  }
  return value
}

function requireInventoryPath(files, value, label) {
  const path = componentPath(value, label)
  if (!files.has(path)) fail(`${label} is absent from the component inventory.`, { path })
  return path
}

function requireInventoryDirectory(files, value, label) {
  const path = componentPath(value, label)
  if (![...files].some((file) => file === path || file.startsWith(`${path}/`))) {
    fail(`${label} is absent from the component inventory.`, { path })
  }
}

export function validateToolIntegration(value, {
  componentId,
  componentFiles,
} = {}) {
  const topLevelKeys = ['schemaVersion', 'displayName', 'summary', 'codex', 'runtime', 'ownership']
  if (value?.schemaVersion === TOOL_INTEGRATION_V3) topLevelKeys.push('discovery')
  exactKeys(value, topLevelKeys, 'tool integration')
  if (!TOOL_INTEGRATION_SCHEMA_VERSIONS.includes(value.schemaVersion)) {
    throw new DeveloperKitError('TOOL_INTEGRATION_UNSUPPORTED', `Only ${TOOL_INTEGRATION_SCHEMA_VERSIONS.join(', ')} is supported by this Developer Kit version.`)
  }
  boundedString(value.displayName, 'tool display name', 80)
  boundedString(value.summary, 'tool summary', 180)

  exactKeys(value.codex, ['marketplaceRoot', 'marketplace', 'pluginRoot', 'plugin', 'identityFiles'], 'Codex integration')
  const marketplaceRoot = componentPath(value.codex.marketplaceRoot, 'Codex marketplace root')
  const pluginRoot = componentPath(value.codex.pluginRoot, 'Codex plugin root')
  identifier(value.codex.marketplace, 'Codex marketplace id')
  identifier(value.codex.plugin, 'Codex plugin id')
  if (componentId !== undefined && value.codex.plugin !== componentId) {
    fail('The Codex plugin id must equal package.componentId.')
  }
  const identityFiles = stringArray(value.codex.identityFiles, 'Codex identity files', 2)
    .map((path) => componentPath(path, 'Codex identity file'))

  const runtimeKeys = ['transport', 'executor', 'command', 'args', 'cwd', 'workspaceEnvironment', 'expectedTools', 'timeoutMs']
  if (value.schemaVersion === TOOL_INTEGRATION_V5) runtimeKeys.push('optionalPathEnvironment')
  exactKeys(value.runtime, runtimeKeys, 'runtime integration')
  if (value.runtime.transport !== 'mcp-stdio' || !['component', 'suite-node'].includes(value.runtime.executor)) {
    fail('The runtime must use MCP stdio and a component or suite-node executor.')
  }
  const command = componentPath(value.runtime.command, 'runtime command')
  const cwd = componentPath(value.runtime.cwd, 'runtime working directory')
  stringArray(value.runtime.args, 'runtime arguments')
  const workspaceEnvironment = stringArray(value.runtime.workspaceEnvironment, 'workspace environment')
  if (workspaceEnvironment.some((name) => !/^[A-Z][A-Z0-9_]*$/u.test(name))) {
    fail('Workspace environment names must use upper-case identifier syntax.')
  }
  const optionalPathEnvironment = value.schemaVersion === TOOL_INTEGRATION_V5
    ? stringArray(value.runtime.optionalPathEnvironment ?? [], 'optional path environment')
    : []
  if (optionalPathEnvironment.some((name) => !/^[A-Z][A-Z0-9_]*$/u.test(name))) {
    fail('Optional path environment names must use upper-case identifier syntax.')
  }
  if (optionalPathEnvironment.some((name) => workspaceEnvironment.includes(name))) {
    fail('Workspace and optional path environment names must be distinct.')
  }
  stringArray(value.runtime.expectedTools, 'expected tools', 1)
  if (!Number.isSafeInteger(value.runtime.timeoutMs) || value.runtime.timeoutMs < 1000 || value.runtime.timeoutMs > 30000) {
    fail('The runtime timeout must be an integer from 1000 to 30000 milliseconds.')
  }

  let discovery = null
  if (value.schemaVersion === TOOL_INTEGRATION_V3) {
    exactKeys(value.discovery, ['kind', 'skill', 'runtime'], 'tool discovery')
    if (value.discovery.kind !== 'skill-cli') fail('Tool discovery kind is unsupported.')

    exactKeys(value.discovery.skill, ['id', 'root', 'identityFiles', 'launcher'], 'tool discovery Skill')
    const skillId = identifier(value.discovery.skill.id, 'tool discovery Skill id')
    const skillRoot = componentPath(value.discovery.skill.root, 'tool discovery Skill root')
    if (skillRoot !== `${pluginRoot}/skills/${skillId}`) {
      fail('Tool discovery Skill root must match the declared Codex plugin Skill.')
    }
    const skillIdentityFiles = stringArray(value.discovery.skill.identityFiles, 'tool discovery Skill identity files', 1)
      .map((path) => componentPath(path, 'tool discovery Skill identity file'))
    if (!skillIdentityFiles.includes('SKILL.md')) fail('Tool discovery Skill identity files must include SKILL.md.')
    const launcher = componentPath(value.discovery.skill.launcher, 'tool discovery Skill launcher')

    exactKeys(value.discovery.runtime, ['executor', 'command', 'args', 'versionArguments'], 'tool discovery runtime')
    if (!['component', 'suite-node'].includes(value.discovery.runtime.executor)) {
      fail('Tool discovery runtime executor is unsupported.')
    }
    const discoveryCommand = componentPath(value.discovery.runtime.command, 'tool discovery runtime command')
    stringArray(value.discovery.runtime.args, 'tool discovery runtime arguments')
    stringArray(value.discovery.runtime.versionArguments, 'tool discovery version arguments', 1)
    discovery = { skillRoot, skillIdentityFiles, launcher, discoveryCommand }
  }

  exactKeys(value.ownership, ['uninstall'], 'integration ownership')
  if (value.ownership.uninstall !== 'agent-host-created-only') {
    fail('The only supported uninstall ownership is agent-host-created-only.')
  }

  if (componentFiles !== undefined) {
    const files = componentFiles instanceof Set ? componentFiles : new Set(componentFiles)
    requireInventoryPath(files, command, 'runtime command')
    for (const path of identityFiles) {
      requireInventoryPath(files, `${pluginRoot}/${path}`, 'Codex plugin identity file')
    }
    requireInventoryDirectory(files, marketplaceRoot, 'Codex marketplace root')
    requireInventoryDirectory(files, pluginRoot, 'Codex plugin root')
    requireInventoryDirectory(files, cwd, 'runtime working directory')
    if (discovery !== null) {
      requireInventoryPath(files, discovery.discoveryCommand, 'tool discovery runtime command')
      for (const path of discovery.skillIdentityFiles) {
        requireInventoryPath(files, `${discovery.skillRoot}/${path}`, 'tool discovery Skill identity file')
      }
      requireInventoryDirectory(files, discovery.skillRoot, 'tool discovery Skill root')
      const launcherPath = `${discovery.skillRoot}/${discovery.launcher}`
      if (files.has(launcherPath) || [...files].some((path) => path.startsWith(`${launcherPath}/`))) {
        fail(`Tool discovery launcher is Host-owned and must be absent from provider bytes: ${launcherPath}`)
      }
    }
  }
  return value
}

export async function loadToolIntegration(root, packageDefinition, { expected } = {}) {
  const value = await readBoundedJson(
    join(root, ...packageDefinition.integration.replaceAll('\\', '/').split('/')),
    'Agent Host integration',
  )
  if (expected !== undefined && !isDeepStrictEqual(value, expected)) {
    throw new DeveloperKitError('TOOL_INTEGRATION_DRIFT', 'The Agent Host integration changed during the current operation.')
  }
  return validateToolIntegration(value, { componentId: packageDefinition.componentId })
}
