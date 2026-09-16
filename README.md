# HiCode

English | [简体中文](README.zh-CN.md)

**Describe a development task. HiCode works on it in your terminal.**

HiCode is a coding agent built with TypeScript. It reads your project, edits files, runs commands and tests, and uses the results to continue working. Ask it to build a new project, fix a bug, or extend an existing application.

**Currently supports macOS only.** HiCode runs locally and connects to a model provider using your API key. No separate server deployment is needed.

## What you can do

- **Build from an idea:** describe a page, application, or small game and have HiCode create the files, implement it, and run checks.
- **Work on existing code:** investigate errors, fix bugs, add features, or review a project before making changes.
- **Continue longer tasks:** split work into subtasks, delegate to subagents, and use context management and project memory to carry work forward. You can add instructions while it runs.
- **Extend its capabilities:** connect tools through MCP, add Skills and Hooks, or provide screenshots to an image-capable model. A TypeScript SDK is also available for programmatic use.

## Install on macOS

Run this in your terminal:

```bash
curl -fsSL https://raw.githubusercontent.com/peihanm/hicode/main/install.sh -o hicode-install.sh && bash hicode-install.sh
```

The script downloads HiCode, reuses existing Bun and ripgrep installations or downloads their verified binaries, registers `hicode`, and configures PATH automatically. It requires no Homebrew, Node.js, or administrator password. Automatic shell setup supports zsh (the macOS default) and bash.

**After installation, open a new terminal**, enter your project directory, and start HiCode:

```bash
cd /path/to/your/project
hicode
```

You only install once. Run `hicode` from any project directory afterward; create an empty directory first if you want to build something new.

<details>
<summary>Already downloaded or cloned the repository?</summary>

Run the installer from your checkout:

```bash
bash install.sh
```

It uses your local source. The downloaded installer otherwise stores source at `~/.local/share/hicode/source`. Keep that source directory: the `hicode` command links to it. To repair setup, run `bash install.sh` from that source directory. Existing source is never automatically replaced.

</details>

## Configure a model

**Complete setup in the terminal UI. There is no need to create an `.env` file or edit JSON first.** When no models are available, HiCode opens provider setup automatically. You can also open it by entering `/providers` inside HiCode.

Supported providers are **Alibaba Bailian (Qwen), Zhipu GLM, DeepSeek, and OpenRouter**. Have an API key ready; usage is billed by your provider.

1. **Choose a provider.** Select the provider that issued your API key, such as **DeepSeek** or **Alibaba Bailian**.
2. **Save your key.** Open **API key**, paste the key, and press Enter. The input is masked.
3. **Check the endpoint.** Open **API endpoint** if your account uses a different API base URL. The key, endpoint, and model must belong to the same service.
4. **Choose a model.** Press Esc to leave setup, enter `/model`, and select a model you have access to. The selection is saved for future launches.

Use ↑/↓ to select, Enter to confirm, and Esc to go back in the setup panel.

**Model missing from the list?** Open `/providers`, choose its provider, and select **Add model**. Enter the exact **Model ID** expected by the API, then an optional **Display name**. Return to `/model` to select it. Adding a model uses that provider's existing adapter; it does not add support for an arbitrary API protocol.

**Using Qwen?** HiCode currently defaults to `https://trial.cn-beijing.maas.aliyuncs.com/compatible-mode/v1`. If your account uses a different endpoint, change **API endpoint** before sending a task. Preset models also require access through your account.

Keys are saved to `~/.hicode/.env` by default, and model configuration to `~/.hicode/settings.json`, so setup can be reused across projects. Existing project configuration can override these defaults: if the project's `.env` already contains the key variable, the panel updates that file and shows its location. Keep API keys out of Git.

## Give it a task

Once the model is selected, type what you want to accomplish:

> Inspect this project and explain how it works. Identify the most important improvements, but don't edit files yet.

Or ask it to make a concrete change:

> Fix the failing tests. Find the cause, update the implementation, and rerun the relevant tests. Summarize what changed.

HiCode works on files in the directory where you launched it. When an operation requires approval, it asks in the terminal. Available checks depend on your project's dependencies and connected tools; browser interaction requires a browser tool to be provided.
