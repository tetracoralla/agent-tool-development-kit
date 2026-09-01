import { createHash } from 'node:crypto'
import { access, chmod, cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { archiveComponent, inventoryComponent } from '../src/pack.mjs'

const repositoryRoot = fileURLToPath(new URL('../', import.meta.url))
const packageDocument = JSON.parse(await readFile(join(repositoryRoot, 'package.json'), 'utf8'))
const VERSION = packageDocument.version
const COMPONENT_ID = 'agent-tool-development-kit'
const SKILL_ID = 'build-openadam-agent-tools'
const MARKETPLACE = 'openadam-developer-tools'
const PLUGIN_ROOT = `marketplace/plugins/${COMPONENT_ID}`
const DEFAULT_OUTPUT = join(repositoryRoot, 'dist', `${COMPONENT_ID}-${VERSION}-darwin-arm64.tar.gz`)

async function exists(path) {
  try {
    return await lstat(path)
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

async function writeJson(path, value, mode = 0o644) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { mode })
}

async function filePaths(root, current = root, output = []) {
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const path = join(current, entry.name)
    if (entry.isDirectory()) await filePaths(root, path, output)
    else if (entry.isFile()) output.push(relative(root, path).split(sep).join('/'))
  }
  return output.sort()
}

function packageRootForInput(input) {
  const normalized = input.split(sep).join('/')
  const marker = '/node_modules/'
  const absolute = normalized.startsWith('/') ? normalized : join(repositoryRoot, normalized).split(sep).join('/')
  const index = absolute.lastIndexOf(marker)
  if (index === -1) return null
  const remainder = absolute.slice(index + marker.length)
  const parts = remainder.split('/')
  const count = parts[0].startsWith('@') ? 2 : 1
  if (parts.length < count) return null
  return absolute.slice(0, index + marker.length) + parts.slice(0, count).join('/')
}

function safeName(value) {
  return value.replace(/^@/u, '').replaceAll('/', '__').replace(/[^A-Za-z0-9._-]/gu, '_')
}

async function bundledDependencyNotices(componentRoot, metafile) {
  const roots = [...new Set(Object.keys(metafile.inputs).map(packageRootForInput).filter(Boolean))].sort()
  const records = []
  for (const root of roots) {
    const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
    const entries = (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && /^(?:licen[cs]e|copying|notice)(?:[._-].*)?$/iu.test(entry.name))
      .map((entry) => entry.name)
      .sort()
    const licenseFiles = []
    for (const name of entries) {
      const destination = `third-party-licenses/${safeName(manifest.name)}-${manifest.version}-${safeName(name)}.txt`
      await mkdir(dirname(join(componentRoot, destination)), { recursive: true })
      await cp(join(root, name), join(componentRoot, destination), { force: false, errorOnExist: true })
      licenseFiles.push(destination)
    }
    records.push({
      name: manifest.name,
      version: manifest.version,
      license: typeof manifest.license === 'string' ? manifest.license : 'NOASSERTION',
      licenseFiles,
    })
  }
  const lines = [
    'Bundled dependency inventory',
    '',
    ...records.flatMap((item) => [
      `${item.name}@${item.version} — ${item.license}`,
      ...(item.licenseFiles.length === 0 ? ['  license file: unavailable in installed package'] : item.licenseFiles.map((path) => `  license file: ${path}`)),
    ]),
    '',
    'This deterministic inventory is not legal clearance for public redistribution.',
  ]
  await writeFile(join(componentRoot, 'THIRD_PARTY_NOTICES.txt'), `${lines.join('\n')}\n`)
  return records
}

function sbom(records) {
  return {
    spdxVersion: 'SPDX-2.3',
    dataLicense: 'CC0-1.0',
    SPDXID: 'SPDXRef-DOCUMENT',
    name: `${COMPONENT_ID}-${VERSION}`,
    documentNamespace: `https://openadam.org/spdx/${COMPONENT_ID}/${VERSION}`,
    creationInfo: { created: '2000-01-01T00:00:00Z', creators: [`Tool: Agent Tool Development Kit ${VERSION}`] },
    packages: [
      {
        SPDXID: 'SPDXRef-RootPackage',
        name: COMPONENT_ID,
        versionInfo: VERSION,
        downloadLocation: 'NOASSERTION',
        filesAnalyzed: false,
        licenseConcluded: 'NOASSERTION',
        licenseDeclared: 'Apache-2.0',
      },
      ...records.map((item, index) => ({
        SPDXID: `SPDXRef-Dependency-${index + 1}`,
        name: item.name,
        versionInfo: item.version,
        downloadLocation: 'NOASSERTION',
        filesAnalyzed: false,
        licenseConcluded: 'NOASSERTION',
        licenseDeclared: item.license,
      })),
    ],
  }
}

