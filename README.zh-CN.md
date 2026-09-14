# Pillar

简体中文 | [English](README.md)

**在终端中完成开发任务的 Code Agent。**

用自然语言描述需求，Pillar 可以理解项目、修改代码、执行命令和测试，并根据结果继续推进任务。项目基于 TypeScript 构建，提供交互式终端、Headless CLI 和程序化 SDK。

项目仍在持续开发中，不同版本之间的 API、配置和会话存储格式可能变化。

## 核心能力

- **开发与修复：**检索和理解代码、精确修改文件、运行测试，并根据报错继续修复。
- **持续推进复杂任务：**管理任务进度，结合上下文压缩、历史检索和项目长期记忆保留必要信息。
- **分工与后台执行：**将子任务交给子 Agent，管理长时间运行的命令和后台任务。
- **控制执行边界：**区分规划与执行，提供权限审批策略及操作系统沙箱集成。
- **扩展工作方式：**接入 MCP、Skills、Hooks 和自定义 Agent；使用具备图片能力的模型理解本地图片输入。

## 快速开始

### 1. 准备环境

- [Bun](https://bun.sh/) **1.3 或更高版本**、Git 和 Bash。
- 至少一个可用的模型 API Key，且账号有权访问所选模型和接口。内置来源包括 **Qwen、GLM、DeepSeek 和 OpenRouter**；调用费用由你的模型服务账号承担。
- 沙箱依赖：macOS 需要 `ripgrep`；Linux 需要 `bubblewrap`、`socat` 和 `ripgrep`，系统还需允许沙箱使用用户命名空间。

可以通过包管理器安装沙箱依赖：

```bash
# macOS（Homebrew）
brew install ripgrep

# Ubuntu / Debian
sudo apt-get install bubblewrap socat ripgrep
```

下文命令使用 macOS/Linux Shell。原生 Windows 还需 Git Bash 及沙箱后端的 Windows 初始化配置，本指南暂不展开。

### 2. 下载并安装

```bash
git clone https://github.com/peihanm/pillar-core.git
cd pillar-core
bun install --frozen-lockfile
```

### 3. 启动并配置模型

```bash
bun run start
```

首次启动后，在终端内完成配置，不需要手写 JSON：

1. 输入 `/providers`，选择 Qwen、GLM、DeepSeek 或 OpenRouter。
2. 选择 **API key**，粘贴 Key 并保存。输入内容遮罩显示，不进入聊天记录。
3. 服务商已提供预置模型；需要其他模型时选 **Add model**，填写接口要求的模型 ID，展示名称可留空。
4. 返回后输入 `/model` 选择模型，选择会自动保存。

删除模型：在服务商页面选择 **Remove model**，选中条目并确认。Key 和接口地址保留；正在使用或配置中仍引用的模型需先改选。

没有任何可用模型时，启动会直接打开配置面板。Key、模型列表和接口地址通过面板保存后立即生效。默认只需要一个模型；未配置独立 `fast` 时，子任务的快速模型跟随当前主模型。

<details>
<summary>配置文件与高级用法</summary>

Key 默认保存在 `~/.pillar/.env`；若项目 `.env` 已定义同一个 Key，面板会更新该项目文件，并显示保存位置。CLI 优先保留进程环境变量，再读取项目 `.env`，最后用用户级 `.env` 补充缺失变量；不要求必须存在 `.env` 文件。

| 服务商 | Key 环境变量 |
| --- | --- |
| Qwen | `DASHSCOPE_API_KEY` |
| GLM | `GLM_API_KEY` |
| DeepSeek | `DEEPSEEK_API_KEY` |
| OpenRouter | `OPENROUTER_API_KEY` |

接口地址和模型列表保存在 `~/.pillar/settings.json`，可在 `/providers` 修改。`/model` 默认将选择保存到用户设置；若项目明确配置了主模型，则写入项目 `.pillar/settings.local.json`，不修改共享项目设置。显式启动参数仍具有最高优先级。

需要独立快速模型时，在 Settings 中配置完整的 `models.fast`，例如：

```json
{"models":{"fast":{"source":"deepseek","model":"deepseek-flash"}}}
```

删除 `fast` 项即可恢复跟随主模型；手动修改此项后重启。已启动子任务保持其模型和接口快照。模型 ID 必须由对应服务商提供；手动添加模型不等于自动支持它的图片、推理或工具调用协议。不会自动发送付费连通测试。

默认 Qwen 接口为 `https://trial.cn-beijing.maas.aliyuncs.com/compatible-mode/v1`；账号使用其他接口时，在 `/providers` 修改 API endpoint。Key 不要写入 Settings 或提交到 Git。

</details>

### 4. 开始使用

进入后可以直接输入：

> 看一下这个项目，介绍它的结构，并找出最值得优化的地方，先不要修改代码。

如果要在其他项目目录使用 Pillar，先在本仓库注册一次命令：

```bash
bun link
cd /path/to/your/project
pillar
```

确保 Bun 的全局可执行目录（通常是 `~/.bun/bin`）已加入 `PATH`。Pillar 会以启动命令时所在的目录作为工作目录。

在 `/providers` 保存到用户目录的 Key 可以跨项目复用。CLI 保留进程环境变量，加载项目 `.env` 后，再从 `~/.pillar/.env` 补充缺失变量。

## 日常使用

| 操作 | 命令或快捷键 |
| --- | --- |
| 查看命令 | `/help` |
| 选择并保存模型 | `/model` |
| 配置 Key、接口和模型列表 | `/providers` |
| 选择权限审批策略 | `/permissions` |
| 切换 Build / Plan | `Shift+Tab` |
| 恢复已保存的会话 | `/resume` |
| 查看后台任务 | `/tasks` |
| 停止当前任务 | `Esc` |

执行过程中可以继续补充要求。Pillar 会在当前一批工具执行完后，在安全边界将消息加入当前任务。

执行一次非交互任务，或查看 CLI 帮助：

```bash
pillar -p "解释这个项目的结构，不要修改文件。"
pillar --help
```

Headless 模式没有可点击的审批弹窗，无法处理的交互请求会被拒绝；无人值守运行前需明确配置允许的操作范围。

## 配置与本地数据

- `PILLAR.md` 用于编写项目指令。
- `~/.pillar/settings.json` 保存用户设置；项目中的 `.pillar/settings.json` 和 `.pillar/settings.local.json` 可以覆盖它。
- 会话、Memory、工具输出和请求日志保存在 `~/.pillar/projects/` 下。请求日志可能包含源码、对话和模型返回的思考，请勿将它们或 API Key 提交到公开仓库。
- `pillar --storage inspect` 查看存储占用；`pillar --storage preview` 预览清理范围，均不调用模型。

## 开发与验证

```bash
bun run check     # TypeScript 检查
bun test          # 离线自动化测试
bun run verify    # 测试、类型检查及 Node/Bun SDK 打包验证
```

`src/` 存放源码，`tests/` 存放自动化测试，`tooling/` 存放评测和构建辅助工具。程序化接入可参考 [SDK 示例](tooling/examples/sdk/run.ts)，通过 `bun run build:sdk` 在本地构建 SDK 包。
