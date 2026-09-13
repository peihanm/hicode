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
- An API key with access to your chosen model and endpoint. Built-in sources are **Qwen, GLM, and DeepSeek**; model calls use your provider account.
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
cp .env.sample .env
```

### 3. Configure a model

Edit `.env` and fill in the key for the source you intend to use. For the default Qwen configuration:

```dotenv
DASHSCOPE_API_KEY=your-api-key
```

The current defaults use **`qwen3.8-flash`** for both the main and fast models, with the Qwen endpoint **`https://trial.cn-beijing.maas.aliyuncs.com/compatible-mode/v1`**. Your account must have access to this endpoint and model. If your account uses another endpoint or model, configure it before submitting a task.

<details>
<summary>Use another endpoint or model</summary>

Create or edit `~/.pillar/settings.json`. This example keeps the Qwen source and replaces its endpoint and model list; replace both placeholders with values supported by your provider:

```json
{
  "sources": {
    "qwen": {
      "baseUrl": "https://your-api-host.example/compatible-mode/v1",
      "models": [{"id": "your-model-id", "label": "My model"}]
    }
  },
  "models": {
    "primary": {"source": "qwen", "model": "your-model-id"},
    "fast": {"source": "qwen", "model": "your-model-id"}
  }
}
```

For GLM or DeepSeek, use the corresponding source name and credential variable:

| Source | API key variable |
| --- | --- |
| `qwen` | `DASHSCOPE_API_KEY` |
| `glm` | `GLM_API_KEY` |
| `deepseek` | `DEEPSEEK_API_KEY` |

Configure both `primary` and `fast` when changing providers; switching the main model alone does not change the fast model. Keep keys in `.env`, not in `settings.json`.

</details>

### 4. Start Pillar

```bash
bun run start
```

For example, ask:

> Inspect this project, explain its structure, and identify the most important improvements. Do not edit files yet.

To use Pillar in another project, register the local executable once from this checkout:

```bash
bun link
cd /path/to/your/project
pillar
```

Make sure Bun's global executable directory (usually `~/.bun/bin`) is on your `PATH`. Pillar works in the directory where you launch it.

When launching from another project, place its key configuration in that project's `.env`, or create a shared `~/.pillar/.env`. The CLI reads the current directory's `.env` first and only falls back to `~/.pillar/.env` when no local file exists; the files are not merged.

## Everyday use

| Action | Command or shortcut |
| --- | --- |
| View commands | `/help` |
| Choose the main model | `/model` |
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
