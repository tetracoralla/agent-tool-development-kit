import assert from 'node:assert/strict'
import test from 'node:test'
import { executeOperation, ProviderError } from '../src/core.mjs'

test('the scaffold cannot be mistaken for a completed core', () => {
  assert.throws(() => executeOperation({ value: 'probe' }), (error) => {
    assert.equal(error instanceof ProviderError, true)
    assert.equal(error.code, 'CORE_NOT_IMPLEMENTED')
    return true
  })
})
