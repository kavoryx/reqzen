# Reqnara Desktop

Scan API source code into a browsable, searchable catalog, then configure environments and send reviewed API requests from a native desktop app. Reqnara is a local-first developer tool for understanding and working with APIs without setting up a hosted service.

## Download and install (no developer tools required)

**The public [GitHub Releases page](https://github.com/manasranjanmhnt/api-explorer/releases) does not have a published installer yet.** Once a version tag is pushed, the release workflow in this repository builds and attaches the Windows installer and macOS disk images. Check the Releases page for the first available version; do not download files from unofficial mirrors.

After a release is published:

### Windows 10/11 (64-bit)

1. Download the `Reqnara-<version>-x64.exe` installer from the release.
2. Open the installer and follow its prompts.
3. Launch **Reqnara** from the Start menu.

The installer includes the app and its runtime. You do **not** need Node.js, npm, Git, Python, or a separate frontend to install or run the desktop app. The installer is unsigned, so Windows SmartScreen may warn you; continue only if you trust the downloaded release.

### macOS (Apple silicon or Intel)

1. Download the disk image matching your Mac: `arm64` for Apple silicon, or `x64` for Intel.
2. Open the `.dmg` and drag **Reqnara** to **Applications**.
3. Open the app from Applications.

The app and its runtime are bundled; you do **not** need Node.js, npm, Git, Python, or a separate frontend to install or run it. Unsigned builds may be blocked on first launch. In Finder, Control-click the app, choose **Open**, and confirm only if you trust the release.

If there is no release yet, the installers have not been published; see the source-build instructions below. The GitHub Actions release workflow is triggered by pushing a version tag such as `v0.2.1`. It runs the tests and creates Windows x64, macOS x64, and macOS arm64 packages. The macOS packages are unsigned and not notarized.

## What you can do

- **Discover APIs from code:** find projects in local folders or GitHub repositories, scan selected sources, and export the resulting API catalog as a snapshot.
- **Scan common frameworks:** Spring Boot (Java), NestJS and Express-style routes (JavaScript/TypeScript), and FastAPI and Flask route decorators (Python). Custom annotation/decorator rules let you adapt the scanner to other supported source patterns.
- **Search and inspect a catalog:** browse services and operations, review methods, paths, parameters, descriptions, and available contract details, and use optional model assistance to rank search results.
- **Prepare and send requests:** fill path, query, header, and body values; manage environments, service addresses, tokens, token-fetch configurations, variables, and reusable payloads.
- **Keep reusable work:** save custom requests, favourites, and API collections; import or export collections and workspaces; export collections in Postman v2.1 format.
- **Generate API documentation:** create API descriptions and service overviews from contract facts using a local Ollama model or, if configured, the Claude API.
- **Choose how the app looks:** use system, light, or dark appearance, select a colour palette, and adjust API-list display preferences.

Scanning is static rather than running the application. Dynamically assembled routes, framework-specific router mounting, and unsupported conventions may not be found; review the scan report and catalog before relying on them.

## First launch: set up and use the app

1. **Start where you like.** Open a compatible catalog snapshot, scan a local source or GitHub repository, or create a custom request. A catalog is optional. If scanning GitHub, provide a token only when required for repository access or rate limits.
2. **Set up an environment when you are ready to send.** Add one under **Settings → Environments**, or use environments included with a snapshot. Give it a clear name and an HTTPS base address. Requests are limited to hosts in enabled environments; add a separate environment if a token endpoint uses another host.
3. **Configure authentication.** Enter an access token for the current session, set up a token type, or use a custom request’s supported authorization options. A token type can use a catalog API or a manually configured HTTPS token request.
4. **Select and review a request.** Browse catalog operations or create a custom request, choose an environment, and review the complete request before sending. Write operations or production environments may require additional confirmation.
5. **Save or share useful work.** Favourite APIs, organize them into collections, save a custom request, or export a collection/workspace when you need to reuse or share it.

### Request safety and local data

Requests must use HTTPS and a host allowed by an enabled environment or service override. The app checks requests before sending them and may require confirmation for write operations, production use, or incomplete API contracts. It does not send requests automatically.

Environments, variables, collections, preferences, and other workspace settings are stored on this computer. Access tokens entered for API requests stay in memory while the app is open. Token-type configuration and other locally saved settings may contain sensitive values and are stored in local files; avoid configuring secrets on shared computers and protect your operating-system account. Exported workspaces and collections may contain project information—review files before sharing them.

See the [Privacy Policy](docs/PRIVACY.md) for details about local storage, API requests, GitHub scans, and optional model providers.

## Optional integrations

- **Git:** install Git if you use repository-cloning workflows. Local-folder scanning does not need Git. GitHub API scanning needs an internet connection; private repositories require appropriate access.
- **Ollama:** install Ollama and download `qwen2.5:3b` if you want local model-assisted search and documentation generation. Basic catalog browsing, scanning, and requests do not need a model.
- **Claude API:** optional; configure a Claude API key in the documentation settings to generate documentation with Claude instead of a local model. The key is held for the current app session and is not saved by the app.

## For developers: run from source

### Requirements

- Node.js 22.12 or newer and npm.
- Windows 10/11 64-bit to build the Windows installer.
- macOS to build a macOS disk image. Build x64 on an Intel Mac or arm64 on an Apple-silicon Mac; the release workflow builds both.
- Git only for workflows that clone GitHub repositories. Local-folder scanning does not require Git.

The compiled app UI is included; no separate frontend build is required. You do not need Python, Java, or any of the scanned languages installed to run the app. A scanned project's dependencies do not need to be installed because scanning reads source files statically.

### Clone, install dependencies, test, and run

Open PowerShell on Windows or Terminal on macOS:

```sh
git clone https://github.com/manasranjanmhnt/api-explorer.git
cd api-explorer
npm ci
npm test
npm start
```

Run npm commands from the repository root (the directory containing `package.json`). `npm ci` installs the locked development dependencies; `npm test` runs the automated test suite; `npm start` launches the app from source.

### Build a Windows installer

Build on Windows, from PowerShell in the repository root:

```powershell
npm ci
npm test
npm run dist:win
```

The installer is written to `release\`; for version 0.2.1 the file is `Reqnara-0.2.1-x64.exe`. The installer is unsigned, and executable signing/resource editing is disabled during packaging. Build Windows packages on Windows rather than relying on cross-platform packaging.

### Build macOS disk images

Build on a Mac, from Terminal in the repository root:

```sh
npm ci
npm test
npm run dist:mac
```

The `.dmg` is written to `release/` and targets the Mac's architecture. To build the other architecture too, run `npm run dist:mac -- --x64` or `npm run dist:mac -- --arm64`. Both architectures are built in the release workflow. The packages are unsigned and not notarized.

For signed and notarized distribution, an Apple Developer ID Application certificate and app-specific password are required. See the [macOS build and signing guide](docs/MACOS.md); never commit signing credentials or store them in project files.

## Product highlights

Reqnara brings source discovery, API catalog browsing, environment setup, and controlled request execution together in one desktop workflow. It is designed for developers who need to understand an existing service, compare APIs across environments, prepare repeatable requests, or create useful API documentation from source-derived contracts.

- **From source to usable catalog:** discover endpoints without first deploying or running the application.
- **A focused, local-first desktop workflow:** workspace data stays on the user's computer; there is no Reqnara account or hosted catalog service.
- **Safety-conscious requests:** enabled HTTPS host allow-listing and explicit confirmation gates help users review potentially consequential calls.
- **Flexible handoff:** export collections in Postman v2.1 format or share Reqnara workspace and catalog files.
- **Useful without AI:** scanning, catalog browsing, and request execution do not require Ollama or Claude.

For repository descriptions, release notes, or search tags, use accurate terms such as **API catalog**, **API explorer**, **API client**, **source code scanner**, **API documentation**, **Spring Boot**, **NestJS**, **Express**, **FastAPI**, **Flask**, **Postman collection**, and **Electron desktop app**. Avoid claims that the scanner supports every language/framework or that generated documentation replaces review.

## Platform guides

- [Windows setup and build](docs/WINDOWS.md)
- [macOS setup, build, and signing](docs/MACOS.md)
- [Privacy Policy](docs/PRIVACY.md)

## License

The code in this repository is licensed under the [MIT License](LICENSE). Third-party dependencies and bundled components remain subject to their own licenses.

## Public repository hygiene

Do not commit API snapshots, exported workspaces, environment addresses, credentials, signing secrets, or local test output. The `.gitignore` excludes common generated and sensitive files; review every file before publishing.
