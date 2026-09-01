import { readFile, stat } from 'node:fs/promises'
import { DeveloperKitError } from './errors.mjs'
import { MAX_INPUT_BYTES } from './constants.mjs'

export async function readBoundedJson(path, label) {
  let info
  try {
    info = await stat(path)
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new DeveloperKitError('FILE_NOT_FOUND', `${label} was not found.`)
    }
    throw error
  }
  if (!info.isFile()) throw new DeveloperKitError('FILE_INVALID', `${label} is not a regular file.`)
  if (info.size > MAX_INPUT_BYTES) {
    throw new DeveloperKitError('INPUT_TOO_LARGE', `${label} exceeds the ${MAX_INPUT_BYTES}-byte input limit.`, {
      bytes: info.size,
      limitBytes: MAX_INPUT_BYTES,
    })
  }
  let value
  try {
    value = JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new DeveloperKitError('JSON_INVALID', `${label} is not valid JSON.`)
    }
    throw error
  }
  return value
}
