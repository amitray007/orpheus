import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const ALLOWED_MIME = ['image/png', 'image/tiff', 'image/jpeg'] as const
const MAX_SIZE = 20 * 1024 * 1024

/** JS mirror of addon.mm performDragOperation quoting — keep in sync. */
export function quotePosixPath(p: string): string {
  // Characters that require quoting
  if (/[ \t"'$`\\(){}[\]&|;<>*?#]/.test(p)) {
    return "'" + p.replaceAll("'", "'\"'\"'") + "'"
  }
  return p
}

export function quotePosixPaths(paths: string[]): string {
  return paths.map(quotePosixPath).join(' ')
}

export async function writeImageAttachment(
  bytes: Uint8Array,
  mime: string
): Promise<{ path: string }> {
  if (!(ALLOWED_MIME as readonly string[]).includes(mime)) {
    throw new Error(`Unsupported MIME type: ${mime}. Allowed: ${ALLOWED_MIME.join(', ')}`)
  }
  if (bytes.length > MAX_SIZE) {
    throw new Error(`Image too large: ${bytes.length} bytes (max ${MAX_SIZE})`)
  }
  const absolutePath = join(tmpdir(), `orpheus-paste-${Date.now()}.png`)
  try {
    await writeFile(absolutePath, bytes)
  } catch (err) {
    throw new Error(
      `Failed to write image attachment: ${err instanceof Error ? err.message : String(err)}`
    )
  }
  return { path: quotePosixPath(absolutePath) }
}
