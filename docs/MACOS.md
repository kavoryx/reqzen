# macOS guide

## Run the app from source

Use a Mac with Node.js 22.12 or newer and npm. From the repository directory:

```sh
npm ci
npm test
npm start
```

No separate frontend build is needed; the app UI is included.

## Build an unsigned disk image

```sh
npm run dist:mac
```

The disk image is written to `release/`. The build is unsigned. On first launch, macOS may block it; use Finder's **Open** command from the app's context menu, then confirm. Only install builds from a source you trust.

## Build a signed and notarized disk image

This requires an Apple Developer ID certificate available in the login keychain and an app-specific password. Keep the signing credentials out of the repository and enter them only in your shell:

```sh
export CSC_NAME="Developer ID Application: Your Name (TEAMID)"
export APPLE_ID="you@example.com"
export APPLE_TEAM_ID="TEAMID"
read -s APPLE_APP_SPECIFIC_PASSWORD
export APPLE_APP_SPECIFIC_PASSWORD
npm run dist:mac-signed
```

Enter your own app-specific password when prompted, then run `unset APPLE_APP_SPECIFIC_PASSWORD` after the build. Do not save signing credentials in the repository or shell profile.

## Optional local model

Install Ollama using its official macOS installer, then run:

```sh
ollama pull qwen2.5:3b
ollama serve
```

Search works without Ollama; model-assisted ranking and description filling require it.
