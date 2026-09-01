#!/usr/bin/env node
import { executeOperation, ProviderError } from './core.mjs'

function resultError(error) {
  return {
    status: 'error',
    error: {
      code: error instanceof ProviderError ? error.code : 'INTERNAL_ERROR',
      message: error instanceof ProviderError ? error.message : 'The provider could not complete the request.',
    },
  }
}

const valueIndex = process.argv.indexOf('--value')
if (process.argv.includes('--help') || valueIndex === -1 || process.argv[valueIndex + 1] === undefined) {
  process.stdout.write('Usage: __PLUGIN_ID__ --value TEXT\n')
} else {
  try {
    const result = executeOperation({ value: process.argv[valueIndex + 1] })
    process.stdout.write(`${JSON.stringify(result)}\n`)
  } catch (error) {
    process.stderr.write(`${JSON.stringify(resultError(error))}\n`)
    process.exitCode = 1
  }
}
