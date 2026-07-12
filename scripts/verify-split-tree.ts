// ---------------------------------------------------------------------------
// scripts/verify-split-tree.ts
//
// Standalone assertion harness for
// src/renderer/src/components/panes/splitTreeOps.ts (Panes v2, U5). Follows
// the one precedent this repo has for a framework-free test file —
// scripts/verify-migration-engine.ts — using node:assert and no runner.
//
// NOTE ON THE MODULE NAME: the pure split-tree ops module is named
// `splitTreeOps.ts`, not `splitTree.ts` — see that file's own header comment
// for why (a macOS case-insensitive-filesystem clash with the sibling
// `SplitTree.tsx` recursive renderer component; TypeScript rejects the two
// coexisting in one module graph even though the filesystem itself keeps
// them as distinct case-preserved files).
//
// Unlike verify-migration-engine.ts, this file needs NO module-resolution
// loader hook: that hook exists solely because src/main/db/*.ts uses
// extensionless relative imports under this repo's `moduleResolution:
// bundler` tsconfig, which Node's raw ESM loader can't resolve on its own.
// splitTreeOps.ts imports only TYPES (SplitDirection, SplitTree — erased at
// runtime, so its `@shared/types` specifier never has to resolve at all) and
// otherwise has zero external dependencies, so `bun run` (which has native
// TS support and its own tsconfig-aware path resolution, unlike raw node)
// runs it directly with no shim.
//
// Run with:  bun run scripts/verify-split-tree.ts
// ---------------------------------------------------------------------------

import assert from 'node:assert'
import type { SplitTree } from '../src/shared/types'
import {
  splitLeaf,
  closeLeaf,
  swapLeaves,
  setRatio,
  countLeaves,
  firstLeaf,
  leafIds
} from '../src/renderer/src/components/panes/splitTreeOps'

type SplitNode = Extract<SplitTree, { dir: unknown }>

/** Narrows a SplitTree to its node variant for assertions that need to reach
 *  a node-only field (`ratio`, `a`, `b`) — throws if handed a leaf, which is
 *  exactly what we want in a test (a leaf there means the test's own premise
 *  is wrong, not a case to silently tolerate via `any`). */
function asNode(tree: SplitTree): SplitNode {
  assert.ok('dir' in tree, 'expected a split node, got a leaf')
  return tree as SplitNode
}

// ---------------------------------------------------------------------------
// splitLeaf
// ---------------------------------------------------------------------------

{
  // Split right ('v') on a single-leaf tree.
  const single: SplitTree = { paneId: 'p1' }
  const snapshot = structuredClone(single)
  const afterV = splitLeaf(single, 'p1', 'v', 'p2')
  assert.deepEqual(afterV, {
    dir: 'v',
    a: { paneId: 'p1' },
    b: { paneId: 'p2' },
    ratio: 0.5
  })
  assert.deepEqual(single, snapshot, 'splitLeaf must not mutate its input tree')
  console.log('✓ splitLeaf: split right on single-leaf tree')
}

{
  // Split below ('h') on a single-leaf tree.
  const single: SplitTree = { paneId: 'p1' }
  const afterH = splitLeaf(single, 'p1', 'h', 'p2')
  assert.deepEqual(afterH, {
    dir: 'h',
    a: { paneId: 'p1' },
    b: { paneId: 'p2' },
    ratio: 0.5
  })
  console.log('✓ splitLeaf: split below on single-leaf tree')
}

{
  // Split on a leaf nested inside an existing tree — only the path to that
  // leaf should be reconstructed; the sibling subtree is untouched (same
  // object reference).
  const nested: SplitTree = {
    dir: 'v',
    a: { paneId: 'p1' },
    b: { dir: 'h', a: { paneId: 'p2' }, b: { paneId: 'p3' }, ratio: 0.5 }
  }
  const snapshot = structuredClone(nested)
  const result = splitLeaf(nested, 'p2', 'v', 'p4')
  assert.deepEqual(result, {
    dir: 'v',
    a: { paneId: 'p1' },
    b: {
      dir: 'h',
      a: { dir: 'v', a: { paneId: 'p2' }, b: { paneId: 'p4' }, ratio: 0.5 },
      b: { paneId: 'p3' },
      ratio: 0.5
    }
  })
  // Structural sharing: the untouched 'a' branch (leaf p1) is the SAME
  // object reference as before, not a clone.
  assert.strictEqual(asNode(result).a, asNode(nested).a)
  assert.deepEqual(nested, snapshot, 'splitLeaf must not mutate its input tree')
  console.log('✓ splitLeaf: split on a nested leaf, sibling untouched by reference')
}

