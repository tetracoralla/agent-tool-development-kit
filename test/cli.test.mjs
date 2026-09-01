import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const execFileAsync = promisify(execFile)
const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url))

test('returns the closed project schema as bounded JSON', async () => {
  const { stdout } = await execFileAsync(process.execPath, [cli, 'schema', '--json'])
  const result = JSON.parse(stdout)
  assert.equal(result.properties.schemaVersion.const, 'openadam.agent-tool-project.v0.1')
  assert.ok(Buffer.byteLength(stdout) < 64 * 1024)
})

test('returns the packaged Developer Kit version without reading the repository', async () => {
  const { stdout } = await execFileAsync(process.execPath, [cli, '--version', '--json'])
  const result = JSON.parse(stdout)
  assert.deepEqual(result, { schemaVersion: 'openadam.developer-kit-version.v0.1', status: 'ok', version: '0.1.2' })
})

test('returns stable JSON for invalid CLI input', async () => {
  await assert.rejects(execFileAsync(process.execPath, [cli, 'inspect', '--unknown', '--json']), (error) => {
    const result = JSON.parse(error.stderr)
    assert.equal(error.code, 2)
    assert.equal(result.error.code, 'CLI_USAGE')
    return true
  })
})

test('rejects duplicate options and trailing version arguments', async () => {
  for (const args of [
    ['inspect', '--root', '.', '--root', '.', '--json'],
    ['--version', '--json', '--json'],
    ['--version', 'unexpected', '--json'],
    ['inspect', '--root', '.', '--help', '--json'],
  ]) {
    await assert.rejects(execFileAsync(process.execPath, [cli, ...args]), (error) => {
      const result = JSON.parse(error.stderr)
      assert.equal(error.code, 2)
      assert.equal(result.error.code, 'CLI_USAGE')
      return true
    })
  }
})

test('rejects check-only arguments on inspect', async () => {
  await assert.rejects(execFileAsync(process.execPath, [cli, 'inspect', '--deadline-ms', '1000', '--json']), (error) => {
    const result = JSON.parse(error.stderr)
    assert.equal(error.code, 2)
    assert.equal(result.error.code, 'CLI_USAGE')
    return true
  })
})

test('requires every explicit init authoring field', async () => {
  await assert.rejects(execFileAsync(process.execPath, [cli, 'init', 'node-mcp-provider', '--json']), (error) => {
    const result = JSON.parse(error.stderr)
    assert.equal(error.code, 2)
    assert.equal(result.error.code, 'CLI_USAGE')
    return true
  })
})
