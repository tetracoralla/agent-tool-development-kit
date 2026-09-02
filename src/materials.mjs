import { constants as fsConstants, open, readFile, lstat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import {
  MATERIAL_SET_SCHEMA_VERSION,
  MAX_MATERIAL_FILE_BYTES,
  MAX_MATERIAL_FILES,
  MAX_MATERIAL_TOTAL_BYTES,
} from './constants.mjs'
import { DeveloperKitError } from './errors.mjs'
import { readBoundedJson } from './json.mjs'
import { requireDirectory, requireRelativePath, resolveDeclaredDirectory, resolveDeclaredFile } from './paths.mjs'

const schemaPath = fileURLToPath(new URL('../schemas/authorized-material-set.schema.v0.1.json', import.meta.url))
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

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
  }
  return value
}

function digest(value) {
  return `sha256:${createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex')}`
}

function portablePath(root, path) {
  return relative(root, path).split(sep).join('/') || '.'
}

function validateReference(value) {
  if (/[\u0000-\u001f\u007f]/u.test(value)) {
    throw new DeveloperKitError('MATERIAL_REFERENCE_INVALID', 'A material reference contains control characters.')
  }
  const scheme = value.match(/^([A-Za-z][A-Za-z0-9+.-]*):/u)?.[1]?.toLowerCase()
  if (scheme === undefined || ['file', 'data', 'javascript'].includes(scheme)) {
    throw new DeveloperKitError('MATERIAL_REFERENCE_INVALID', 'A reference must use a non-file external or Agent-host reference scheme.')
  }
  if (scheme === 'http' || scheme === 'https') {
    let parsed
    try {
      parsed = new URL(value)
    } catch {
      throw new DeveloperKitError('MATERIAL_REFERENCE_INVALID', 'A web material reference is not a valid URL.')
    }
    if (parsed.username !== '' || parsed.password !== '') {
      throw new DeveloperKitError('MATERIAL_REFERENCE_INVALID', 'A material reference may not embed credentials.')
    }
  }
  return value
}

async function observeFile(workspaceRoot, path, state) {
  if (state.files >= MAX_MATERIAL_FILES) {
    throw new DeveloperKitError('MATERIAL_FILE_LIMIT_EXCEEDED', `The selected material set exceeds ${MAX_MATERIAL_FILES} exact files.`)
  }
  const flags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0)
  const handle = await open(path, flags)
  try {
    const before = await handle.stat({ bigint: true })
    if (!before.isFile()) throw new DeveloperKitError('MATERIAL_FILE_INVALID', 'A selected material path is not one regular file.')
    if (before.size > BigInt(MAX_MATERIAL_FILE_BYTES)) {
      throw new DeveloperKitError('MATERIAL_FILE_LIMIT_EXCEEDED', `A selected material file exceeds ${MAX_MATERIAL_FILE_BYTES} bytes.`, {
        path: portablePath(workspaceRoot, path),
        bytes: Number(before.size),
        limitBytes: MAX_MATERIAL_FILE_BYTES,
      })
    }
    const bytes = await handle.readFile()
    const after = await handle.stat({ bigint: true })
    const current = await lstat(path, { bigint: true })
    if (!current.isFile() || current.isSymbolicLink()
      || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs
      || before.dev !== current.dev || before.ino !== current.ino || before.size !== current.size || before.mtimeNs !== current.mtimeNs) {
      throw new DeveloperKitError('MATERIAL_SOURCE_CHANGED', 'A selected material file changed while it was being inspected.')
    }
    if (state.bytes + bytes.length > MAX_MATERIAL_TOTAL_BYTES) {
      throw new DeveloperKitError('MATERIAL_TOTAL_LIMIT_EXCEEDED', `The selected material set exceeds ${MAX_MATERIAL_TOTAL_BYTES} bytes.`)
    }
    state.files += 1
    state.bytes += bytes.length
    return {
      path: portablePath(workspaceRoot, path),
      bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    }
  } finally {
    await handle.close()
  }
}

