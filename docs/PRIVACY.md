# API Explorer Desktop Privacy Policy

Last updated: 2026-11-15

This policy describes what API Explorer Desktop stores and sends when you use it. API Explorer is a desktop application: it does not require an API Explorer account, provide a hosted workspace, or sync your workspace to a service operated by the project.

## Information stored on your computer

The app stores data in its per-user application data folder. Depending on the features you use, this can include:

- The last API snapshot and cached scan reports.
- Environment names and addresses, service address overrides, variables, payloads, collections, favourites, custom requests, and display preferences.
- Token type settings, generated API descriptions, scan rules, and GitHub scan caches.
- Repository files for GitHub projects you choose to clone and keep.

These files are not encrypted by API Explorer. In particular, token type settings and variables may contain credentials or other sensitive values. Protect your operating-system account and avoid saving secrets on a shared computer.

Access tokens entered for API requests and the Claude API key are held in memory while the app is open. They are not saved as API request values or as the Claude key. Token type configuration is saved locally and may include credentials. A workspace export can include token values only if you explicitly select that option; review exported files before sharing them.

Uninstalling the app may leave its per-user data behind. To remove the app's local data, close the app and delete its **API Explorer** application data folder: `%APPDATA%\API Explorer` on Windows or `~/Library/Application Support/API Explorer` on macOS. Also delete any exported files or kept repository clones you no longer want.

## Information sent when you use network features

API Explorer does not send workspace data to an API Explorer-operated service. Network requests are made for the features you choose to use:

- **Local scans:** Selected source files are read on your computer and are not uploaded by the scanner. If you later choose Claude documentation generation, only the contract facts described below are sent.
- **API and token requests:** When you send a request, the request address, method, headers, body, and any access token you use are sent over HTTPS to the enabled environment or service host you selected. The receiving API provider handles that information under its own policies. API Explorer checks the destination host against enabled environments and service overrides before sending.
- **GitHub scans:** The app contacts `api.github.com` and `raw.githubusercontent.com` to read repository listings and selected source files. If you provide a GitHub token, it is used for that scan and is not saved by API Explorer. GitHub handles the request and token under its own policies.
- **GitHub clones:** If you choose a clone workflow, Git uses HTTPS to contact GitHub. Authentication uses the Git credentials already configured on your computer or a token you provide for that operation. Cloned files are kept locally only when you choose to keep the clone.
- **Local model (Ollama):** Model prompts are sent to the Ollama service on this computer at a loopback address. API Explorer does not send those prompts to a remote model host.
- **Claude documentation:** If you select Claude for documentation generation, API Explorer sends the relevant contract facts and your documentation instructions to Anthropic's API. Facts can include API methods, paths, service/controller names, summaries, parameter names and types, version/status, and body/return type names. The documentation agent does not send full source files, request values, or access tokens. Anthropic processes API requests under its own terms and policies.

The app does not include advertising or analytics telemetry. This policy does not cover the separate services you choose to contact, your Git installation, or your operating system.

## Your choices and data

You choose whether to scan GitHub, clone repositories, send API requests, or use Claude. You can avoid remote model processing by using Ollama or not using model-assisted documentation. You can remove saved application data by deleting the local data folder as described above. Data already sent to GitHub, an API provider, or Anthropic is subject to that provider's policies and cannot be recalled by API Explorer.

For privacy questions or to report an issue, use the [project's GitHub Issues page](https://github.com/manasranjanmhnt/api-explorer/issues). Do not include credentials, access tokens, or private API data in a public issue.
