import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateProjectDocument, loadProject } from './contracts.mjs'
import { DeveloperKitError } from './errors.mjs'
import { requireDirectory } from './paths.mjs'

const templatesRoot = fileURLToPath(new URL('../templates', import.meta.url))
const supportedTemplates = new Set(['node-mcp-provider'])

async function pathState(path) {
  try {
    return await lstat(path)
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

function boundedText(value, label, max) {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || /[\r\n\0]/u.test(value)) {
    throw new DeveloperKitError('INIT_INPUT_INVALID', `${label} must be one line from 1 to ${max} characters.`)
  }
  return value
}

function validateOptions(options) {
  if (!supportedTemplates.has(options.template)) {
    throw new DeveloperKitError('TEMPLATE_UNSUPPORTED', `Unsupported template: ${options.template}`)
  }
  const id = boundedText(options.id, 'project id', 128)
  if (!/^[a-z0-9](?:[a-z0-9.-]{0,126}[a-z0-9])?$/u.test(id)) {
    throw new DeveloperKitError('INIT_INPUT_INVALID', 'project id must use lower-case letters, digits, dots, or hyphens')
  }
  const plugin = boundedText(options.plugin, 'plugin id', 64)
  if (!/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/u.test(plugin)) {
    throw new DeveloperKitError('INIT_INPUT_INVALID', 'plugin id must be lower-case hyphen-case')
  }
  const operation = boundedText(options.operation, 'operation name', 64)
  if (!/^[a-z][a-z0-9_.-]{0,63}$/u.test(operation)) {
    throw new DeveloperKitError('INIT_INPUT_INVALID', 'operation name must start with a lower-case letter and use letters, digits, dots, underscores, or hyphens')
  }
  const packageName = boundedText(options.packageName, 'package name', 214)
  if (!/^(?:@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*|[a-z0-9][a-z0-9._-]*)$/u.test(packageName)) {
    throw new DeveloperKitError('INIT_INPUT_INVALID', 'package name is not a supported npm package identifier')
  }
  return {
    ...options,
    id,
    plugin,
    operation,
    packageName,
    name: boundedText(options.name, 'display name', 120),
    summary: boundedText(options.summary, 'summary', 280),
    author: boundedText(options.author, 'author', 120),
    license: boundedText(options.license, 'license', 80),
  }
}

async function templateFiles(root) {
  const files = []
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile()) files.push(relative(root, path))
      else throw new DeveloperKitError('TEMPLATE_INVALID', 'Template contains an unsupported filesystem entry.')
    }
  }
  await walk(root)
  return files.sort()
}

function replacements(options) {
  const shortSummary = options.summary.length > 96 ? `${options.summary.slice(0, 93)}...` : options.summary
  const defaultPrompt = options.summary.length > 128 ? `${options.summary.slice(0, 125)}...` : options.summary
  const skillSummary = options.summary.length > 180 ? `${options.summary.slice(0, 177)}...` : options.summary
  const skillDescription = `Use ${options.name} for ${skillSummary} This generated Skill remains a scaffold until the product-specific routing and ambiguity policy are implemented.`
  return new Map([
    ['__PROJECT_ID__', options.id],
    ['__PROJECT_ID_JSON__', JSON.stringify(options.id)],
    ['__PACKAGE_NAME_JSON__', JSON.stringify(options.packageName)],
    ['__PLUGIN_ID__', options.plugin],
    ['__PLUGIN_ID_JSON__', JSON.stringify(options.plugin)],
    ['__OPERATION_JSON__', JSON.stringify(options.operation)],
    ['__DISPLAY_NAME__', options.name],
    ['__DISPLAY_NAME_JSON__', JSON.stringify(options.name)],
    ['__SUMMARY_TEXT__', options.summary],
    ['__SUMMARY_JSON__', JSON.stringify(options.summary)],
    ['__SHORT_SUMMARY_JSON__', JSON.stringify(shortSummary)],
    ['__DEFAULT_PROMPT_JSON__', JSON.stringify(defaultPrompt)],
    ['__AUTHOR_JSON__', JSON.stringify(options.author)],
    ['__LICENSE_JSON__', JSON.stringify(options.license)],
    ['__LICENSE__', options.license],
    ['__SKILL_DESCRIPTION_JSON__', JSON.stringify(skillDescription)],
  ])
}

function render(text, values) {
  let output = text
  for (const [token, value] of values) output = output.replaceAll(token, value)
  if (/__[A-Z0-9_]+__/u.test(output)) throw new DeveloperKitError('TEMPLATE_INVALID', 'Template contains an unresolved token.')
  return output
}

function renderedPath(path, values) {
  return render(path, values)
}

async function preflight(rawOptions) {
  const options = validateOptions(rawOptions)
  const destination = resolve(options.destination)
  const parent = await requireDirectory(dirname(destination), 'destination parent')
  if (await pathState(destination) !== null) {
    throw new DeveloperKitError('DESTINATION_EXISTS', 'The init destination already exists.', { destination: basename(destination) })
  }
  const templateRoot = await requireDirectory(join(templatesRoot, options.template), 'template root')
  const values = replacements(options)
  const sourceFiles = await templateFiles(templateRoot)
  const plannedFiles = sourceFiles.map((path) => renderedPath(path, values))
  if (new Set(plannedFiles).size !== plannedFiles.length) throw new DeveloperKitError('TEMPLATE_INVALID', 'Rendered template paths collide.')

  const rendered = new Map()
  for (let index = 0; index < sourceFiles.length; index += 1) {
    const text = await readFile(join(templateRoot, sourceFiles[index]), 'utf8')
    rendered.set(plannedFiles[index], render(text, values))
  }
  const projectText = rendered.get('agent-tool.json')
  if (projectText === undefined) throw new DeveloperKitError('TEMPLATE_INVALID', 'Template does not contain agent-tool.json.')
  validateProjectDocument(JSON.parse(projectText))
  return { options, destination, parent, plannedFiles, rendered }
}

async function materialize(plan) {
  const staging = await mkdtemp(join(plan.parent, '.openadam-dev-init-'))
  try {
    for (const [path, contents] of plan.rendered) {
      const target = join(staging, path)
      await mkdir(dirname(target), { recursive: true })
      const executable = path === 'src/cli.mjs' || path.startsWith('scripts/')
      await writeFile(target, contents, { mode: executable ? 0o755 : 0o644, flag: 'wx' })
    }
    await loadProject(staging)
    const marker = await stat(join(staging, '.openadam-scaffold'))
    if (!marker.isFile()) throw new DeveloperKitError('TEMPLATE_INVALID', 'Scaffold marker is missing.')
    await rename(staging, plan.destination)
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => {})
    throw error
  }
}

export async function initProject(rawOptions) {
  const plan = await preflight(rawOptions)
  if (!rawOptions.dryRun) await materialize(plan)
  return {
    schemaVersion: 'openadam.developer-kit-init.v0.1',
    status: rawOptions.dryRun ? 'ready' : 'created',
    template: plan.options.template,
    project: { id: plan.options.id, version: '0.1.0' },
    destination: basename(plan.destination),
    files: plan.plannedFiles,
    mutation: rawOptions.dryRun ? 'not-performed' : 'created',
    nextAction: 'Implement the product-specific core, schemas, tests, and Skill, then remove .openadam-scaffold and run openadam-dev check.',
  }
}
