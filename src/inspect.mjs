import { lstat, readFile, readdir } from 'node:fs/promises'
import { basename, join, relative } from 'node:path'
import { PROJECT_FILE, MAX_DISCOVERED_FILES, MAX_WALK_DEPTH, MAX_WALK_ENTRIES } from './constants.mjs'
import { loadProject } from './contracts.mjs'
import { DeveloperKitError, publicError } from './errors.mjs'
import { requireDirectory } from './paths.mjs'
import { probeCommand } from './process.mjs'

const ignoredDirectories = new Set([
  '.git', '.verify', '.venv', '__pycache__', 'node_modules', 'dist', 'build',
  'coverage', '.next', '.cache', 'target', 'vendor',
])
const exactNames = new Set([
  'AGENTS.md', 'PRODUCT_MODEL.md', 'REVIEW_CONTRACT.md', 'SKILL.md', 'package.json',
  'pyproject.toml', 'Cargo.toml', 'provider.json', 'implementation-manifest.json',
  'plugin.json', '.mcp.json', PROJECT_FILE,
])

function interesting(name) {
  return exactNames.has(name) || name.endsWith('.schema.json')
}

async function discover(root) {
  const files = []
  let entriesSeen = 0
  let skippedLinks = 0
  let truncated = false

  async function walk(directory, depth) {
    if (depth > MAX_WALK_DEPTH || truncated) return
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      entriesSeen += 1
      if (entriesSeen > MAX_WALK_ENTRIES) {
        truncated = true
        return
      }
      const path = join(directory, entry.name)
      if (entry.isSymbolicLink()) {
        skippedLinks += 1
        continue
      }
      if (entry.isDirectory()) {
        if (!ignoredDirectories.has(entry.name)) await walk(path, depth + 1)
        continue
      }
      if (entry.isFile() && interesting(entry.name) && files.length < MAX_DISCOVERED_FILES) {
        files.push(relative(root, path))
      } else if (entry.isFile() && interesting(entry.name)) {
        truncated = true
      }
    }
  }

  await walk(root, 0)
  return { files, entriesSeen: Math.min(entriesSeen, MAX_WALK_ENTRIES), skippedLinks, truncated }
}

async function packageObservation(root, path, kind) {
  try {
    const info = await lstat(join(root, path))
    if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) return null
    if (kind === 'node') {
      const value = JSON.parse(await readFile(join(root, path), 'utf8'))
      return { kind, path, name: typeof value.name === 'string' ? value.name.slice(0, 160) : null, version: typeof value.version === 'string' ? value.version.slice(0, 80) : null }
    }
    const text = await readFile(join(root, path), 'utf8')
    const name = text.match(/^name\s*=\s*["']([^"']+)["']/mu)?.[1] ?? null
    const version = text.match(/^version\s*=\s*["']([^"']+)["']/mu)?.[1] ?? null
    return { kind, path, name, version }
  } catch {
    return null
  }
}

async function gitObservation(root) {
  const inside = await probeCommand('git', ['rev-parse', '--is-inside-work-tree'], { cwd: root })
  if (!inside.available || inside.detail !== 'true') return { repository: false }
  const [branch, head, status] = await Promise.all([
    probeCommand('git', ['branch', '--show-current'], { cwd: root }),
    probeCommand('git', ['rev-parse', '--short=12', 'HEAD'], { cwd: root }),
    probeCommand('git', ['status', '--porcelain=v1'], { cwd: root }),
  ])
  return {
    repository: true,
    branch: branch.available ? branch.detail || null : null,
    head: head.available ? head.detail || null : null,
    dirty: status.available ? status.detail !== '' : null,
  }
}

export async function inspectProject(rootInput) {
  const root = await requireDirectory(rootInput)
  const discovery = await discover(root)
  const packageFiles = await Promise.all([
    packageObservation(root, 'package.json', 'node'),
    packageObservation(root, 'pyproject.toml', 'python'),
    packageObservation(root, 'Cargo.toml', 'rust'),
  ])
  let declaration = { present: false }
  if (discovery.files.includes(PROJECT_FILE)) {
    try {
      const loaded = await loadProject(root, PROJECT_FILE)
      declaration = {
        present: true,
        status: 'valid',
        schemaVersion: loaded.project.schemaVersion,
        id: loaded.project.id,
        version: loaded.project.version,
      }
    } catch (error) {
      if (!(error instanceof DeveloperKitError)) throw error
      declaration = { present: true, status: 'invalid', error: publicError(error) }
    }
  }
  return {
    schemaVersion: 'openadam.developer-kit-inspection.v0.1',
    status: 'ok',
    root: basename(root),
    git: await gitObservation(root),
    projectDeclaration: declaration,
    packages: packageFiles.filter((item) => item !== null),
    discovery,
  }
}