function integration() {
  return {
    schemaVersion: 'openadam.agent-host-developer-kit-integration.v0.1',
    displayName: 'Agent Tool Development Kit',
    summary: 'Build, check, package, and probe OpenAdam-compatible Agent tools.',
    cli: {
      executor: 'suite-node',
      command: 'runtime/openadam-dev.mjs',
      args: [],
      versionArguments: ['--version', '--json'],
    },
    codex: {
      marketplaceRoot: 'marketplace',
      marketplace: MARKETPLACE,
      pluginRoot: PLUGIN_ROOT,
      plugin: COMPONENT_ID,
      identityFiles: [
        '.codex-plugin/plugin.json',
        `skills/${SKILL_ID}/SKILL.md`,
        `skills/${SKILL_ID}/agents/openai.yaml`,
        `skills/${SKILL_ID}/references/opportunity-discovery.md`,
        `skills/${SKILL_ID}/assets/OPPORTUNITY_PROPOSAL.md`,
      ],
    },
    skill: {
      id: SKILL_ID,
      root: `${PLUGIN_ROOT}/skills/${SKILL_ID}`,
      identityFiles: [
        'SKILL.md',
        'agents/openai.yaml',
        'references/opportunity-discovery.md',
        'assets/OPPORTUNITY_PROPOSAL.md',
      ],
      launcher: 'scripts/openadam-dev',
    },
    ownership: { uninstall: 'agent-host-created-only' },
  }
}

async function publish(staged, output, replace) {
  const current = await exists(output)
  if (current !== null && (current.isSymbolicLink() || !current.isFile())) throw new Error('developer component output is not one real file')
  if (current !== null && !replace) throw new Error('developer component output already exists; pass --replace')
  const backup = `${staged}.previous`
  let moved = false
  try {
    if (current !== null) {
      await rename(output, backup)
      moved = true
    }
    await rename(staged, output)
  } catch (error) {
    if (moved && await exists(output) === null && await exists(backup) !== null) await rename(backup, output).catch(() => {})
    throw error
  }
  if (moved) await rm(backup, { force: true })
}

