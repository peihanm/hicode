# HiCode

[简体中文](README.md) | English

<p align="center">
  <img src="assets/images/hicode.gif" alt="HiCode particle wordmark animation" width="640">
  <br>
  <sub>One prompt. Built with HiCode × DeepSeek Flash.</sub>
</p>

## About

HiCode is a lightweight terminal coding agent built in TypeScript with its own execution framework and under 40,000 lines of core source code. Describe what you need in natural language, and it writes code, fixes issues, and runs tests.

Runs locally on **macOS and Linux**. Connect your own model API key to get started.

<table width="100%">
  <tr>
    <th width="43.3%">Welcome screen</th>
    <th width="56.7%">Task execution</th>
  </tr>
  <tr>
    <td width="43.3%" valign="top"><img src="assets/images/img1.png" alt="HiCode welcome screen" width="100%"></td>
    <td width="56.7%" valign="top"><img src="assets/images/img2.png" alt="HiCode inspecting code, running tests, and reporting results" width="100%"></td>
  </tr>
</table>

- **Build and maintain**: create projects from scratch, or review, fix, and extend existing code.
- **Handle longer tasks**: subagent collaboration, context management, project memory, and instructions during execution.
- **Extend capabilities**: MCP, Skills, Hooks, image input with supported models, and a TypeScript SDK.

### Recent improvements

- 🐧 **09-26 · Linux support**: added Linux support with a unified installer for both platforms, improved sandbox isolation, and terminal display fixes.

- 🔌 **09-25 · MCP improvements**: simplified configuration and approvals, and improved tool loading, updates, and connection management for smoother integration into HiCode execution.

- 🌐 **09-21 · Network policy**: switch between open and restricted network modes via `/sandbox`, reducing network approval prompts while preserving filesystem isolation.

- 🔍 **09-20 · Tools and search**: simplified built-in tools and unified local search through Bash and ripgrep, reducing duplicate implementations and improving search efficiency.

- 🤝 **09-19 · Subagent collaboration**: improved task delegation and subagent spawning, along with parallel execution, two-way messaging, and context-preserving follow-ups.

### TODO

- [ ] Build a test dataset and improve HiCode's capabilities through automated evaluations.

## Quick start

Install or update from your macOS or Linux terminal:

```bash
curl -fsSL https://raw.githubusercontent.com/peihanm/hicode/main/install.sh -o hicode-install.sh && bash hicode-install.sh
```

The installer detects your system, downloads the required dependencies, and configures `hicode` for zsh/bash.

**Updating:** exit HiCode and rerun the command above. The installer switches only after the new version passes its startup check, then removes old installed versions. Your model configuration and history are preserved.

After installation, **open a new terminal** and enter the project you want to work on:

```bash
cd /path/to/your/project
hicode
```

Run `hicode` from any project directory afterward. First launch opens model setup:

1. **Choose a provider**: Alibaba Bailian (Qwen), Zhipu GLM, DeepSeek, or OpenRouter.
2. **API key**: paste your key and press Enter to save.
3. **API endpoint**: if the default does not match your account, enter your provider’s API base URL.
4. **Choose model and start**: pick a model your account can access.

Model missing? Use **Add model** to enter its Model ID and an optional display name. Use `/providers` to change settings later.

Configuration is saved automatically and reusable across projects. Model usage is billed by your provider.

## Develop from source

To develop HiCode itself, install Git first. To test Linux on a Mac, you can use the optional [Ubuntu development container](.devcontainer/README.md).

```bash
git clone https://github.com/peihanm/hicode.git
cd hicode
bash install.sh
```

The script points `hicode` to this checkout, replacing any launcher from a previous script installation. **Keep this directory in place.**

Open a new terminal, return to the checkout, and install development dependencies:

```bash
bun install --frozen-lockfile
hicode
```

Restart after editing source. Running `hicode` from another project directory also uses this checkout.

Validate changes:

```bash
bun test          # Automated tests
bun run check     # TypeScript checks
```

Full validation: `bun run verify` adds SDK package verification and requires Node.js 22.12+.

## Contributing

Join us in building HiCode—bug reports, ideas, and code contributions are all welcome.
