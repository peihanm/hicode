# HiCode

[简体中文](README.md) | English

<p align="center">
  <img src="assets/images/hicode.gif" alt="HiCode particle wordmark animation" width="640">
  <br>
  <sub>One prompt. Built with HiCode × DeepSeek Flash.</sub>
</p>

## About

HiCode is a lightweight terminal coding agent built in TypeScript with its own execution framework and under 40,000 lines of core source code. Describe what you need in natural language, and it writes code, fixes issues, and runs tests.

Runs locally on **macOS, Linux, and Windows via WSL2**. Connect your own model API key to get started.

---

## 🚀 Public benchmarks · Key progress

### ⭐ Terminal-Bench 2.1

Evaluation completed on October 11, 2026.

1. HiCode: **83/89 (93.3%)** passed with original instructions; **85/89 (95.5%)** including two instruction clarifications. Models: Qwen3.8-Flash + DeepSeek V4.1 Flash.
2. [DeepSeek V4.1 Flash public reference](https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash#performance-across-agent-scaffolds-deepswe-v11-and-terminal-bench-21-max-reasoning-effort): pass rates of **84.1%, 88.0%, and 90.6%** with Codex, Claude Code, and DeepSeek Harness Minimal, respectively. Each task is evaluated independently three times, and the average pass rate is reported.
3. Other published references: [GPT-5.6 Sol + Codex](https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash#comparison-with-frontier-models-max-reasoning-effort) **88.8%**, [Kimi K3 + Kimi Code](https://www.kimi.com/en/blog/kimi-k3) **88.3%**, [GLM-5.3 + Claude Code](https://huggingface.co/zai-org/GLM-5.3) **88.2%**, and [Qwen3.8-Max + Claude Code](https://huggingface.co/Qwen/Qwen3.8-2.4T-A95B-FP8) **86.6%** (averaged over ten trials per task).

Evaluation notes: to control costs, HiCode counts each task as passed once it clears acceptance tests and stops retesting it. The average pass rate is expected to decrease slightly across independent repeat evaluations.

Instruction notes: two tasks had unclear output-format or behavior requirements, so their instructions were clarified. Acceptance tests remained unchanged.

### ⭐ DeepSWE 1.1

DeepSWE contains 113 original engineering tasks across 91 open-source repositories. Reference solutions add an average of **668 lines of code and modify 7.4 files**, emphasizing repository exploration and implementation across files. [Official statistics](https://arxiv.org/pdf/2607.07946#page=6)

🔥 Evaluation in progress.

1. HiCode: as of October 21, 2026, **95/113 (84.1%)** cumulative passes, using Qwen3.8-Flash, GLM 5.3 Flash, and DeepSeek V4.1 Flash.
2. [DeepSeek V4.1 Flash public reference](https://arxiv.org/html/2609.19969v1#S5.SS3.SSS4): pass rates of **65.6%, 69.8%, 74.2%, and 72.6%** with Codex, Claude Code, mini-SWE, and DeepSeek Harness Minimal, respectively. Reasoning effort is max, with eight independent trials per task and the average pass rate reported.
3. Other published references: [Kimi K3 + Kimi Code](https://www.kimi.com/en/blog/kimi-k3) **67.5%**, [GLM-5.3 + mini-SWE-agent](https://huggingface.co/zai-org/GLM-5.3) **66.9%**, [GLM-5.3-Flash + mini-SWE-agent](https://huggingface.co/zai-org/GLM-5.3-Flash) **63.4%**, and [Qwen3.8-Max + Claude Code](https://huggingface.co/Qwen/Qwen3.8-2.4T-A95B-FP8#benchmark-results) **56.6%**.

Evaluation notes: in the author's personal experience, DeepSWE 1.1 is significantly harder than Terminal-Bench 2.1, with **around 2.5 times** the average output token usage. To control costs, HiCode counts each task as passed once it clears acceptance tests and stops retesting it; independent repeat evaluations are expected to yield a noticeably lower average pass rate.

---

💰 **Evaluation funding**: all evaluations are personally funded by the project author. To manage costs, we start with lower-cost models and use DeepSeek V4.1 Flash for difficult tasks that repeatedly fail.

🎯 **Evaluation goals**: the primary goal is to expose problems through real tasks and continuously improve the HiCode harness. Pass rates serve mainly as an indirect indicator of HiCode's effectiveness.

Historical results: as of October 7, 2026, **39 Terminal-Bench 2.0 tasks** and **316 SWE-bench Verified tasks** passed.

---

## Features and interface

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

- 💻 **10-21 · WSL2 support**: HiCode now runs on Windows through WSL2.

- 🛠️ **10-17 · Execution framework improvements**: unified background subagent execution and result notifications, strengthened todo completion checks, and improved background reviews, request error recovery, and tool result presentation for more reliable execution of complex tasks.

- 🧠 **10-11 · Models and long-running tasks**: added reasoning-effort controls and reasoning replay across requests, and improved background reviews, web retrieval, and tool waits for more reliable execution of complex tasks.

- 🧱 **10-04 · Test environment isolation**: shared Linux base, reusable images by dependency version, and a separate container per task to reduce repeated setup and interference.

- 🛠️ **10-01 · Agent execution**: public benchmark findings drove unified background task queuing, status, and notifications, with continuation for long-running tasks and complete cleanup on cancellation or failure.

- 🐧 **09-26 · Linux support**: added Linux support with a unified installer for both platforms, improved sandbox isolation, and terminal display fixes.

- 🔌 **09-25 · MCP improvements**: simplified configuration and approvals, and improved tool loading, updates, and connection management for smoother integration into HiCode execution.

- 🌐 **09-21 · Network policy**: switch between open and restricted network modes via `/sandbox`, reducing network approval prompts while preserving filesystem isolation.

- 🔍 **09-20 · Tools and search**: simplified built-in tools and unified local search through Bash and ripgrep, reducing duplicate implementations and improving search efficiency.

- 🤝 **09-19 · Subagent collaboration**: improved task delegation and subagent spawning, along with parallel execution, two-way messaging, and context-preserving follow-ups.

## Quick start

Install or update from your macOS or Linux terminal. On Windows, run this command inside your WSL2 Linux terminal:

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

1. **Choose a provider**: Qwen Token Plan, Ark Agent Plan, DeepSeek, Zhipu GLM, OpenRouter, or Alibaba Bailian (Qwen).
2. **API key**: paste your key and press Enter to save.
3. **API endpoint**: if the default does not match your account, enter your provider’s API base URL.
4. **Choose model and start**: pick a model your account can access.

Model missing? Use **Add model** to enter its Model ID and an optional display name. Use `/providers` to change settings later.

**Qwen Token Plan** is a separate model source for Qwen 3.8 Flash and DeepSeek V4.1 Flash, with its own connection and API key distinct from regular Bailian. See [model settings](docs/reference/SETTINGS.md).

**Ark Token Plan (Agent Plan)** supports DeepSeek V4.1 Flash and GLM 5.3 Flash. Configure its dedicated key through `/providers` and select the model and reasoning effort through `/model`. Its connection and credentials are stored independently, with support for images, multi-turn tool calls, and reasoning replay. GLM 5.3 Flash always uses thinking and supports low/high/max effort.

Configuration is saved automatically and reusable across projects. Model usage is billed by your provider.

## Develop from source

To develop HiCode itself, install Git first. To test Linux on a Mac, you can use the optional [Ubuntu development container](.devcontainer/README.en.md).

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

For small daily changes, run `bun run verify:quick tests/unit/relevant-file.test.ts` for the relevant tests and TypeScript checks. Run the full `bun run verify` suite before pushing or releasing substantial changes; it includes all tests and SDK package verification and requires Node.js 22.12+.

To run public benchmark tasks with a live TUI and automatic grading, see [HiCode Eval](hicode-eval/README.en.md).

## Contributing

Join us in building HiCode—bug reports, ideas, and code contributions are all welcome.
