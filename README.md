# Pillar

[简体中文](README.zh-CN.md) | English

**A coding agent that works in your terminal.**

Describe a task in plain language. Pillar can explore a codebase, edit files, run commands and tests, and use the results to continue working. It is built with TypeScript and provides an interactive terminal interface, a headless CLI, and a programmatic SDK.

Pillar is under active development. APIs, configuration, and stored session formats may change between versions.

## What it can do

- **Build and fix projects:** search and understand code, make targeted edits, run tests, and work through failures.
- **Continue complex tasks:** manage progress, compact context, retrieve earlier conversation details, and retain project memory across sessions.
- **Delegate and run background work:** assign subtasks to child agents and manage long-running commands from the terminal.
- **Control execution:** separate planning from execution, with configurable approval policies and OS sandbox integration.
- **Extend the workflow:** connect MCP servers, add Skills and Hooks, define custom agents, and inspect local image inputs with a compatible model.

## Quick start

### 1. Prepare your environment

- [Bun](https://bun.sh/) **1.3 or newer**, Git, and Bash.
- An API key with access to your chosen model and endpoint. Built-in sources are **Qwen, GLM, DeepSeek, and OpenRouter**; model calls use your provider account.
- Sandbox dependencies: `ripgrep` on macOS; `bubblewrap`, `socat`, and `ripgrep` on Linux. Linux must also permit the user namespaces needed by the sandbox.

For example, install the sandbox dependencies with your package manager:

```bash
# macOS (Homebrew)
brew install ripgrep

# Ubuntu / Debian
sudo apt-get install bubblewrap socat ripgrep
```

The commands below use a macOS/Linux shell. Native Windows additionally requires Git Bash and the sandbox backend's Windows setup; this guide does not cover that setup.

### 2. Download and install

```bash
git clone https://github.com/peihanm/pillar-core.git
cd pillar-core
bun install --frozen-lockfile
```

### 3. Start and configure a model

```bash
bun run start
```

Set up access inside the terminal; no JSON editing is required:

1. Open `/providers` and select Qwen, GLM, DeepSeek, or OpenRouter.
2. Choose **API key**, paste your key, and save. Input is masked and never added to the conversation.
3. Use a preset model, or choose **Add model** and enter its API model ID. The display name is optional.
4. Return to `/model` and select a model. Your selection is saved automatically.

To delete a model, choose **Remove model** on the provider page and confirm the entry. The key and endpoint are kept. Switch away from a model first if it is selected or still referenced by model settings.

With no available models, startup opens provider setup. Keys, model lists, and endpoints saved through the panel take effect immediately. One model is enough: unless an independent `fast` target is configured, fast tasks follow the current main model.

<details>
<summary>Configuration files and advanced usage</summary>

Keys are saved to `~/.pillar/.env` by default. If the project `.env` already defines the same key, the panel updates that file and shows the destination. Existing process environment values take precedence, followed by project `.env` values and then missing values from the user `.env`. An `.env` file is not required.

| Provider | Credential variable |
| --- | --- |
| Qwen | `DASHSCOPE_API_KEY` |
| GLM | `GLM_API_KEY` |
| DeepSeek | `DEEPSEEK_API_KEY` |
| OpenRouter | `OPENROUTER_API_KEY` |

`/providers` saves endpoints and model lists in `~/.pillar/settings.json`. `/model` saves the selected model there unless the project explicitly overrides it; in that case, it writes `.pillar/settings.local.json` without changing shared project settings. Explicit CLI arguments still take precedence at startup.

To use a separate fast model, configure a complete `models.fast` target:

```json
{"models":{"fast":{"source":"deepseek","model":"deepseek-flash"}}}
```

Remove `fast` to follow the main model again; restart after changing that setting manually. Existing child agents retain their model and endpoint snapshot. A model ID must be offered by the selected provider; adding an ID does not automatically adapt image, reasoning, or tool-calling protocols. Setup does not make paid test requests.

The default Qwen endpoint is `https://trial.cn-beijing.maas.aliyuncs.com/compatible-mode/v1`. Change **API endpoint** in `/providers` when your account uses another endpoint. Do not put keys in Settings or commit them to Git.

</details>

### 4. Start working

For example, ask:

> Inspect this project, explain its structure, and identify the most important improvements. Do not edit files yet.

To use Pillar in another project, register the local executable once from this checkout:

```bash
bun link
cd /path/to/your/project
pillar
```

Make sure Bun's global executable directory (usually `~/.bun/bin`) is on your `PATH`. Pillar works in the directory where you launch it.

User-level keys saved through `/providers` work across projects. The CLI preserves process environment values, loads the project `.env`, and fills missing variables from `~/.pillar/.env`.

## Everyday use

| Action | Command or shortcut |
| --- | --- |
| View commands | `/help` |
| Select and save a model | `/model` |
| Configure keys, endpoints and model lists | `/providers` |
| Choose an approval policy | `/permissions` |
| Switch between Build and Plan | `Shift+Tab` |
| Resume a saved session | `/resume` |
| Inspect background tasks | `/tasks` |
| Stop the current task | `Esc` |

You can send additional instructions while Pillar is working. They are added to the current task at a safe boundary after the current tool batch finishes.

For a non-interactive task or CLI help:

```bash
pillar -p "Explain this project's structure. Do not modify files."
pillar --help
```

Headless runs cannot ask you to click an approval dialog; actions requiring an unhandled interaction are denied. Select permissions deliberately for unattended work.

## Configuration and local data

- `PILLAR.md` supplies project instructions.
- `~/.pillar/settings.json` holds user settings; project `.pillar/settings.json` and `.pillar/settings.local.json` can override them.
- Sessions, memory, tool outputs, and request logs live under `~/.pillar/projects/`. Request logs can contain source code, conversation text, and reasoning returned by the model; keep these and API keys out of public commits.
- `pillar --storage inspect` shows local storage usage; `pillar --storage preview` previews cleanup. Neither command calls a model.

## Development

```bash
bun run check     # TypeScript checks
bun test          # Offline automated tests
bun run verify    # Tests, type checks, and Node/Bun SDK package verification
```

Source lives in `src/`, automated tests in `tests/`, and evaluation/build utilities in `tooling/`. For programmatic integration, see the [SDK example](tooling/examples/sdk/run.ts); `bun run build:sdk` builds the SDK package locally.
