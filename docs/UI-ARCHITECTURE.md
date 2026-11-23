# UI architecture

The desktop renderer is authored in `ui/src/` with React and TypeScript. Vite builds the production renderer into `app/`, the directory loaded by Electron and included by the installers. The packaged app does not fetch remote scripts, fonts, icons, or other assets.

## Shared design system

`ui/src/styles.css` defines the shared light/dark palette, five accent colours, semantic status colours, typography, spacing, focus rings, radii, and elevation as CSS custom properties. The renderer uses system fonts and bundled CSS only. Controls and cards use compact spacing in the workspace; onboarding and dialogs have more generous spacing.

Semantic buttons, labelled inputs, visible keyboard focus, reduced-motion handling, and forced-colour focus treatment are shared across the views. HTTP method badges always retain their method text as well as a colour cue.

## Platform layer

The preload exposes the runtime platform as `window.desktop.platform` (`mac`, `win`, or `linux`). The renderer uses it for shortcut labels and platform-specific radii. Electron uses an inset title bar and native Settings menu item on macOS; Windows uses an overlay title bar, a hidden-until-Alt menu, and a Mica-capable window background. Interactive controls opt out of the draggable title-bar region.

The app remains a single renderer and keeps the existing `window.desktop` IPC bridge for file dialogs, scanning, settings, and checked API requests. The renderer does not send network requests directly. Request execution and destination checks remain in the Electron main process.

The original compiled renderer is retained at `app/classic/` as a compatibility route while advanced workflows are migrated to source. Choose **More features · Classic workspace** in the modern toolbar menu to reach it; use **View → Modern workspace** (or `Ctrl/Cmd+Shift+R`) to return. Keep both entry points until token types, documentation generation, scan rules, snapshot comparison, and workspace import/export have source-renderer equivalents.

## Navigation and shortcuts

The workspace provides Catalog, Collections, and Settings navigation with the active section clearly marked. API search is available from the toolbar; the command palette finds operations, settings, and environments.

| Action | macOS | Windows / Linux |
|---|---|---|
| Command palette | `⌘K` | `Ctrl+K` |
| Settings | `⌘,` | `Ctrl+,` |
| Find in page | `⌘F` | `Ctrl+F` |
| Send current request | `⌘Enter` | `Ctrl+Enter` |
| Close current panel | `Esc` | `Esc` |
| Navigate back | `⌥←` | `Alt+←` |

Use `npm run typecheck` and `npm run build` when changing the renderer. `npm start` and the installer scripts build the renderer automatically.
