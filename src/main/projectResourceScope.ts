import * as fs from 'node:fs'
import * as nodePath from 'node:path'

function isWithin(root: string, candidate: string): boolean {
  const relative = nodePath.relative(root, candidate)
  return relative === '' || (!relative.startsWith(`..${nodePath.sep}`) && relative !== '..')
}

/**
 * Resolve an existing resource below a registered project without following a
 * symlink in the project-relative resource path. The registered project root
 * itself may be a symlink because that path is the user's canonical project
 * selection.
 */
export function resolveProjectResourcePath(
  projectRoot: string,
  segments: readonly string[],
  expected: 'file' | 'directory'
): string | null {
  const lexicalRoot = nodePath.resolve(projectRoot)
  const candidate = nodePath.resolve(lexicalRoot, ...segments)
  if (!isWithin(lexicalRoot, candidate) || candidate === lexicalRoot) return null

  try {
    let current = lexicalRoot
    for (const segment of segments) {
      current = nodePath.join(current, segment)
      if (fs.lstatSync(current).isSymbolicLink()) return null
    }

    const stat = fs.lstatSync(candidate)
    if (expected === 'file' ? !stat.isFile() : !stat.isDirectory()) return null

    const realRoot = fs.realpathSync(lexicalRoot)
    const realCandidate = fs.realpathSync(candidate)
    return isWithin(realRoot, realCandidate) ? candidate : null
  } catch {
    return null
  }
}