{
  // Not-found paneId — unchanged (same reference).
  const tree: SplitTree = { paneId: 'p1' }
  const result = splitLeaf(tree, 'does-not-exist', 'v', 'p2')
  assert.strictEqual(result, tree)
  console.log('✓ splitLeaf: not-found paneId is a no-op (same reference)')
}

// ---------------------------------------------------------------------------
// closeLeaf
// ---------------------------------------------------------------------------

{
  // Closing a non-root leaf collapses the parent node to the sibling.
  const tree: SplitTree = {
    dir: 'v',
    a: { paneId: 'p1' },
    b: { paneId: 'p2' },
    ratio: 0.5
  }
  const snapshot = structuredClone(tree)
  const result = closeLeaf(tree, 'p2')
  assert.deepEqual(result, { paneId: 'p1' })
  assert.deepEqual(tree, snapshot, 'closeLeaf must not mutate its input tree')
  console.log('✓ closeLeaf: non-root leaf collapses to sibling')
}

{
  // Closing the last remaining (root) leaf returns null.
  const tree: SplitTree = { paneId: 'only' }
  const result = closeLeaf(tree, 'only')
  assert.equal(result, null)
  console.log('✓ closeLeaf: closing the last remaining leaf returns null')
}

{
  // Closing a leaf whose sibling is itself a subtree keeps that subtree
  // intact (not flattened to just a leaf).
  const sibling: SplitTree = { dir: 'h', a: { paneId: 'p2' }, b: { paneId: 'p3' }, ratio: 0.3 }
  const tree: SplitTree = { dir: 'v', a: { paneId: 'p1' }, b: sibling, ratio: 0.6 }
  const result = closeLeaf(tree, 'p1')
  assert.deepEqual(result, sibling)
  assert.strictEqual(result, sibling, 'the surviving subtree should be the same reference')
  console.log('✓ closeLeaf: sibling subtree (not just a leaf) survives intact')
}

{
  // Not-found paneId — unchanged.
  const tree: SplitTree = { dir: 'v', a: { paneId: 'p1' }, b: { paneId: 'p2' }, ratio: 0.5 }
  const result = closeLeaf(tree, 'nope')
  assert.strictEqual(result, tree)
  console.log('✓ closeLeaf: not-found paneId is a no-op (same reference)')
}

{
  // null tree in, null out.
  assert.equal(closeLeaf(null, 'anything'), null)
  console.log('✓ closeLeaf: null tree returns null')
}

// ---------------------------------------------------------------------------
// swapLeaves
// ---------------------------------------------------------------------------

{
  const tree: SplitTree = {
    dir: 'v',
    a: { paneId: 'p1' },
    b: { dir: 'h', a: { paneId: 'p2' }, b: { paneId: 'p3' }, ratio: 0.4 }
  }
  const snapshot = structuredClone(tree)
  const result = swapLeaves(tree, 'p1', 'p3')
  assert.deepEqual(result, {
    dir: 'v',
    a: { paneId: 'p3' },
    b: { dir: 'h', a: { paneId: 'p2' }, b: { paneId: 'p1' }, ratio: 0.4 }
  })
  assert.deepEqual(tree, snapshot, 'swapLeaves must not mutate its input tree')
  console.log('✓ swapLeaves: shape/ratios unchanged, paneIds exchanged')
}

{
  // Non-existent id — no-op.
  const tree: SplitTree = { dir: 'v', a: { paneId: 'p1' }, b: { paneId: 'p2' }, ratio: 0.5 }
  const result = swapLeaves(tree, 'p1', 'ghost')
  assert.strictEqual(result, tree)
  console.log('✓ swapLeaves: swap with a non-existent id is a no-op')
}

{
  // Same id twice — no-op.
  const tree: SplitTree = { dir: 'v', a: { paneId: 'p1' }, b: { paneId: 'p2' }, ratio: 0.5 }
  const result = swapLeaves(tree, 'p1', 'p1')
  assert.strictEqual(result, tree)
  console.log('✓ swapLeaves: swapping an id with itself is a no-op')
}

