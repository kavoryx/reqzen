# Build and run on Windows

## Prerequisites

- 64-bit Windows 10 or Windows 11.
- Node.js 22.12 or newer with npm.
- Git only if you need to scan or clone GitHub repositories.

Check the installed tools in PowerShell:

```powershell
node --version
npm --version
git --version
```

The Git check is optional. If Node.js was installed while PowerShell was open, close and reopen PowerShell before continuing.

## Get the project

Clone the public repository and enter its folder:

```powershell
git clone https://github.com/manasranjanmhnt/api-explorer.git
Set-Location .\api-explorer
```

For an existing checkout, use `Set-Location` with that repository's path instead. All following commands must run in the directory containing `package.json`.

## Install, test, and run from source

Install the exact dependency versions in the lock file, run the tests, then launch the desktop app:

```powershell
npm ci
npm test
npm start
```

The app's compiled UI is already included; there is no separate frontend build step.

## Create the Windows installer

Close the running app, then run:

```powershell
npm run dist:win
```

The NSIS installer is written to `release\`. For version 0.2.1, the output is `release\API-Explorer-0.2.1-x64.exe`. Run the `.exe` to install the app.

The installer is unsigned, and executable signing/resource editing is disabled during packaging. Windows SmartScreen may display a warning. Only run an installer you built yourself or obtained from a source you trust. The `release\` folder is generated output and is excluded from Git.

Build the Windows installer on Windows. The Windows and macOS packages are built separately on their respective platforms.

## Optional: local model support

Install Ollama using its official Windows installer. In PowerShell, download the model and start the local service:

```powershell
ollama pull qwen2.5:3b
ollama serve
```

Basic search and scanning do not require Ollama. Model-assisted ranking and description filling do.
