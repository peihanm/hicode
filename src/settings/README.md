# Pillar Settings 配置速查

Settings 文件用于配置模型、权限、Hooks、Memory、Checkpoint 和 OS Sandbox。所有字段都是可选的，
最小合法配置是：

```json
{}
```

## 配置文件位置与优先级

Pillar 按以下顺序读取配置，后面的标量值覆盖前面的值：

```text
内置默认值
  -> ~/.pillar/settings.json
  -> <项目>/.pillar/settings.json
  -> <项目>/.pillar/settings.local.json
  -> CLI --source / --model
```

- `~/.pillar/settings.json`：当前用户的默认配置。
- `.pillar/settings.json`：适合提交到仓库的项目配置。
- `.pillar/settings.local.json`：当前机器的项目配置，适合保存个人权限规则。
- CLI 只覆盖主力模型，不覆盖快速模型。

## 完整 JSON 示例

下面展示当前支持的全部配置区域。可以只保留实际需要修改的字段。

```json
{
  "sources": {
    "qwen": {
      "label": "阿里云百炼",
      "apiKeyEnv": "DASHSCOPE_API_KEY",
      "models": [
        {"id": "qwen3.6-plus", "label": "Qwen 3.6 Plus"},
        {"id": "qwen3.6-flash", "label": "Qwen 3.6 Flash"},
        {"id": "qwen3.8-flash", "label": "Qwen 3.8 Flash"}
      ]
    }
  },
  "models": {
    "primary": {
      "source": "qwen",
      "model": "qwen3.6-plus"
    },
    "fast": {
      "source": "qwen",
      "model": "qwen3.6-flash"
    }
  },
  "permissions": {
    "defaultMode": "default",
    "allow": [
      "read_file",
      "grep",
      "bash(git status:*)"
    ],
    "ask": [
      "bash(npm publish:*)"
    ],
    "deny": [
      "bash(rm -rf:*)"
    ]
  },
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|resume",
        "hooks": [
          {
            "type": "command",
            "command": "./.pillar/hooks/session-start.sh",
            "timeoutMs": 10000
          }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "edit_file|write_file",
        "hooks": [
          {
            "type": "command",
            "command": "./.pillar/hooks/check-edit.sh"
          }
        ]
      }
    ]
  },
  "memory": {
    "enabled": true,
    "autoExtract": true
  },
  "checkpointing": {
    "enabled": true
  },
  "sandbox": {
    "enabled": false,
    "filesystem": {
      "allowWrite": ["."],
      "denyRead": ["~/.ssh", "~/.aws", "~/.config/gcloud"],
      "denyWrite": [".pillar", ".env"]
    },
    "network": {
      "allowedDomains": ["api.example.com"],
      "allowLocalBinding": false
    }
  }
}
```

## 字段说明

### `models`

| 字段 | 类型 | 允许值或含义 | 默认值 |
| --- | --- | --- | --- |
| `sources.<name>.label` | string | 来源的用户可见名称 | 内置名称 |
| `sources.<name>.apiKeyEnv` | string | 保存该来源凭证的环境变量名 | 来源内置值 |
| `sources.<name>.baseUrl` | URL | 可选的请求地址 | 来源默认地址 |
| `sources.<name>.models` | array | `{id, label}` 模型目录 | 来源内置目录 |
| `models.primary.source` | string | `glm`、`qwen`、`deepseek`、`codex` | `codex` |
| `models.primary.model` | string | 对应 source 目录中的模型 ID | `gpt-5.6-luna` |
| `models.fast.source` | string | `glm`、`qwen`、`deepseek`、`codex` | `codex` |
| `models.fast.model` | string | 对应 source 目录中的模型 ID | `gpt-5.6-luna` |

`primary` 用于 Root Agent、Compact 和默认子 Agent；`fast` 用于 Explore、Prompt Hook，以及 primary
选择 Codex 时的 Memory 和 Agent Authoring。两者可以使用不同 Provider，`fast` 不是请求失败后的自动
降级模型。内置默认值让两者都使用 GPT-5.6 Luna；Codex 的 fast 调用仍固定为 `high` 推理。

`sources` 只允许在用户级 `~/.pillar/settings.json` 定义；项目和本机项目 Settings 只能选择
`source/model`，不能改变凭证变量或 Base URL。API key 的值仍只写在 `.env`，不会进入 Settings。

交互式 `/model` 只切换 primary，不修改 fast。一个 source 的 `apiKeyEnv` 对应凭证存在时，
该 source 中所有受支持的模型都会按 `label` 展示。

`codex` source 复用本机 Codex/ChatGPT 登录，不需要 API Key，因此总会出现在 primary 候选中；首次
调用才检查 Codex CLI 与登录状态。内置三个 GPT 模型全部固定 `high` 推理，primary 与 fast 都可使用。

### `permissions`

`permissions.defaultMode` 允许以下值：

