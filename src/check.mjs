import { lstat, mkdir, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { loadProject } from './contracts.mjs'
import { DEFAULT_CHECK_DEADLINE_MS, PROJECT_FILE } from './constants.mjs'
import { DeveloperKitError, publicError } from './errors.mjs'
import { requireDirectory } from './paths.mjs'
import { runProjectCommand } from './runner.mjs'
import { loadToolIntegration } from './tool-integration.mjs'

function timestamp() {
  return new Date().toISOString().replaceAll(':', '').replaceAll('.', '-')
}

async function exists(path) {
  try {
    return await lstat(path)
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

export async function checkProject(rootInput, {
  declaredPath = PROJECT_FILE,
  deadlineMs = DEFAULT_CHECK_DEADLINE_MS,
  signal,
} = {}) {
  const root = await requireDirectory(rootInput)
  const loaded = await loadProject(root, declaredPath)
  const runId = timestamp()
  const outputRoot = join(root, '.verify', 'openadam-dev', runId)
  await mkdir(outputRoot, { recursive: true })

  let initialIntegration
  if (loaded.project.package !== undefined) {
    try {
      initialIntegration = await loadToolIntegration(root, loaded.project.package)
    } catch (error) {
      if (!(error instanceof DeveloperKitError)) throw error
      const result = {
        schemaVersion: 'openadam.developer-kit-check.v0.1',
        status: 'error',
        project: { id: loaded.project.id, version: loaded.project.version },
        checks: [],
        error: publicError(error),
        observationDirectory: relative(root, outputRoot),
        environment: { credentialsInherited: false, networkIsolation: 'not-enforced' },
      }
      await writeFile(join(outputRoot, 'result.json'), `${JSON.stringify(result, null, 2)}\n`)
      return result
    }
  }

  const scaffoldMarker = await exists(join(root, '.openadam-scaffold'))
  if (scaffoldMarker !== null) {
    const result = {
      schemaVersion: 'openadam.developer-kit-check.v0.1',
      status: 'error',
      project: { id: loaded.project.id, version: loaded.project.version },
      checks: [],
      error: {
        code: 'SCAFFOLD_INCOMPLETE',
        message: 'The generated scaffold marker must be removed only after product-specific implementation and tests are complete.',
      },
      observationDirectory: relative(root, outputRoot),
      environment: { credentialsInherited: false, networkIsolation: 'not-enforced' },
    }
    await writeFile(join(outputRoot, 'result.json'), `${JSON.stringify(result, null, 2)}\n`)
    return result
  }

  const controller = new AbortController()
  const forwardAbort = () => controller.abort(signal?.reason)
  signal?.addEventListener('abort', forwardAbort, { once: true })
  const started = performance.now()
  const checks = []
  try {
    for (const check of loaded.project.checks) {
      if (controller.signal.aborted) break
      const elapsed = performance.now() - started
      const remainingMs = Math.floor(deadlineMs - elapsed)
      if (remainingMs <= 0) {
        checks.push({ id: check.id, lane: check.lane, status: 'error', reason: 'whole-call-timeout', exitCode: null, durationMs: 0 })
        break
      }
      const result = await runProjectCommand({
        command: check.command,
        cwd: root,
        logDirectory: join(outputRoot, check.id),
        signal: controller.signal,
        remainingMs,
      })
      checks.push({ id: check.id, lane: check.lane, ...result })
      if (result.status !== 'ok') break
    }
  } finally {
    signal?.removeEventListener('abort', forwardAbort)
  }

  let integrationError = null
  if (initialIntegration !== undefined) {
    try {
      await loadToolIntegration(root, loaded.project.package, { expected: initialIntegration })
    } catch (error) {
      if (!(error instanceof DeveloperKitError)) throw error
      integrationError = publicError(error)
    }
  }

  const result = {
    schemaVersion: 'openadam.developer-kit-check.v0.1',
    status: integrationError === null && checks.length === loaded.project.checks.length && checks.every((check) => check.status === 'ok') ? 'ok' : 'error',
    project: { id: loaded.project.id, version: loaded.project.version },
    checks,
    ...(integrationError === null ? {} : { error: integrationError }),
    observationDirectory: relative(root, outputRoot),
    environment: { credentialsInherited: false, networkIsolation: 'not-enforced' },
  }
  await writeFile(join(outputRoot, 'result.json'), `${JSON.stringify(result, null, 2)}\n`)
  return result
}

export async function safeCheckProject(...args) {
  try {
    return await checkProject(...args)
  } catch (error) {
    if (!(error instanceof DeveloperKitError)) throw error
    return {
      schemaVersion: 'openadam.developer-kit-check.v0.1',
      status: 'error',
      checks: [],
      error: publicError(error),
    }
  }
}
