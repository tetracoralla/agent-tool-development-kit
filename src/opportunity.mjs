import { createHash } from 'node:crypto'
import { link, lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import Ajv2020 from 'ajv/dist/2020.js'
import addFormats from 'ajv-formats'
import { OPPORTUNITY_PROPOSAL_SCHEMA_VERSION } from './constants.mjs'
import { DeveloperKitError } from './errors.mjs'
import { readBoundedJson } from './json.mjs'
import { inspectMaterials } from './materials.mjs'
import { requireDirectory, requireRelativePath, resolveDeclaredFile } from './paths.mjs'

const schemaPath = fileURLToPath(new URL('../schemas/agent-tool-opportunity-proposal.schema.v0.1.json', import.meta.url))
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

function walkStrings(value, path = '') {
  if (typeof value === 'string') return [{ path: path || '/', value }]
  if (Array.isArray(value)) return value.flatMap((item, index) => walkStrings(item, `${path}/${index}`))
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, item]) => walkStrings(item, `${path}/${key}`))
  }
  return []
}

function referencedSourceIds(proposal) {
  return [
    ...proposal.observations.flatMap((item) => item.sourceIds),
    ...Object.values(proposal.observationCoverage).flatMap((item) => item.sourceIds),
    ...proposal.counterevidence.flatMap((item) => item.sourceIds),
  ]
}

export function validateOpportunityDocument(document, materialInspection) {
  if (!validate(document)) {
    throw new DeveloperKitError('OPPORTUNITY_PROPOSAL_SCHEMA_INVALID', 'The opportunity proposal does not match the current schema.', {
      schemaVersion: OPPORTUNITY_PROPOSAL_SCHEMA_VERSION,
      issues: validationIssues(),
    })
  }
  const placeholders = walkStrings(document).filter((item) => item.value.startsWith('TODO:')).slice(0, 16)
  if (placeholders.length > 0) {
    throw new DeveloperKitError('OPPORTUNITY_PROPOSAL_INCOMPLETE', 'The opportunity proposal still contains generated TODO placeholders.', {
      paths: placeholders.map((item) => item.path),
    })
  }
  if (document.materialSet.id !== materialInspection.materialSet.id
    || document.materialSet.digest !== materialInspection.materialSet.digest) {
    throw new DeveloperKitError('OPPORTUNITY_MATERIAL_DRIFT', 'The proposal is not bound to the current authorized material set.', {
      expectedId: materialInspection.materialSet.id,
      expectedDigest: materialInspection.materialSet.digest,
    })
  }
  const observationIds = document.observations.map((item) => item.id)
  if (new Set(observationIds).size !== observationIds.length) {
    throw new DeveloperKitError('OPPORTUNITY_PROPOSAL_CONTRADICTION', 'Opportunity observation ids must be unique.')
  }
  const available = new Set(materialInspection.sources.map((source) => source.id))
  const unknown = [...new Set(referencedSourceIds(document))].filter((id) => !available.has(id)).sort()
  if (unknown.length > 0) {
    throw new DeveloperKitError('OPPORTUNITY_SOURCE_UNKNOWN', 'The proposal references a source outside the current authorized material set.', { sourceIds: unknown })
  }
  for (const observation of document.observations) {
    if (observation.kind !== 'unknown' && observation.sourceIds.length === 0) {
      throw new DeveloperKitError('OPPORTUNITY_SOURCE_REQUIRED', `Observation ${observation.id} needs at least one current authorized source reference.`)
    }
  }
  for (const [question, coverage] of Object.entries(document.observationCoverage)) {
    if (['observed', 'partial'].includes(coverage.status) && coverage.sourceIds.length === 0) {
      throw new DeveloperKitError('OPPORTUNITY_SOURCE_REQUIRED', `Coverage item ${question} needs at least one current authorized source reference.`)
    }
  }
  for (const item of document.counterevidence) {
    if (['contradiction', 'counterexample'].includes(item.kind) && item.sourceIds.length === 0) {
      throw new DeveloperKitError('OPPORTUNITY_SOURCE_REQUIRED', `${item.kind} counterevidence needs at least one current authorized source reference.`)
    }
  }
  return document
}

