# Reqnara Desktop Privacy Policy

Last updated: 2026-11-16

This policy describes what Reqnara stores and sends when you use it. Reqnara is a desktop application: it does not require a Reqnara account, provide a hosted workspace, or sync your workspace to a service operated by the project.

## Information stored on your computer

The app stores data in its per-user application data folder. Depending on the features you use, this can include:

- The last API snapshot and cached scan reports.
- Environment names and addresses, service address overrides, variables, payloads, collections, favourites, custom requests, and display preferences.
- Token type settings, AI provider names and connection addresses, generated API descriptions, scan rules, and GitHub scan caches.
- Repository files for GitHub projects you choose to clone and keep.

These files are not encrypted by Reqnara. In particular, token type settings and variables may contain credentials or other sensitive values. Protect your operating-system account and avoid saving secrets on a shared computer.

Access tokens entered for API requests and AI provider API keys are held in memory while the app is open. AI provider keys are not saved to disk and must be entered again after restarting the app. Token type configuration is saved locally and may include credentials. A workspace export can include token values only if you explicitly select that option; review exported files before sharing them.

Uninstalling the app may leave its per-user data behind. To remove the app's local data, close the app and delete its existing **API Explorer** data folder: `%APPDATA%\API Explorer` on Windows or `~/Library/Application Support/API Explorer` on macOS. The folder name is retained for compatibility. Also delete any exported files or kept repository clones you no longer want.

## Information sent when you use network features

Reqnara does not send workspace data to a Reqnara-operated service. Network requests are made for the features you choose to use:

- **Local scans:** Selected source files are read on your computer and are not uploaded by the scanner. If you enable an AI feature, the relevant prompt data described below is sent to your selected provider.
- **API and token requests:** When you send a request, the request address, method, headers, body, and any access token you use are sent over HTTPS to the enabled environment or service host you selected. The receiving API provider handles that information under its own policies. Reqnara checks the destination host against enabled environments and service overrides before sending.
- **GitHub scans:** The app contacts `api.github.com` and `raw.githubusercontent.com` to read repository listings and selected source files. If you provide a GitHub token, it is used for that scan and is not saved by Reqnara. GitHub handles the request and token under its own policies.
- **GitHub clones:** If you choose a clone workflow, Git uses HTTPS to contact GitHub. Authentication uses the Git credentials already configured on your computer or a token you provide for that operation. Cloned files are kept locally only when you choose to keep the clone.
- **Local model (Ollama):** Model prompts are sent to the Ollama service on this computer at a loopback address. Reqnara does not send those prompts to a remote model host.
- **OpenAI-compatible provider:** In Settings, you can configure a local server or a remote service such as Groq. Reqnara sends prompts to the configured base URL. Prompts can include API methods, paths, summaries, parameter names and types, your search question or request description, and your AI instructions. Local processing depends on you configuring a local server; remote providers handle requests under their own terms and policies.
- **Claude API:** If you select Claude, Reqnara sends task-specific prompts to Anthropic's API. Prompts can include API contract facts, search questions, request descriptions, and your AI instructions. Anthropic processes API requests under its own terms and policies.

### Credential handling for AI

For all AI providers and agents, Reqnara redacts known API access tokens, `Authorization` values, saved sensitive variables, and common credential formats from system and user prompts immediately before sending them. This is intended to keep request credentials out of AI prompts whether the selected model is local or hosted. Reqnara does not intentionally send full source files.

AI provider keys are different from API access tokens: Claude or OpenAI-compatible provider keys are sent in the authentication header to the configured AI service so it can authorize the request. They are not put in the prompt and are held in memory for the current app session only. For a hosted service, that provider receives prompt content such as API contract facts and your questions. Redaction cannot identify every possible secret in arbitrary prose; do not place secrets in API descriptions, search questions, or custom AI instructions.

The app does not include advertising or analytics telemetry. This policy does not cover the separate services you choose to contact, your Git installation, or your operating system.

## Your choices and data

You choose whether to scan GitHub, clone repositories, send API requests, or use AI features. Use Ollama or a local OpenAI-compatible server to keep model prompts on this computer, or disable model-assisted features. You can remove saved application data by deleting the local data folder as described above. Data already sent to GitHub, an AI provider, an API provider, or Anthropic is subject to that provider's policies and cannot be recalled by Reqnara.

For privacy questions or to report an issue, use the [project's GitHub Issues page](https://github.com/manasranjanmhnt/api-explorer/issues). Do not include credentials, access tokens, or private API data in a public issue.
