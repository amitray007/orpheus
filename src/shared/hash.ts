// ---------------------------------------------------------------------------
// src/shared/hash.ts
//
// PERF FIX (LAG-LAYER #7): a fast, collision-resistant-enough content hash
// for change-detection signatures (e.g. GitTab's diffSignature — see
// gitDiff.ts's per-file `sig` field). Deliberately NOT a 32-bit hash
// (FNV/djb2 etc.) — at 32 bits, hashing thousands of diff settles over a long
// session makes a birthday-bound collision a real risk, and a collision here
// means a REAL change silently fails to register (the idempotent-no-op guard
// would skip a genuine diff update). cyrb53 produces a 53-bit hash (safe as
// a JS number, fits in a template-string-friendly base36 encoding) at a
// small constant multiple of the cost of a 32-bit hash — cheap enough to run
// per file on every settle, while making an accidental collision practically
// irrelevant for this use case.
//
// Reference: cyrb53 by bryc (public domain / MIT-equivalent, widely used
// small-hash implementation: https://github.com/bryc/code/blob/master/jshash/experimental/cyrb53.js)
// ---------------------------------------------------------------------------

/** cyrb53: a fast 53-bit (two 32-bit halves combined) string hash. Returns a
 *  base36-encoded string so callers can cheaply concatenate/compare hashes
 *  without worrying about numeric precision loss. NOT cryptographic — only
 *  used for change-detection signatures, never for anything security-
 *  sensitive. */
export function cyrb53(str: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed
  let h2 = 0x41c6ce57 ^ seed
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  const combined = 4294967296 * (2097151 & h2) + (h1 >>> 0)
  return combined.toString(36)
}
