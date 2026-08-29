# Pillar

Pillar 是一个运行在终端中的 Code Agent，使用 Bun、TypeScript、React 和 Ink 构建。
项目目前处于早期开发阶段，接口和本地数据格式仍可能变化。

## 主要能力

- 交互式终端界面与 Headless 模式
- 文件搜索、读取、编辑和 Bash 工具
- 权限模式、操作审批与 OS Sandbox
- Session 恢复、Checkpoint 和代码回退
- 子 Agent、后台任务和 Git Worktree 隔离
- MCP、LSP、Skills、Hooks 和持久 Memory
- GLM、Qwen、DeepSeek 与 Jeniya OpenAI-compatible 中转

## 环境要求

- [Bun](https://bun.sh/) 1.1 或更高版本
- 至少一个受支持模型服务的 API Key

## 快速开始

```bash
bun install
cp .env.sample .env
bun run start
```

编辑 `.env`，选择主力与快速模型，并填写对应 Provider 的 API Key。

如需在任意目录通过 `pillar` 启动：

```bash
bun link
pillar
```

也可以执行一次 Headless 请求：

```bash
pillar -p "解释这个项目的结构"
```

使用 `pillar --help` 查看完整 CLI 参数。

## 配置与本地数据

Pillar 优先读取当前目录的 `.env`，找不到时读取 `~/.pillar/.env`。
项目会话、日志和其他运行数据保存在 `.pillar/`，这些内容默认不会进入 Git。

支持的凭证变量：

| Provider | API Key 变量 |
| --- | --- |
| GLM | `GLM_API_KEY` |
| Qwen | `DASHSCOPE_API_KEY` |
| DeepSeek | `DEEPSEEK_API_KEY` |
| Jeniya | `JENIYA_API_KEY` |

不要提交 `.env`、`.mcp.json` 或任何包含凭证和私人上下文的本地配置。

## 开发

```bash
bun run check
bun test
bun run verify
```

`bun run verify` 会运行完整测试和 TypeScript 检查。
