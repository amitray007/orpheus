/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'no-circular',
      severity: 'error',
      comment:
        'This dependency is part of a circular relationship. You might want to revise ' +
        'your solution (i.e. use dependency inversion, make sure the modules have a ' +
        'single responsibility) ',
      from: {},
      to: {
        circular: true
      }
    },

    // Electron three-process layering (+ shared).
    //
    // Main (src/main/**) owns SQLite, IPC handlers, the native ghostty addon, and the
    // hook server — it runs in a Node context and must never pull in renderer-only
    // (browser/React/DOM) code.
    {
      name: 'main-not-to-renderer',
      severity: 'error',
      comment:
        'src/main is the Electron main process (Node/Electron, owns SQLite, IPC, the native ' +
        'ghostty addon). It must not import from src/renderer, which is browser-sandboxed React ' +
        'UI code that assumes a DOM/window and is bundled separately by Vite.',
      from: { path: '^src/main' },
      to: { path: '^src/renderer' }
    },
    // Renderer (src/renderer/**) is React UI running in a sandboxed browser-like context and
    // talks to main only through the typed window.api.* preload bridge — never directly.
    {
      name: 'renderer-not-to-main',
      severity: 'error',
      comment:
        'src/renderer is the sandboxed React UI (no Node/Electron main-process APIs available at ' +
        'runtime). It must not import from src/main, which owns SQLite/IPC/native-addon code that ' +
        'cannot run in the renderer sandbox. Renderer talks to main only via the typed ' +
        'window.api.* preload bridge.',
      from: { path: '^src/renderer' },
      to: { path: '^src/main' }
    },
    // Shared (src/shared/**) is the single source of truth for IPC payload / DB record / draft
    // types, imported BY all three processes. It must stay a leaf: pure types/utilities with no
    // dependency back on any process-specific code, or it stops being safely shareable.
    {
      name: 'shared-not-to-main',
      severity: 'error',
      comment:
        'src/shared holds types/utilities imported by main, preload, and renderer alike. It must ' +
        'not import from src/main (Node/Electron-specific), or shared would no longer be safe to ' +
        'import from the renderer sandbox.',
      from: { path: '^src/shared' },
      to: { path: '^src/main' }
    },
    {
      name: 'shared-not-to-preload',
      severity: 'error',
      comment:
        'src/shared holds types/utilities imported by main, preload, and renderer alike. It must ' +
        'not import from src/preload, which is the typed window.api bridge glue, not a dependency ' +
        'shared code should ever need.',
      from: { path: '^src/shared' },
      to: { path: '^src/preload' }
    },
    {
      name: 'shared-not-to-renderer',
      severity: 'error',
      comment:
        'src/shared holds types/utilities imported by main, preload, and renderer alike. It must ' +
        'not import from src/renderer (browser/React-specific), or shared would no longer be safe ' +
        'to import from the Node-context main process.',
      from: { path: '^src/shared' },
      to: { path: '^src/renderer' }
    },
    // Preload (src/preload/**) is the typed window.api.* bridge exposed to the renderer via
    // contextBridge. It runs in a privileged-but-sandboxed context and must not depend on
    // renderer-only (React/DOM) code.
    {
      name: 'preload-not-to-renderer',
      severity: 'error',
      comment:
        'src/preload is the typed window.api.* bridge script exposed to the renderer via ' +
        'contextBridge. It must not import from src/renderer, which is browser/React UI code not ' +
        'available in the preload context.',
      from: { path: '^src/preload' },
      to: { path: '^src/renderer' }
    },

    {
      name: 'no-orphans',
      severity: 'info',
      comment:
        'This is an orphan module - it is likely not used (anymore?). Kept at info severity (non-' +
        'blocking) because knip already owns orphan/unused-file detection for this repo; this rule ' +
        'is here for visibility in the dependency graph only, not as a gate.',
      from: {
        orphan: true,
        pathNot: [
          '(^|/)[.][^/]+[.](?:js|cjs|mjs|ts|cts|mts|json)$', // dot files
          '[.]d[.]ts$', // TypeScript declaration files
          '(^|/)tsconfig[.]json$', // TypeScript config
          '(^|/)(?:babel|webpack|vite|electron[.]vite|electron-builder)[.]config[.](?:js|cjs|mjs|ts|cts|mts|json)$'
        ]
      },
      to: {}
    }
  ],
  options: {
    // Which modules not to follow further when encountered.
    doNotFollow: {
      path: ['node_modules']
    },

    // Which modules to exclude from the graph entirely.
    exclude: {
      path: [
        'node_modules',
        '(^|/)dist(/|$)',
        '(^|/)out(/|$)',
        '(^|/)build(/|$)',
        '(^|/)\\.claude(/|$)'
      ]
    },

    // TypeScript project file to use for compilation + resolution (paths/aliases).
    // tsconfig.web.json is the one that carries the compilerOptions.paths block covering
    // @renderer/*, @/*, and @shared/* (used throughout src/renderer/src/**). tsconfig.node.json
    // (main/preload/shared) has no paths block since main/preload only use relative imports.
    tsConfig: {
      fileName: 'tsconfig.web.json'
    },

    enhancedResolveOptions: {
      exportsFields: ['exports'],
      conditionNames: ['import', 'require', 'node', 'default', 'types']
    },

    skipAnalysisNotInRules: true
  }
}
