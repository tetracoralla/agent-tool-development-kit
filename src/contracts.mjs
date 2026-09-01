import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { PROJECT_FILE, PROJECT_SCHEMA_VERSION } from './constants.mjs'
import { DeveloperKitError } from './errors.mjs'
import { readBoundedJson } from './json.mjs'
import { requireDirectory, requireRelativePath, resolveDeclaredFile } from './paths.mjs'

const schemaPath = fileURLToPath(new URL('../schemas/agent-tool-project.schema.v0.1.json', import.meta.url))
const schema = JSON.parse(await readFile(schemaPath, 'utf8'))
const ajv = new Ajv2020({ allErrors: true, strict: true })
addFormats(ajv)
const validate = ajv.compile(schema)

function validationIssues() {
  return (validate.errors ?? []).slice(0, 32).map((error) => ({
    path: error.instancePath === '' ? '/' : error.instancePath,
    keyword: error.keyword,
    message: error.message ?? 'validation failed',
  }))
}

function requireUnique(values, label) {
  if (new Set(values).size !== values.length) {
    throw new DeveloperKitError('PROJECT_CONTRADICTION', `${label} must be unique.`)
  }
}

function inspectJsonValue(value, label) {
  let nodes = 0
  function walk(current, depth) {
    nodes += 1
    if (nodes > 4096 || depth > 16) throw new DeveloperKitError('PROJECT_CONTRADICTION', `${label} exceeds the structural probe-input limit.`)
    if (Array.isArray(current)) for (const item of current) walk(item, depth + 1)
    else if (current !== null && typeof current === 'object') for (const item of Object.values(current)) walk(item, depth + 1)
  }
  walk(value, 0)
  if (Buffer.byteLength(JSON.stringify(value)) > 64 * 1024) {
    throw new DeveloperKitError('PROJECT_CONTRADICTION', `${label} exceeds the 65536-byte serialized probe-input limit.`)
  }
}

export function validateProjectDocument(document) {
  if (!validate(document)) {
    throw new DeveloperKitError('PROJECT_SCHEMA_INVALID', 'The project declaration does not match the current schema.', {
      schemaVersion: PROJECT_SCHEMA_VERSION,
      issues: validationIssues(),
    })
  }
  requireUnique(document.checks.map((check) => check.id), 'check ids')
  requireUnique(document.carriers.map((carrier) => `${carrier.kind}:${carrier.path}`), 'carrier kind and path pairs')

  requireRelativePath(document.documents.productModel, 'product model path')
  requireRelativePath(document.documents.reviewContract, 'review contract path')
  for (const carrier of document.carriers) requireRelativePath(carrier.path, `${carrier.kind} carrier path`)
  if (document.contracts?.capabilityProviderManifest !== undefined) {
    requireRelativePath(document.contracts.capabilityProviderManifest, 'Capability provider manifest path')
    if (!document.checks.some((check) => check.lane === 'capability-conformance')) {
      throw new DeveloperKitError('PROJECT_CONTRADICTION', 'A declared Capability provider manifest requires a capability-conformance check lane.')
    }
  }
  if (document.contracts?.procedureImplementationManifest !== undefined) {
    requireRelativePath(document.contracts.procedureImplementationManifest, 'Procedure implementation manifest path')
    if (!document.checks.some((check) => check.lane === 'procedure-conformance')) {
      throw new DeveloperKitError('PROJECT_CONTRADICTION', 'A declared Procedure implementation manifest requires a procedure-conformance check lane.')
    }
  }
  if (document.package !== undefined) {
    requireRelativePath(document.package.artifact, 'package artifact path')
    requireRelativePath(document.package.integration, 'package integration path')
    for (const [name, path] of Object.entries(document.package.legal).filter(([key]) => key !== 'spdx')) {
      requireRelativePath(path, `package legal ${name} path`)
    }
    requireUnique(Object.entries(document.package.legal).filter(([key]) => key !== 'spdx').map(([, path]) => path), 'package legal file paths')
    requireUnique(document.package.probes.map((probe) => probe.id), 'runtime probe ids')
    if (!document.package.probes.some((probe) => probe.expectation === 'success')
      || !document.package.probes.some((probe) => probe.expectation !== 'success')) {
      throw new DeveloperKitError('PROJECT_CONTRADICTION', 'Runtime probes must include at least one expected success and one expected error.')
    }
    for (const probe of document.package.probes) inspectJsonValue(probe.arguments, `runtime probe ${probe.id} arguments`)
  }
  return document
}

export async function loadProject(root, declaredPath = PROJECT_FILE, { bindFiles = true } = {}) {
  const rootReal = await requireDirectory(root)
  const path = await resolveDeclaredFile(rootReal, declaredPath, 'project declaration')
  const project = validateProjectDocument(await readBoundedJson(path, 'project declaration'))
  if (bindFiles) {
    await resolveDeclaredFile(rootReal, project.documents.productModel, 'product model')
    await resolveDeclaredFile(rootReal, project.documents.reviewContract, 'review contract')
    for (const carrier of project.carriers) {
      await resolveDeclaredFile(rootReal, carrier.path, `${carrier.kind} carrier`)
    }
    if (project.contracts?.capabilityProviderManifest !== undefined) {
      await resolveDeclaredFile(rootReal, project.contracts.capabilityProviderManifest, 'Capability provider manifest')
    }
    if (project.contracts?.procedureImplementationManifest !== undefined) {
      await resolveDeclaredFile(rootReal, project.contracts.procedureImplementationManifest, 'Procedure implementation manifest')
    }
    if (project.package !== undefined) {
      await resolveDeclaredFile(rootReal, project.package.integration, 'Agent Host integration')
    }
  }
  return { root: rootReal, path, project }
}

export function projectSchema() {
  return structuredClone(schema)
}