| 值 | 含义 |
| --- | --- |
| `default` | 按工具规则判断，必要时询问用户 |
| `acceptEdits` | 自动允许工作区内的普通文件编辑，其他操作仍按规则判断 |
| `plan` | 计划模式，不允许普通写入操作 |
| `bypassPermissions` | 放宽普通权限确认，但不会绕过 deny、ask、elevated 等独立安全边界 |
| `dontAsk` | 不弹出权限对话框；原本需要询问的操作直接拒绝 |

`allow`、`ask` 和 `deny` 都是权限规则字符串数组：

```json
{
  "permissions": {
    "allow": ["read_file", "bash(git status:*)"],
    "ask": ["bash(npm publish:*)"],
    "deny": ["bash(rm -rf:*)"]
  }
}
```

- `read_file`：匹配整个工具。
- `bash(git status:*)`：匹配具有指定命令前缀的 Bash 调用。
- 三层配置中的规则会合并，而不是由高优先级数组整体替换。
- 顶层 `mode` 不生效，必须使用 `permissions.defaultMode`。

### `hooks`

支持的事件名：

```text
SessionStart
UserPromptSubmit
PreToolUse
PostToolUse
PostToolUseFailure
SessionEnd
```

每个事件的值是 matcher 数组：

| 字段 | 类型 | 允许值或含义 |
| --- | --- | --- |
| `matcher` | string，可选 | 完整名称、`*`、`a|b` 精确多选或合法 JavaScript 正则 |
| `hooks` | array | 1–20 个 Hook |
| `hooks[].type` | string | `command` 或 `prompt` |
| `hooks[].command` | string | `type=command` 时必填；非空本地命令，最长 20,000 字符 |
| `hooks[].prompt` | string | `type=prompt` 时必填；fast 模型裁决 policy，最长 20,000 字符 |
| `hooks[].if` | string，可选 | 仅 Tool 事件；使用权限规则语法过滤工具参数 |
| `hooks[].shell` | string，可选 | 仅 Command Hook；`bash` 或 `powershell`；省略时使用平台默认 Shell |
| `hooks[].once` | boolean，可选 | 命中后在当前 Session Runtime 生命周期内只执行一次 |
| `hooks[].timeoutMs` | integer，可选 | Command 为 `100`–`60000`，默认 10,000ms；Prompt 为 `100`–`120000`，默认 30,000ms |

三层来源中的 Hooks 按 user、project、local 顺序叠加。项目 Hook 首次执行前还需要独立的工作区信任确认。
Prompt Hook 固定使用 `models.fast`，只得到一个私有结构化提交工具，不继承项目 Tool Runtime。

### `memory`

| 字段 | 类型 | 默认值 | 含义 |
| --- | --- | --- | --- |
| `memory.enabled` | boolean | `true` | 是否启用跨 Session Memory |
| `memory.autoExtract` | boolean | `true` | 是否允许自动提取 Memory |

任意已加载来源设置为 `false` 后，更高优先级来源不能重新开启该项。`enabled=false` 时，最终
`autoExtract` 也一定是 `false`。

### `checkpointing`

| 字段 | 类型 | 默认值 | 含义 |
| --- | --- | --- | --- |
| `checkpointing.enabled` | boolean | `true` | 是否为新的文件修改创建 Checkpoint |

关闭后不会删除已有 Checkpoint，已有数据仍可通过 `/rewind` 恢复。

### `sandbox`

| 字段 | 类型 | 默认值 | 含义 |
| --- | --- | --- | --- |
| `sandbox.enabled` | boolean | `false` | 是否启用 OS 级 Sandbox |
| `sandbox.filesystem.allowWrite` | string[] | `["."]` | 允许写入的路径 |
| `sandbox.filesystem.denyRead` | string[] | 敏感目录列表 | 禁止读取的路径 |
| `sandbox.filesystem.denyWrite` | string[] | `[".pillar", ".env"]` | 禁止写入的路径 |
| `sandbox.network.allowedDomains` | string[] | `[]` | 允许访问的域名，不带协议和路径 |
| `sandbox.network.allowLocalBinding` | boolean | `false` | 是否允许监听本地端口 |

相对路径以项目根目录解析，`~` 会解析到用户目录。`.pillar` 和项目根目录的 `.env` 始终禁止写入，
即使没有在 `denyWrite` 中重复配置。数组采用最高优先级已定义值整体替换，不进行合并。

## 校验与边界

- JSON 损坏或已知字段类型错误时，该配置来源不会生效。
- 未知字段会保留，但会产生 warning，不能依赖未知字段影响运行行为。
- Secret、MCP、LSP、PILLAR.md、Skills、Session 和自定义 Agent 定义不属于 Settings。
- 修改 Settings 或 `.env` 后应重启 Pillar，使 Root Runtime 获取新的配置与 `/model` 候选快照；
  进程内使用 `/model` 切换 primary 不需要重启。

实现细节见 [`document.ts`](./document.ts)、[`schema.ts`](./schema.ts)、
[`resolve.ts`](./resolve.ts) 和 [`load.ts`](./load.ts)。
