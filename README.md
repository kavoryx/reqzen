# API Explorer Desktop

A desktop app for browsing API catalogs, configuring environments, and sending checked API requests.

## Run from source

Requirements: Node.js 22.12 or newer (64-bit) and npm.

```sh
npm ci
npm test
npm start
```

The compiled app UI is included in this repository; no separate frontend build is required.

## First use

1. Start the app and open an API snapshot file, or use the catalog scanner to create one from a project you can access.
2. Review the environments in the snapshot, or add your own under **Manage environments**.
3. Configure token types for the APIs you use. If a token endpoint uses a separate host, add that host as an enabled environment; then request the token while the API environment is selected.
4. Choose an API, environment, and token, review the request, then send it.

Requests are limited to HTTPS hosts listed by enabled environments (from the snapshot or added locally) or enabled service overrides. User-added environments are stored locally. Access tokens are held in memory while the app is open. Token type configuration is stored locally in plain text, so do not save credentials on a shared or untrusted computer.

## Platform guides

- [macOS setup, build, and signing](docs/MACOS.md)
- [Windows setup and build](docs/WINDOWS.md)

## Public repository hygiene

Do not commit API snapshots, exported workspaces, environment addresses, credentials, signing secrets, or local test output. The `.gitignore` excludes common generated and sensitive files; review every file before publishing.
