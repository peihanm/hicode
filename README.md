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
- GLM、Qwen 与 DeepSeek Provider

## 环境要求

- [Bun](https://bun.sh/) 1.3 或更高版本
- 至少一个受支持模型服务的 API Key

## 快速开始

```bash
bun install
bun run start
```

内置 primary/fast 默认使用 Qwen 3.6 Flash。复制 `.env.sample` 为 `.env` 并填写对应凭证；需要使用
GLM、DeepSeek 或其他已登记模型时，在 `~/.pillar/settings.json` 中选择模型。

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
项目 `.pillar/` 只保存可声明的 Settings、MCP、LSP、Skills、Agent 和 Hook 配置；Session、Checkpoint、
Tool Result、后台任务日志和 Prompt Log 等运行数据统一保存在 `~/.pillar/projects/<project-key>/`。

支持的凭证变量：

| Provider | API Key 变量 |
| --- | --- |
| GLM | `GLM_API_KEY` |
| Qwen | `DASHSCOPE_API_KEY` |
| DeepSeek | `DEEPSEEK_API_KEY` |

不要提交 `.env`、`.mcp.json` 或任何包含凭证和私人上下文的本地配置。

## 开发

```bash
bun run check
bun test
bun run verify
```

`bun run verify` 会运行完整测试和 TypeScript 检查。

## 仓库结构

```text
src/             产品源码
tests/           离线、确定性的自动化测试
tooling/         不进入产品运行时的开发辅助内容
  evals/         显式调用真实模型的隔离评测，不进入默认测试
  examples/      公共 SDK 的可运行示例
  scripts/       构建、审计和发布前验证脚本
docs/reference/  当前架构与行为的唯一文档真相源
```

`tooling/` 中的内容都有 package script 或测试调用方，不是生成目录。可删除并重建的
SDK 构建产物统一写入被 Git 忽略的 `dist/`。文档从 [reference 索引](docs/reference/README.md) 开始阅读。

### 冗余代码审计

生产代码、产品测试和开发工具使用独立的 TypeScript 配置。下面的命令会在排除测试入口后检查无生产消费者的文件、导出和类型，并补充检查仅被测试引用的生产 API：

```bash
bun run audit:unused
```

报告默认不修改文件，也不会让 CI 失败。`TEST_ONLY_EXPORT` 表示对应实现可能仍被定义文件内部使用，但它的 `export` 目前只服务于测试；应先让测试经过真实生产边界，再决定删除导出还是整个实现。

字段和方法的静态归属存在不确定性。需要查看包含同名属性歧义项的完整候选时运行：

```bash
bun run audit:test-only-members
```

清理并建立基线后，可以用 `bun run check:dead-code` 和 `bun run check:test-only-api` 作为严格检查；它们在发现候选时返回非零退出码。