function template(materialInspection) {
  const sourceId = materialInspection.sources[0].id
  const coverage = Object.fromEntries([
    'toolInvocation', 'runtimeOutcome', 'tokenOrContextCost', 'skillActivation',
    'nonUseReason', 'semanticEffect', 'resultAdoption',
  ].map((name) => [name, { status: 'unknown', basis: `TODO: State what the selected materials can and cannot establish about ${name}.`, sourceIds: [] }]))
  return {
    schemaVersion: OPPORTUNITY_PROPOSAL_SCHEMA_VERSION,
    materialSet: { id: materialInspection.materialSet.id, digest: materialInspection.materialSet.digest },
    candidateTask: {
      userJob: 'TODO: State one independently useful user job.',
      expectedOutcome: 'TODO: State the task-native artifact or system state the user expects.',
      currentWorkaround: 'TODO: Describe the current route and its actual friction.',
    },
    observations: [{
      id: 'observation-1',
      kind: 'observation',
      sourceIds: [sourceId],
      statement: 'TODO: Record one bounded task-native observation, not a recommendation.',
      limits: ['TODO: State sampling, freshness, authority, redaction, or missing-source limits.'],
    }],
    observationCoverage: coverage,
    counterevidence: [{
      kind: 'coverage-limit',
      sourceIds: [sourceId],
      statement: 'TODO: Record a contradiction, counterexample, coverage limit, or that none was found within the selected scope.',
    }],
    alternatives: [{
      kind: 'other',
      description: 'TODO: Describe one simpler existing-tool, Skill, repository-helper, Capability, Procedure, or other route.',
      tradeoff: 'TODO: State why the alternative may be sufficient or insufficient.',
    }],
    productBoundary: {
      deterministicKernel: 'TODO: State the stable operation, or say why no deterministic kernel is justified.',
      agentOrUserJudgment: 'TODO: State the intent, interpretation, quality, privacy, value, and acceptance work that stays with the Agent or user.',
      inputs: ['TODO: List one bounded input.'],
      outputs: ['TODO: List one bounded output.'],
      effects: ['TODO: State read-only or list one explicit effect.'],
      permissionsAndPrivacy: ['TODO: State one permission, disclosure, credential, or privacy boundary.'],
      limitsAndRecovery: ['TODO: State one limit, cancellation, cleanup, or recovery behavior.'],
      stableErrors: ['TODO: State one stable failure the product would own.'],
      humanAcceptance: 'TODO: State what remains a human acceptance decision.',
    },
    layerHypothesis: {
      kind: 'undecided',
      rationale: 'TODO: The developer or selected Agent explains the current layer hypothesis without treating it as approval.',
      carriers: [],
    },
    validationPlan: {
      smallestPilot: 'TODO: State the smallest falsifiable end-to-end pilot.',
      negativeAndBoundaryCases: ['TODO: Name one negative or boundary case.'],
      packageAndIsolatedProbe: 'TODO: State how immutable packaging and isolated Host admission will be checked if a tool is built.',
      performanceAndContext: 'TODO: State the cold, warm, load, resource, and Agent-context measurements relevant to this task.',
      freshAgent: 'TODO: State the fresh unnamed-task comparison needed for any discovery, adoption, or quality claim.',
    },
    unknowns: ['TODO: Preserve at least one consequential unknown.'],
  }
}