// ---------------------------------------------------------------------------
// setRatio
// ---------------------------------------------------------------------------

{
  // Root node.
  const tree: SplitTree = { dir: 'v', a: { paneId: 'p1' }, b: { paneId: 'p2' }, ratio: 0.5 }
  const snapshot = structuredClone(tree)
  const result = setRatio(tree, [], 0.7)
  assert.equal(asNode(result).ratio, 0.7)
  assert.deepEqual(tree, snapshot, 'setRatio must not mutate its input tree')
  console.log('✓ setRatio: sets ratio at root')
}

{
  // Nested path: root -> b -> (node).
  const tree: SplitTree = {
    dir: 'v',
    a: { paneId: 'p1' },
    b: { dir: 'h', a: { paneId: 'p2' }, b: { paneId: 'p3' }, ratio: 0.5 }
  }
  const result = setRatio(tree, ['b'], 0.25)
  assert.equal(asNode(asNode(result).b).ratio, 0.25)
  // Untouched sibling ('a') is the same reference.
  assert.strictEqual(asNode(result).a, asNode(tree).a)
  console.log('✓ setRatio: sets ratio at a nested path')
}

{
  // Clamps below the floor.
  const tree: SplitTree = { dir: 'v', a: { paneId: 'p1' }, b: { paneId: 'p2' }, ratio: 0.5 }
  const result = setRatio(tree, [], 0.01)
  assert.equal(asNode(result).ratio, 0.15)
  console.log('✓ setRatio: clamps below 0.15 to the floor')
}

{
  // Clamps above the ceiling.
  const tree: SplitTree = { dir: 'v', a: { paneId: 'p1' }, b: { paneId: 'p2' }, ratio: 0.5 }
  const result = setRatio(tree, [], 0.99)
  assert.equal(asNode(result).ratio, 0.85)
  console.log('✓ setRatio: clamps above 0.85 to the ceiling')
}

{
  // Path resolves into a leaf — invalid, tree unchanged.
  const tree: SplitTree = { dir: 'v', a: { paneId: 'p1' }, b: { paneId: 'p2' }, ratio: 0.5 }
  const result = setRatio(tree, ['a'], 0.7)
  assert.strictEqual(result, tree)
  console.log('✓ setRatio: path into a leaf is a no-op')
}

{
  // Path walks off the tree entirely — invalid, tree unchanged.
  const tree: SplitTree = { paneId: 'p1' }
  const result = setRatio(tree, ['a', 'b'], 0.7)
  assert.strictEqual(result, tree)
  console.log('✓ setRatio: path off the tree is a no-op')
}

// ---------------------------------------------------------------------------
// countLeaves / firstLeaf / leafIds
// ---------------------------------------------------------------------------

{
  assert.equal(countLeaves(null), 0)
  assert.equal(firstLeaf(null), null)
  assert.deepEqual(leafIds(null), [])
  console.log('✓ countLeaves/firstLeaf/leafIds: null tree')
}

{
  const single: SplitTree = { paneId: 'only' }
  assert.equal(countLeaves(single), 1)
  assert.equal(firstLeaf(single), 'only')
  assert.deepEqual(leafIds(single), ['only'])
  console.log('✓ countLeaves/firstLeaf/leafIds: single-leaf tree')
}

{
  // Multi-level tree, 4 leaves.
  const tree: SplitTree = {
    dir: 'v',
    a: { dir: 'h', a: { paneId: 'p1' }, b: { paneId: 'p2' }, ratio: 0.5 },
    b: { dir: 'h', a: { paneId: 'p3' }, b: { paneId: 'p4' }, ratio: 0.5 },
    ratio: 0.55
  }
  assert.equal(countLeaves(tree), 4)
  assert.equal(firstLeaf(tree), 'p1') // depth-first, a-first
  assert.deepEqual(leafIds(tree), ['p1', 'p2', 'p3', 'p4'])
  console.log('✓ countLeaves/firstLeaf/leafIds: multi-level tree')
}

console.log('\nAll splitTree.ts assertions passed.')
console.log('✓ split-tree OK')
