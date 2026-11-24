import type { sessionTools as zh } from '../zh-cn/sessionTools'

export const sessionTools: typeof zh = {
  exportMarkdown: 'Export as Markdown',
  exporting: 'Exporting…',
  longShot: 'Long screenshot…',
  longShotTitle: 'Capture from a chosen message to the bottom; copy to clipboard and optionally save as PNG',
  trace: 'Export diagnostics bundle',
  tracing: 'Packaging…',
  traceTitleDraft: 'Draft sessions are not persisted yet, so no diagnostics bundle can be exported',
  traceTitle: 'Export diagnostics data (saved locally only, never uploaded)',
  moveLabel: 'Move to workspace',
  moveTitleRunning: 'Generating — wait for the current round to finish before moving',
  moveTitle: (vars: { path: string }) =>
    `Move this session's on-disk records to ${vars.path}; it will run in that directory afterwards`,
  deleteTitle: 'Delete session (optionally including on-disk files)',
  delete: 'Delete session',
  exported: (vars: { path: string }) => `Exported to ${vars.path}`,
  failed: (vars: { message: string }) => `Export failed: ${vars.message}`,
  traceDone: (vars: { path: string }) => `Diagnostics bundle created: ${vars.path}`,
  unknownError: 'Unknown error',

  dir: {
    title: 'Choose a working directory',
    switchTitle: 'Switch working directory',
    empty: 'No recent directories — open another directory',
    browse: 'Add workspace…',
    browseOther: 'Open another directory…',
    current: 'Current'
  },

  /** WorkspaceToolsMenu: the "more" menu on a workspace row */
  workspace: {
    rename: 'Rename alias',
    renameTitle: 'Rename alias (double-click the name also works)',
    remove: 'Remove from list',
    removeTitle: 'Remove from the workspace list (on-disk data is unaffected)'
  }
}
