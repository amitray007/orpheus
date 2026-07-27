import * as fs from 'node:fs/promises'
import * as path from 'node:path'

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  )
}

async function nearestCanonicalAncestor(candidate: string, root: string): Promise<string | null> {
  let current = candidate
  while (isInside(root, current)) {
    try {
      await fs.lstat(current)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return null
      const parent = path.dirname(current)
      if (parent === current) return null
      current = parent
      continue
    }

    try {
      return await fs.realpath(current)
    } catch {
      // A dangling or otherwise unresolvable symlink is not a safe ancestor.
      return null
    }
  }
  return null
}

/**
 * Canonically contains a workspace-relative path. Existing symlinks are
 * resolved before the containment decision; a missing final path is allowed
 * only when every existing ancestor resolves inside the canonical root.
 */
export async function isCanonicalWorkspacePath(
  workspaceRoot: string,
  relativePath: string,
  options: { requireFile: boolean }
): Promise<boolean> {
  let canonicalRoot: string
  try {
    canonicalRoot = await fs.realpath(workspaceRoot)
  } catch {
    return false
  }

  const lexicalCandidate = path.resolve(canonicalRoot, relativePath)
  if (!isInside(canonicalRoot, lexicalCandidate) || lexicalCandidate === canonicalRoot) return false

  try {
    const canonicalCandidate = await fs.realpath(lexicalCandidate)
    if (!isInside(canonicalRoot, canonicalCandidate) || canonicalCandidate === canonicalRoot) {
      return false
    }
    if (!options.requireFile) return true
    return (await fs.stat(canonicalCandidate)).isFile()
  } catch (error) {
    if (options.requireFile || (error as NodeJS.ErrnoException).code !== 'ENOENT') return false
    const ancestor = await nearestCanonicalAncestor(path.dirname(lexicalCandidate), canonicalRoot)
    return ancestor != null && isInside(canonicalRoot, ancestor)
  }
}
