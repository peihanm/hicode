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
- 至少一个可用的模型 API Key，且账号有权访问所选模型和接口。内置来源包括 **Qwen、GLM 和 DeepSeek**；调用费用由你的模型服务账号承担。
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
cp .env.sample .env
```

### 3. 配置模型

编辑 `.env`，填写你要使用的模型来源对应的 Key。默认使用 Qwen：

```dotenv
DASHSCOPE_API_KEY=your-api-key
```

当前内置主模型和快速模型均为 **`qwen3.8-flash`**，Qwen 默认接口为 **`https://trial.cn-beijing.maas.aliyuncs.com/compatible-mode/v1`**。你的账号需要具备该接口和模型的访问权限；如果账号使用其他接口或模型，请先调整配置再发送任务。

<details>
<summary>使用其他接口或模型</summary>

创建或编辑 `~/.pillar/settings.json`。下面以 Qwen 来源为例，替换接口地址和模型列表；请将两个占位值改为服务商实际支持的地址和模型 ID：

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

使用 GLM 或 DeepSeek 时，换成对应的来源名称和凭证变量：

| 来源 | API Key 环境变量 |
| --- | --- |
| `qwen` | `DASHSCOPE_API_KEY` |
| `glm` | `GLM_API_KEY` |
| `deepseek` | `DEEPSEEK_API_KEY` |

更换服务商时，同时配置 `primary` 和 `fast`；只切换主模型不会改变快速模型。Key 保存在 `.env`，不要写入 `settings.json`。

</details>

### 4. 启动

```bash
bun run start
```

进入后可以直接输入：

> 看一下这个项目，介绍它的结构，并找出最值得优化的地方，先不要修改代码。

如果要在其他项目目录使用 Pillar，先在本仓库注册一次命令：

```bash
bun link
cd /path/to/your/project
pillar
```

确保 Bun 的全局可执行目录（通常是 `~/.bun/bin`）已加入 `PATH`。Pillar 会以启动命令时所在的目录作为工作目录。

从其他项目启动时，需要在该项目的 `.env` 中配置 Key，或创建共用的 `~/.pillar/.env`。CLI 优先读取当前目录的 `.env`，只有该文件不存在时才读取用户级文件，两份文件不会合并。

## 日常使用

| 操作 | 命令或快捷键 |
| --- | --- |
| 查看命令 | `/help` |
| 选择主模型 | `/model` |
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
