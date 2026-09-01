export class DeveloperKitError extends Error {
  constructor(code, message, details = undefined) {
    super(message)
    this.name = 'DeveloperKitError'
    this.code = code
    this.details = details
  }
}

export function publicError(error) {
  if (error instanceof DeveloperKitError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.details === undefined ? {} : { details: error.details }),
    }
  }
  return {
    code: 'INTERNAL_ERROR',
    message: 'The Developer Kit could not complete the request.',
  }
}
