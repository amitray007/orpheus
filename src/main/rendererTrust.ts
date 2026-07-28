/**
 * Renderer-origin trust is an exact entry-point comparison. Hash changes are
 * allowed for client-side routing; credentials, origin, path, and query
 * changes are not.
 */
export function isTrustedRendererUrl(candidate: string, trustedEntry: string): boolean {
  try {
    const actual = new URL(candidate)
    const expected = new URL(trustedEntry)
    if (actual.username !== '' || actual.password !== '') return false
    return (
      actual.protocol === expected.protocol &&
      actual.host === expected.host &&
      actual.pathname === expected.pathname &&
      actual.search === expected.search
    )
  } catch {
    return false
  }
}
