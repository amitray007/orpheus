// ---------------------------------------------------------------------------
// src/renderer/src/components/dashboard/ProjectsHome.tsx
//
// ProjectsHome — the calm, illustrated EMPTY STATE for the Projects surface.
//
// This is the RESTING state of the Projects rail surface: what renders in
// <main> when the Projects surface is active but nothing is selected yet
// (no project, no workspace). It replaces the old "workspaces kanban as the
// landing" pattern — that board (WorkspacesView) still exists as the
// `sessions` view kind, but it is being retired as the thing you see first.
// ProjectsHome is the new first-impression surface: quiet, centered, and
// clearly says "pick something from the sidebar."
//
// Design of record: "Option A" mockup — a small terminal-constellation mark
// (2-3 overlapping mini terminal windows, one accent-tinted, with a blinking
// caret) and a short heading + subcopy. (The mockup also showed ⌘K/⌘T keycap
// hints, but those shortcuts / a command palette aren't wired yet, so they're
// intentionally omitted rather than advertised — revisit when a real command
// palette lands.) Everything here is presentational only:
//   - No data fetching, no IPC calls, no store subscriptions.
//   - No required props. This component does not know about projects,
//     workspaces, or selection state — the sidebar/Dashboard own that.
//   - Purely token-driven styling (bg-surface-*, text-text-*, border-*,
//     text-accent/bg-accent) so it matches both light and dark themes for
//     free, same as every other dashboard component.
//
// Wiring this into MainContent (and any onNewWorkspace affordance) is a
// SEPARATE unit of work — this file only defines the component.
// ---------------------------------------------------------------------------

import type React from 'react'

// ---------------------------------------------------------------------------
// TerminalConstellation — small CSS-only illustration mark.
//
// Three overlapping "terminal window" rounded-rects (title-bar hairline +
// body), one tinted with the accent border to imply "this one's alive."
// A tiny blinking caret sits in the front-most window. No external image or
// SVG assets — everything is Tailwind-classed <div>s. The blink respects
// prefers-reduced-motion via Tailwind's `motion-reduce:` variant, which
// simply drops the animation and leaves the caret solid.
// ---------------------------------------------------------------------------

function TerminalConstellation(): React.JSX.Element {
  return (
    <div aria-hidden="true" className="relative shrink-0" style={{ width: 120, height: 80 }}>
      {/* Back window — furthest, most muted, top-left */}
      <div
        className="absolute rounded-md border border-border-default bg-surface-raised shadow-sm"
        style={{ width: 62, height: 42, left: 0, top: 4 }}
      >
        <div className="h-2 border-b border-border-default rounded-t-md" />
      </div>

      {/* Middle window — accent-tinted, slightly forward, top-right */}
      <div
        className="absolute rounded-md border border-accent/50 bg-surface-raised shadow-sm"
        style={{ width: 62, height: 42, right: 0, top: 0 }}
      >
        <div className="h-2 border-b border-accent/50 rounded-t-md" />
      </div>

      {/* Front window — largest, centered low, holds the caret */}
      <div
        className="absolute rounded-md border border-border-default bg-surface-overlay shadow-md flex flex-col"
        style={{ width: 76, height: 50, left: 22, top: 26 }}
      >
        <div className="h-2.5 border-b border-border-default rounded-t-md shrink-0" />
        <div className="flex-1 flex items-center px-2.5">
          <span
            className="inline-block bg-accent animate-pulse motion-reduce:animate-none"
            style={{ width: 6, height: 10 }}
          />
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// ProjectsHome
// ---------------------------------------------------------------------------

export function ProjectsHome(): React.JSX.Element {
  return (
    <div className="h-full w-full flex flex-col items-center justify-center gap-6 text-center px-6">
      <TerminalConstellation />

      <div className="flex flex-col gap-2 max-w-sm">
        <p className="text-sm font-medium text-text-primary">Pick up where you left off</p>
        <p className="text-xs text-text-muted leading-relaxed">
          Select a project or workspace from the sidebar to jump back into its terminal.
        </p>
      </div>
    </div>
  )
}
