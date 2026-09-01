import { isAbsolute, relative, resolve, sep, win32 } from 'node:path'
import { lstat, realpath, stat } from 'node:fs/promises'
import { DeveloperKitError } from './errors.mjs'

function inside(root, path) {
  const rel = relative(root, path)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

export function requireRelativePath(value, label = 'path') {
  if (typeof value !== 'string' || value.length === 0 || value.length > 1024 || value.includes('\0')) {
    throw new DeveloperKitError('PATH_INVALID', `${label} must be a non-empty bounded relative path.`)
  }
  if (isAbsolute(value) || win32.isAbsolute(value) || /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(value)) {
    throw new DeveloperKitError('PATH_NOT_RELATIVE', `${label} must be repository-relative.`)
  }
  const parts = value.replaceAll('\\', '/').split('/')
  if (parts.some((part) => part === '..')) {
    throw new DeveloperKitError('PATH_ESCAPE', `${label} may not traverse outside the repository.`)
  }
  return value
}

export async function requireDirectory(path, label = 'workspace root') {
  const absolute = resolve(path)
  let info
  try {
    info = await stat(absolute)
  } catch (error) {
    if (error?.code === 'ENOENT') throw new DeveloperKitError('ROOT_NOT_FOUND', `${label} was not found.`)
    throw error
  }
  if (!info.isDirectory()) throw new DeveloperKitError('ROOT_INVALID', `${label} is not a directory.`)
  return realpath(absolute)
}

export async function resolveDeclaredFile(root, declaredPath, label = 'declared file') {
  const safe = requireRelativePath(declaredPath, label)
  const rootReal = await requireDirectory(root)
  const parts = safe.replaceAll('\\', '/').split('/').filter((part) => part !== '' && part !== '.')
  let current = rootReal
  for (const part of parts) {
    current = resolve(current, part)
    if (!inside(rootReal, current)) throw new DeveloperKitError('PATH_ESCAPE', `${label} escapes the repository.`)
    let info
    try {
      info = await lstat(current)
    } catch (error) {
      if (error?.code === 'ENOENT') throw new DeveloperKitError('FILE_NOT_FOUND', `${label} was not found.`, { path: safe })
      throw error
    }
    if (info.isSymbolicLink()) {
      throw new DeveloperKitError('PATH_SYMLINK_REJECTED', `${label} may not contain a symbolic link.`, { path: safe })
    }
  }
  const targetReal = await realpath(current)
  if (!inside(rootReal, targetReal)) throw new DeveloperKitError('PATH_ESCAPE', `${label} escapes the repository.`)
  const info = await stat(targetReal)
  if (!info.isFile()) throw new DeveloperKitError('FILE_INVALID', `${label} is not a regular file.`, { path: safe })
  return targetReal
}
