export class ProviderError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'ProviderError'
    this.code = code
  }
}

export function executeOperation(_input) {
  throw new ProviderError(
    'CORE_NOT_IMPLEMENTED',
    'Replace the generated scaffold core with the product-specific deterministic implementation.',
  )
}
