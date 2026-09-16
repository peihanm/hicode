# HiCode

简体中文 | [English](README.en.md)

**用自然语言描述开发任务，让 HiCode 在终端里帮你完成。**

HiCode 是一个基于 TypeScript 开发的 Code Agent。它可以读取项目、修改文件、执行命令和测试，并根据结果继续推进任务。你可以让它从零搭建项目，也可以让它修复 Bug、为已有应用增加功能。

**目前仅支持 macOS。** HiCode 在本机运行，通过你的 API Key 调用模型服务，无需额外部署服务端。

## 能做什么

- **从想法到项目：**描述一个页面、应用或小游戏，让 HiCode 创建文件、编写功能并运行检查。
- **维护已有代码：**排查报错、修复 Bug、添加功能，或先审查项目再决定如何修改。
- **持续推进长任务：**拆分任务、交给子 Agent 协作，通过上下文管理和项目记忆衔接后续工作。执行期间也可以继续补充要求。
- **扩展能力：**通过 MCP 接入工具，添加 Skills 和 Hooks，或使用支持图片的模型理解截图。也提供 TypeScript SDK，方便程序调用。

## 在 macOS 上安装

在终端执行：

```bash
curl -fsSL https://raw.githubusercontent.com/peihanm/hicode/main/install.sh -o hicode-install.sh && bash hicode-install.sh
```

脚本会自动下载 HiCode，优先复用已有的 Bun 和 ripgrep，缺少时直接下载并校验可执行文件，然后注册 `hicode` 命令、配置 PATH。无需 Homebrew、Node.js 或管理员密码。支持自动配置 zsh（macOS 默认 Shell）和 bash。

**安装完成后，重新打开一个终端窗口**，进入你的项目目录即可启动：

```bash
cd /你的项目目录
hicode
```

只需要安装一次，以后在任意项目目录输入 `hicode` 就能使用。从零开发时，先创建一个空目录即可。

<details>
<summary>已经下载或 clone 了仓库？</summary>

在源码目录执行：

```bash
bash install.sh
```

脚本会使用当前源码。直接下载安装脚本时，源码默认存放在 `~/.local/share/hicode/source`。请保留源码目录，`hicode` 命令链接到这里。需要修复安装配置时，在该源码目录再次执行 `bash install.sh` 即可，不会自动覆盖已有源码。

</details>

## 配置模型

**直接在终端界面完成配置，不需要提前创建 `.env` 或手写 JSON。** 没有可用模型时，HiCode 会自动打开服务商配置面板；也可以在 HiCode 中输入 `/providers` 打开。

目前支持 **阿里云百炼（Qwen）、智谱 GLM、DeepSeek 和 OpenRouter**。准备好对应的 API Key，模型调用费用由服务商计收。

1. **选择服务商。**选择签发你这个 API Key 的服务商，例如 **DeepSeek** 或 **Alibaba Bailian（阿里云百炼）**。
2. **保存 Key。**进入 **API key**，粘贴 Key 后按 Enter 保存，输入内容会遮罩显示。
3. **确认接口地址。**如果账号使用的地址与默认值不同，进入 **API endpoint** 填写 API 基础地址。Key、接口地址和模型需要对应同一个服务。
4. **选择模型。**选择 **Choose model and start（选择模型并开始使用）**，再选择你的账号有权限使用的模型。HiCode 会保存选择并自动回到输入框。

配置面板中，↑/↓ 选择，Enter 确认。当前模型尚未配置可用时，Esc 退出 HiCode；已有可用配置时，Esc 返回或取消编辑。内置接口地址和预置模型可以直接使用，不需要重复填写。

**列表里没有想用的模型？** 在 `/providers` 中选择对应服务商，进入 **Add model**，填写接口要求的准确 **Model ID（模型 ID）**，再填写可选的 **Display name（展示名称）**。保存后选择 **Choose model and start** 即可使用。新增模型会沿用该服务商已有的适配能力，不代表支持任意 API 协议。

**使用 Qwen 时请注意：**目前默认接口为 `https://trial.cn-beijing.maas.aliyuncs.com/compatible-mode/v1`。如果你的账号使用其他接口，请先修改 **API endpoint** 再发送任务。预置模型也需要你的账号具有对应访问权限。

Key 默认保存在 `~/.hicode/.env`，模型配置保存在 `~/.hicode/settings.json`，换一个项目也可以复用。已有项目配置可以覆盖这些默认设置：如果项目 `.env` 中已经存在对应 Key 变量，面板会更新该文件并显示保存位置。不要将 API Key 提交到 Git。

## 开始一个任务

选好模型后，直接输入需求，例如：

> 看一下这个项目，介绍它的结构，找出最值得优化的地方，先不要修改代码。

也可以让它直接修改：

> 修复当前失败的测试。先定位原因，再修改实现，最后重新运行相关测试，并说明改了什么。

HiCode 会在启动时所在的目录中处理文件。遇到需要授权的操作，会在终端中请求确认。能够执行哪些验证取决于项目依赖和已接入的工具；网页操作需要另外提供浏览器工具。
