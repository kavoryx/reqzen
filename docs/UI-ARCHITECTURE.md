# UI architecture

The desktop renderer is authored in `ui/src/` with React and TypeScript. Vite builds the production renderer into `app/`, the directory loaded by Electron and included by the installers. The packaged app does not fetch remote scripts, fonts, icons, or other assets.

## Shared design system

`ui/src/styles.css` defines the shared light/dark palette, five accent colours, semantic status colours, typography, spacing, focus rings, radii, and elevation as CSS custom properties. The renderer uses system fonts and bundled CSS only. Controls and cards use compact spacing in the workspace; onboarding and dialogs have more generous spacing.

Semantic buttons, labelled inputs, visible keyboard focus, reduced-motion handling, and forced-colour focus treatment are shared across the views. HTTP method badges always retain their method text as well as a colour cue.

## Platform layer

The preload exposes the runtime platform as `window.desktop.platform` (`mac`, `win`, or `linux`). The renderer uses it for shortcut labels and platform-specific radii. Electron uses an inset title bar and native Settings menu item on macOS; Windows uses an overlay title bar, a hidden-until-Alt menu, and a Mica-capable window background. Interactive controls opt out of the draggable title-bar region.

The app remains a single renderer and keeps the existing `window.desktop` IPC bridge for file dialogs, scanning, settings, and checked API requests. The renderer does not send network requests directly. Request execution and destination checks remain in the Electron main process.

Electron loads the source-built renderer from `app/renderer/`.

## Navigation and shortcuts

The workspace provides Home, Catalog, Collections, and Settings navigation with the active section clearly marked. Home is available from the brand button and sidebar, including when a saved catalog is active. API search is available from the toolbar; the command palette finds views, operations, settings, and environments.

Status messages appear as semantic, colour-coded balloons at the top right and dismiss automatically; errors remain visible longer and any balloon pauses dismissal while focused or hovered. Documentation generation exposes Stop controls, and stopping aborts the active provider request while preserving completed chunks.

The API Catalog paginates filtered operations with selectable page sizes while keeping search and service filters deterministic. External documentation prompts copy the active source scan rules with the prompt, so another tool applies the same API-identification rules. Source scans derive operation summaries and descriptions from controller doc comments, Python docstrings, handler names, and route facts before optional AI enrichment; they do not require a model call to produce basic documentation.

Catalog columns expose pointer and keyboard resizers, while saved preferences retain the five core widths. Natural-language search and request-document parsing remain local-first: the **Open best match** workflow does not call a model, and **Apply document** only asks the configured planner when that feature is enabled. AI workflow policy is centralized in `lib/aiFeatures.js`, so new AI surfaces can add feature controls without changing the basic catalog or request workflow. Request planning never sends a request; users still review populated fields before sending.

| Action | macOS | Windows / Linux |
|---|---|---|
| Command palette | `⌘K` | `Ctrl+K` |
| Settings | `⌘,` | `Ctrl+,` |
| Find in page | `⌘F` | `Ctrl+F` |
| Send current request | `⌘Enter` | `Ctrl+Enter` |
| Close current panel | `Esc` | `Esc` |
| Navigate back | `⌥←` | `Alt+←` |

Use `npm run typecheck` and `npm run build` when changing the renderer. `npm start` and the installer scripts build the renderer automatically.