export function validateMaterialSetDocument(document) {
  if (!validate(document)) {
    throw new DeveloperKitError('MATERIAL_SET_SCHEMA_INVALID', 'The authorized material set does not match the current schema.', {
      schemaVersion: MATERIAL_SET_SCHEMA_VERSION,
      issues: validationIssues(),
    })
  }
  const ids = document.sources.map((source) => source.id)
  if (new Set(ids).size !== ids.length) throw new DeveloperKitError('MATERIAL_SET_CONTRADICTION', 'Material source ids must be unique.')
  for (const source of document.sources) {
    if (source.location.type === 'local-file') requireRelativePath(source.location.path, `material source ${source.id} path`)
    if (source.location.type === 'local-selection') {
      requireRelativePath(source.location.root, `material source ${source.id} root`)
      for (const path of source.location.files) requireRelativePath(path, `material source ${source.id} selected file`)
    }
    if (source.location.type === 'reference') validateReference(source.location.reference)
  }
  return document
}

export async function inspectMaterials(rootInput, manifestPath = 'authorized-materials.json') {
  const root = await requireDirectory(rootInput)
  const path = await resolveDeclaredFile(root, manifestPath, 'authorized material manifest')
  const document = validateMaterialSetDocument(await readBoundedJson(path, 'authorized material manifest'))
  const state = { files: 0, bytes: 0 }
  const seenFiles = new Set()
  const seenReferences = new Set()
  const sources = []

  for (const source of document.sources) {
    if (source.location.type === 'reference') {
      if (seenReferences.has(source.location.reference)) {
        throw new DeveloperKitError('MATERIAL_SET_CONTRADICTION', 'The material set repeats an external reference.', { sourceId: source.id })
      }
      seenReferences.add(source.location.reference)
      sources.push({
        id: source.id,
        role: source.role,
        title: source.title,
        locationType: 'reference',
        reference: source.location.reference,
        contentStatus: 'not-inspected-reference',
      })
      continue
    }

    const paths = []
    if (source.location.type === 'local-file') {
      paths.push(await resolveDeclaredFile(root, source.location.path, `material source ${source.id}`))
    } else {
      const selectedRoot = await resolveDeclaredDirectory(root, source.location.root, `material source ${source.id} root`)
      for (const selected of source.location.files) {
        paths.push(await resolveDeclaredFile(selectedRoot, selected, `material source ${source.id} selected file`))
      }
    }

    const files = []
    for (const selected of paths) {
      const key = portablePath(root, selected)
      if (seenFiles.has(key)) throw new DeveloperKitError('MATERIAL_SET_CONTRADICTION', 'The material set repeats a selected local file.', { path: key })
      seenFiles.add(key)
      files.push(await observeFile(root, selected, state))
    }
    sources.push({
      id: source.id,
      role: source.role,
      title: source.title,
      locationType: source.location.type,
      contentStatus: 'selected-local-files-digested',
      files,
    })
  }

  const manifestDigest = digest(document)
  const materialDigest = digest({ manifestDigest, sources })
  return {
    schemaVersion: 'openadam.developer-kit-material-inspection.v0.1',
    status: 'ok',
    materialSet: {
      id: document.id,
      title: document.title,
      intendedProcessing: document.intendedProcessing,
      manifest: { path: portablePath(root, path), digest: manifestDigest },
      digest: materialDigest,
      sources: sources.length,
      selectedFiles: state.files,
      selectedBytes: state.bytes,
    },
    sources,
    processing: {
      rawContentReturned: false,
      referencesFetched: false,
      directoryCrawling: false,
      semanticAnalysis: 'not-performed',
    },
    assessmentBoundary: 'This result binds the caller-selected material identities and local file bytes. It does not establish authorization, truth, task meaning, opportunity, layer choice, quality, value, or approval.',
  }
}

export function materialSetSchema() {
  return structuredClone(schema)
}