export async function buildDeveloperComponent({ outputPath = DEFAULT_OUTPUT, replace = false } = {}) {
  const output = resolve(outputPath)
  await mkdir(dirname(output), { recursive: true })
  const outputParent = await stat(dirname(output))
  if (!outputParent.isDirectory()) throw new Error('developer component output parent is not a directory')
  const stage = await mkdtemp(join(dirname(output), '.developer-kit-component-'))
  const componentRoot = join(stage, 'component')
  const archivePath = join(stage, basename(output))
  await mkdir(componentRoot)
  try {
    const runtimePath = join(componentRoot, 'runtime', 'openadam-dev.mjs')
    await mkdir(dirname(runtimePath), { recursive: true })
    const bundled = await build({
      entryPoints: [join(repositoryRoot, 'src', 'cli.mjs')],
      outdir: dirname(runtimePath),
      entryNames: 'openadam-dev',
      chunkNames: '[name]-[hash]',
      outExtension: { '.js': '.mjs' },
      bundle: true,
      splitting: true,
      platform: 'node',
      format: 'esm',
      target: 'node22',
      banner: { js: "import { createRequire as __openadamCreateRequire } from 'node:module'; const require = __openadamCreateRequire(import.meta.url);" },
      sourcemap: false,
      metafile: true,
      logLevel: 'silent',
    })
    const runtime = await readFile(runtimePath, 'utf8')
    if (!runtime.startsWith('#!')) await writeFile(runtimePath, `#!/usr/bin/env node\n${runtime}`)
    await chmod(runtimePath, 0o755)

    await cp(join(repositoryRoot, 'schemas'), join(componentRoot, 'schemas'), { recursive: true, force: false, errorOnExist: true })
    await cp(join(repositoryRoot, 'templates'), join(componentRoot, 'templates'), { recursive: true, force: false, errorOnExist: true })
    await mkdir(join(componentRoot, 'docs'), { recursive: true })
    for (const name of ['PRODUCT_MODEL.md', 'PROJECT_CONTRACT.md', 'REVIEW_CONTRACT.md', 'PILOT_MATRIX.md']) {
      await cp(join(repositoryRoot, 'docs', name), join(componentRoot, 'docs', name), { force: false, errorOnExist: true })
    }
    const pluginRoot = join(componentRoot, ...PLUGIN_ROOT.split('/'))
    await cp(join(repositoryRoot, '.codex-plugin'), join(pluginRoot, '.codex-plugin'), { recursive: true, force: false, errorOnExist: true })
    await cp(join(repositoryRoot, 'skills'), join(pluginRoot, 'skills'), { recursive: true, force: false, errorOnExist: true })
    await writeJson(join(componentRoot, 'marketplace', '.agents', 'plugins', 'marketplace.json'), {
      name: MARKETPLACE,
      interface: { displayName: 'OpenAdam Developer Tools' },
      plugins: [{
        name: COMPONENT_ID,
        source: { source: 'local', path: `./plugins/${COMPONENT_ID}` },
        policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
        category: 'Developer Tools',
      }],
    })
    await cp(join(repositoryRoot, 'LICENSE'), join(componentRoot, 'LICENSE'), { force: false, errorOnExist: true })
    await cp(join(repositoryRoot, 'NOTICE'), join(componentRoot, 'NOTICE'), { force: false, errorOnExist: true })
    const dependencies = await bundledDependencyNotices(componentRoot, bundled.metafile)
    await writeJson(join(componentRoot, 'sbom.spdx.json'), sbom(dependencies))
    const developerIntegration = integration()
    await writeJson(join(componentRoot, 'developer-kit', 'integration.json'), developerIntegration)

    const files = await inventoryComponent(componentRoot, [repositoryRoot], stage)
    const legal = { license: 'LICENSE', notice: 'NOTICE', thirdPartyNotices: 'THIRD_PARTY_NOTICES.txt', sbom: 'sbom.spdx.json' }
    const runtimeIdentityFiles = (await filePaths(join(componentRoot, 'runtime'))).map((path) => `runtime/${path}`)
    const identityFiles = [...new Set([
      ...runtimeIdentityFiles,
      'schemas/agent-tool-project.schema.v0.1.json',
      'developer-kit/integration.json',
      'marketplace/.agents/plugins/marketplace.json',
      `${PLUGIN_ROOT}/.codex-plugin/plugin.json`,
      `${PLUGIN_ROOT}/skills/${SKILL_ID}/SKILL.md`,
      `${PLUGIN_ROOT}/skills/${SKILL_ID}/agents/openai.yaml`,
      `${PLUGIN_ROOT}/skills/${SKILL_ID}/references/opportunity-discovery.md`,
      `${PLUGIN_ROOT}/skills/${SKILL_ID}/assets/OPPORTUNITY_PROPOSAL.md`,
      ...Object.values(legal),
    ])].sort()
    const descriptor = {
      schemaVersion: 'openadam.agent-host-component.v0.1',
      id: COMPONENT_ID,
      version: VERSION,
      kind: 'developer-kit',
      files,
      identityFiles,
      entrypoints: {
        cli: 'runtime/openadam-dev.mjs',
        skill: `${PLUGIN_ROOT}/skills/${SKILL_ID}/SKILL.md`,
      },
      integration: developerIntegration,
      legal,
    }
    const descriptorBytes = Buffer.from(`${JSON.stringify(descriptor, null, 2)}\n`)
    await writeFile(join(componentRoot, 'component.json'), descriptorBytes, { mode: 0o644, flag: 'wx' })
    const archive = await archiveComponent(componentRoot, descriptorBytes, files, archivePath)
    await publish(archivePath, output, replace)
    const repositoryRelativeOutput = relative(repositoryRoot, output)
    const reportedPath = repositoryRelativeOutput === '..' || repositoryRelativeOutput.startsWith(`..${sep}`)
      ? basename(output)
      : repositoryRelativeOutput
    return {
      schemaVersion: 'openadam.developer-kit-component-build.v0.1',
      status: 'ok',
      component: { id: COMPONENT_ID, version: VERSION, kind: 'developer-kit', files: files.length },
      artifact: { path: reportedPath, ...archive },
      descriptorSha256: `sha256:${createHash('sha256').update(descriptorBytes).digest('hex')}`,
      license: { spdx: 'Apache-2.0', files: Object.values(legal) },
      bundledDependencies: dependencies.length,
      installation: 'not-performed',
    }
  } finally {
    await rm(stage, { recursive: true, force: true })
  }
}

function options(argv) {
  const outputIndex = argv.indexOf('--output')
  if (outputIndex !== -1 && argv[outputIndex + 1] === undefined) throw new Error('--output requires a path')
  const unknown = argv.filter((item, index) => item !== '--replace' && item !== '--output' && argv[index - 1] !== '--output')
  if (unknown.length > 0) throw new Error(`unknown argument: ${unknown[0]}`)
  return { replace: argv.includes('--replace'), ...(outputIndex === -1 ? {} : { outputPath: argv[outputIndex + 1] }) }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await buildDeveloperComponent(options(process.argv.slice(2)))
  process.stdout.write(`${JSON.stringify(result)}\n`)
}
