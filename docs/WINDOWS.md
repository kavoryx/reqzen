# Windows guide

## Run the app from source

Use a 64-bit Windows 10 or 11 computer with Node.js 22.12 or newer and npm. Open PowerShell in the repository directory:

```powershell
npm ci
npm test
npm start
```

No separate frontend build is needed; the app UI is included. Git is only needed for features that clone repositories.

## Build a Windows installer

From PowerShell in the repository directory:

```powershell
npm run dist:win
```

The NSIS installer is written to `release/`. It is unsigned and the app executable is not resource-edited during packaging; Windows SmartScreen may show a warning. Only run installers you built yourself or obtained from a source you trust.

## Optional local model

Install Ollama using its official Windows installer, then run these commands in PowerShell:

```powershell
ollama pull qwen2.5:3b
ollama serve
```

Search works without Ollama; model-assisted ranking and description filling require it.
