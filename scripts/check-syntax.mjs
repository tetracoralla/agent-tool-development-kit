import { spawnSync } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
let checked = 0
for (const directory of ['src', 'scripts', 'test']) {
  for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.mjs')) continue
    const result = spawnSync(process.execPath, ['--check', join(root, directory, entry.name)], { stdio: 'inherit' })
    if (result.error) throw result.error
    if (result.status !== 0) process.exit(result.status ?? 1)
    checked += 1
  }
}
console.log(`Checked ${checked} JavaScript files`)
