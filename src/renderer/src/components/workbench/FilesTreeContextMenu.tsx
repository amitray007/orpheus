// ---------------------------------------------------------------------------
// src/renderer/src/components/workbench/FilesTreeContextMenu.tsx
//
// Phase 4 — the right-click context menu content for the Workbench Files tab
// tree. Returned from `<FileTree renderContextMenu={(item, ctx) => ...}>`
// (docs/learnings/pierre-libraries.md §10.3). The tree owns the trigger +
// open/close lifecycle; this component only renders the MENU CONTENT, anchored
// to `ctx.anchorRect`, in a portal.
//
// Menu actions split two ways (§10.3):
//   - New File / New Folder / Rename / Delete → the NEW files:* mutation IPCs
//     (create/rename/delete on disk), wired by the caller via `actions`.
//   - Reveal in Finder / Open in Editor / Copy Path → the EXISTING shell:*
//     IPCs, which take ABSOLUTE paths (assertAbsolutePath server-side). The
//     caller resolves item.path → absolute via files:absolutePath first.
//
// Styling mirrors ContextMenu.tsx / TreeOptionsPopover (Overlay + surface-
// overlay chrome). The portaled root is tagged
// `data-file-tree-context-menu-root="true"` so the tree does not treat clicks
// inside the menu as outside-clicks (§10.3, FileTreeContextMenuCompositionOptions).
// ---------------------------------------------------------------------------

import type React from 'react'
import {
  FilePlus,
  FolderPlus,
  PencilSimple,
  Trash,
  MagnifyingGlass,
  ArrowSquareOut,
  Copy
} from '@phosphor-icons/react'
import { Overlay } from '../ui/Overlay'
import type {
  ContextMenuItem as FileTreeContextMenuItem,
  ContextMenuOpenContext as FileTreeContextMenuOpenContext
} from '@pierre/trees'

/** The disk-mutation + reveal actions the menu triggers. Each closes the menu
 *  itself (via the caller's `close`) — kept as thin callbacks so all the IPC +
 *  tree-model wiring lives in FilesTab, out of this presentational component. */
export interface FilesTreeContextMenuActions {
  onNewFile: () => void
  onNewFolder: () => void
  onRename: () => void
  onDelete: () => void
  onRevealInFinder: () => void
  onOpenInEditor: () => void
  onCopyPath: () => void
}

interface FilesTreeContextMenuProps {
  item: FileTreeContextMenuItem
  context: FileTreeContextMenuOpenContext
  actions: FilesTreeContextMenuActions
}

interface Row {
  label: string
  icon: React.ReactNode
  onClick: () => void
  destructive?: boolean
  divider?: boolean
}

const ICON = 15

/** Build the ordered menu rows for the given item + actions. Directory-only vs
 *  file-only differences are cosmetic (New File/Folder target is derived by the
 *  caller), so every item gets the full menu. */
function buildRows(actions: FilesTreeContextMenuActions): Row[] {
  return [
    { label: 'New File', icon: <FilePlus size={ICON} />, onClick: actions.onNewFile },
    { label: 'New Folder', icon: <FolderPlus size={ICON} />, onClick: actions.onNewFolder },
    {
      label: 'Rename',
      icon: <PencilSimple size={ICON} />,
      onClick: actions.onRename,
      divider: true
    },
    {
      label: 'Reveal in Finder',
      icon: <MagnifyingGlass size={ICON} />,
      onClick: actions.onRevealInFinder
    },
    {
      label: 'Open in Editor',
      icon: <ArrowSquareOut size={ICON} />,
      onClick: actions.onOpenInEditor
    },
    { label: 'Copy Path', icon: <Copy size={ICON} />, onClick: actions.onCopyPath, divider: true },
    { label: 'Delete', icon: <Trash size={ICON} />, onClick: actions.onDelete, destructive: true }
  ]
}

export function FilesTreeContextMenu({
  item,
  context,
  actions
}: FilesTreeContextMenuProps): React.JSX.Element {
  const rows = buildRows(actions)
  // Anchor the menu at the trigger rect's bottom-left (clamped to the viewport
  // right/bottom so it never overflows off-screen).
  const rect = context.anchorRect
  const MENU_W = 200
  const left = Math.min(rect.left, window.innerWidth - MENU_W - 8)
  const top = Math.min(rect.bottom + 2, window.innerHeight - rows.length * 30 - 8)

  return (
    <Overlay
      open
      interactive
      onDismiss={() => context.close()}
      portal
      style={{ position: 'fixed', left: Math.max(4, left), top: Math.max(4, top) }}
      className="z-50 bg-surface-overlay border border-border-default rounded-md shadow-lg py-1"
    >
      <div
        data-file-tree-context-menu-root="true"
        className="min-w-[180px]"
        role="menu"
        aria-label={`Actions for ${item.name}`}
      >
        {rows.map((row) => (
          <div key={row.label}>
            <button
              type="button"
              role="menuitem"
              className={[
                'w-full flex items-center gap-2 px-3 py-1.5 text-sm text-left transition-colors duration-100 cursor-pointer',
                row.destructive
                  ? 'text-red-400 hover:bg-red-500/10 hover:text-red-300'
                  : 'text-text-primary hover:bg-surface-raised'
              ].join(' ')}
              onClick={row.onClick}
            >
              <span className="flex-shrink-0 flex items-center text-text-muted">{row.icon}</span>
              {row.label}
            </button>
            {/* Divider renders AFTER the row to close a group (e.g. after
                Rename, after Copy Path) — see the `divider` flags in buildRows. */}
            {row.divider && <div className="my-1 border-t border-border-default" />}
          </div>
        ))}
      </div>
    </Overlay>
  )
}