async function outputTarget(root, declaredPath) {
  const safe = requireRelativePath(declaredPath, 'opportunity proposal output')
  if (!safe.endsWith('.json')) throw new DeveloperKitError('OPPORTUNITY_OUTPUT_INVALID', 'The opportunity proposal output must be one .json file.')
  const parts = safe.replaceAll('\\', '/').split('/').filter((part) => part !== '' && part !== '.')
  const target = join(root, ...parts)
  let current = root
  for (const part of parts.slice(0, -1)) {
    current = join(current, part)
    try {
      const info = await lstat(current)
      if (info.isSymbolicLink()) throw new DeveloperKitError('PATH_SYMLINK_REJECTED', 'The opportunity output parent may not contain a symbolic link.')
      if (!info.isDirectory()) throw new DeveloperKitError('OPPORTUNITY_OUTPUT_INVALID', 'The opportunity output parent contains a non-directory entry.')
    } catch (error) {
      if (error?.code === 'ENOENT') break
      throw error
    }
  }
  try {
    const info = await lstat(target)
    if (info.isSymbolicLink() || !info.isFile()) throw new DeveloperKitError('OPPORTUNITY_OUTPUT_INVALID', 'The opportunity output target is not one real file.')
    throw new DeveloperKitError('OPPORTUNITY_OUTPUT_EXISTS', 'The opportunity output already exists; choose a new path to preserve the existing working note.')
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  return { safe, target }
}

export async function initOpportunity(rootInput, manifestPath, outputPath, { dryRun = false } = {}) {
  const root = await requireDirectory(rootInput)
  const materials = await inspectMaterials(root, manifestPath)
  const output = await outputTarget(root, outputPath)
  const document = template(materials)
  const bytes = Buffer.from(`${JSON.stringify(document, null, 2)}\n`)
  if (!dryRun) {
    await mkdir(dirname(output.target), { recursive: true })
    const staged = `${output.target}.openadam-dev-${process.pid}-${Date.now()}`
    try {
      await writeFile(staged, bytes, { flag: 'wx', mode: 0o600 })
      await link(staged, output.target)
      await rm(staged, { force: true })
    } catch (error) {
      await rm(staged, { force: true }).catch(() => {})
      throw error
    }
  }
  return {
    schemaVersion: 'openadam.developer-kit-opportunity-init.v0.1',
    status: dryRun ? 'planned' : 'created',
    materialSet: { id: materials.materialSet.id, digest: materials.materialSet.digest, sources: materials.materialSet.sources },
    proposal: { path: output.safe, bytes: bytes.length, schemaVersion: OPPORTUNITY_PROPOSAL_SCHEMA_VERSION },
    mutation: dryRun ? 'none' : 'created',
    nextAction: 'Have the user-selected Agent analyze only the authorized sources, replace every TODO, then run opportunity check. The generated draft is not a recommendation or approval.',
  }
}

export async function checkOpportunity(rootInput, manifestPath, proposalPath) {
  const root = await requireDirectory(rootInput)
  const materials = await inspectMaterials(root, manifestPath)
  const path = await resolveDeclaredFile(root, proposalPath, 'opportunity proposal')
  const proposal = validateOpportunityDocument(await readBoundedJson(path, 'opportunity proposal'), materials)
  const sourceRefs = new Set(referencedSourceIds(proposal))
  return {
    schemaVersion: 'openadam.developer-kit-opportunity-check.v0.1',
    status: 'ok',
    materialSet: { id: materials.materialSet.id, digest: materials.materialSet.digest, current: true },
    proposal: {
      path: relative(root, path).split(sep).join('/'),
      sha256: createHash('sha256').update(JSON.stringify(proposal)).digest('hex'),
      candidateRecorded: true,
      layerHypothesis: proposal.layerHypothesis.kind,
      observations: proposal.observations.length,
      referencedSources: sourceRefs.size,
      counterevidence: proposal.counterevidence.length,
      alternatives: proposal.alternatives.length,
      unknowns: proposal.unknowns.length,
    },
    checks: [
      { id: 'closed-schema', status: 'ok' },
      { id: 'current-material-binding', status: 'ok' },
      { id: 'source-reference-boundary', status: 'ok' },
      { id: 'counterevidence-present', status: 'ok' },
      { id: 'simpler-alternative-present', status: 'ok' },
      { id: 'unknowns-preserved', status: 'ok' },
    ],
    assessmentBoundary: 'This check validates a caller-authored proposal against the current bounded material set. It does not recommend a layer, rank a candidate, approve development, establish product value, or authorize publication.',
  }
}

export function opportunityProposalSchema() {
  return structuredClone(schema)
}
