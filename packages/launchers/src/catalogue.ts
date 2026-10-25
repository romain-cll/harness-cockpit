export type AppKind = 'editor' | 'terminal';

export type AppId = 'vscode' | 'cursor' | 'zed' | 'terminal' | 'iterm2' | 'ghostty' | 'warp';

export interface App {
  id: AppId;
  name: string;
  kind: AppKind;
  /** The bundle's folder name, looked up in the applications folders. */
  bundle: string;
}

// Every fact below was checked on 2026-10-25 against the source named next to it. Each of the
// seven opens the folder (editors) or a shell in it (terminals) when launched with
// `open -a <bundle> <folder>`.

// Callers share one catalogue and none may change it for the others: it is frozen below.
const catalogue: App[] = [
  // Visual Studio Code 1.143.1: folder document type `public.folder`
  // (`microsoft/vscode`, `build/lib/electron.ts`).
  { id: 'vscode', name: 'Visual Studio Code', kind: 'editor', bundle: 'Visual Studio Code.app' },
  // Cursor 3.25.9: `CFBundleDocumentTypes` "Folder", `public.folder` (the app's `Info.plist`).
  { id: 'cursor', name: 'Cursor', kind: 'editor', bundle: 'Cursor.app' },
  // Zed 1.25.3: `public.folder`
  // (`zed-industries/zed`, `crates/zed/resources/info/DocumentTypes.plist`).
  { id: 'zed', name: 'Zed', kind: 'editor', bundle: 'Zed.app' },
  // Terminal 2.15, in `/System/Applications/Utilities`: `public.directory` (the app's `Info.plist`).
  { id: 'terminal', name: 'Terminal', kind: 'terminal', bundle: 'Terminal.app' },
  // iTerm2 3.7.6: `application:openFile:` gives a directory to a new session as its custom
  // initial directory (`gnachman/iTerm2`, `sources/AppKit/iTermApplicationDelegate.m`).
  { id: 'iterm2', name: 'iTerm2', kind: 'terminal', bundle: 'iTerm.app' },
  // Ghostty 1.3.1: `application(_:openFile:)` sets a directory as the new surface's
  // `workingDirectory` (`ghostty-org/ghostty` at `v1.3.1`,
  // `macos/Sources/App/macOS/AppDelegate.swift`; `public.directory` in `macos/Ghostty-Info.plist`).
  { id: 'ghostty', name: 'Ghostty', kind: 'terminal', bundle: 'Ghostty.app' },
  // Warp: "Drag and drop a folder or file onto the Warp dock icon to open a new tab in this
  // directory" (docs.warp.dev, Files, Links & Scripts). A dock drop and `open -a` send the same
  // Open Documents event; the client is closed source, so this rests on the docs.
  { id: 'warp', name: 'Warp', kind: 'terminal', bundle: 'Warp.app' },
];

for (const app of catalogue) Object.freeze(app);

export const apps: readonly App[] = Object.freeze(catalogue);
