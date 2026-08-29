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
  -> PILLAR_PRIMARY_PROVIDER / PILLAR_PRIMARY_MODEL
  -> PILLAR_FAST_PROVIDER / PILLAR_FAST_MODEL
  -> CLI --provider / --model
```

- `~/.pillar/settings.json`：当前用户的默认配置。
- `.pillar/settings.json`：适合提交到仓库的项目配置。
- `.pillar/settings.local.json`：当前机器的项目配置，适合保存个人权限规则。
- CLI 只覆盖主力模型，不覆盖快速模型。

## 完整 JSON 示例

下面展示当前支持的全部配置区域。可以只保留实际需要修改的字段。

```json
{
  "models": {
    "primary": {
      "provider": "glm",
      "model": "glm-5.2"
    },
    "fast": {
      "provider": "glm",
      "model": "glm-4.7"
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
| `models.primary.provider` | string | `glm`、`qwen`、`deepseek`、`jeniya` | `glm` |
| `models.primary.model` | string | 对应 Provider 支持的非空模型名称 | `glm-5.2` |
| `models.fast.provider` | string | `glm`、`qwen`、`deepseek`、`jeniya` | `glm` |
| `models.fast.model` | string | 对应 Provider 支持的非空模型名称 | `glm-4.7` |

`primary` 用于 Root Agent、Compact、Memory 和默认子 Agent；`fast` 用于 Explore 及显式选择
`model=fast` 的子 Agent。两者可以使用不同 Provider，`fast` 不是请求失败后的自动降级模型。

API Key 和 endpoint 不写入 Settings。它们使用各 Provider 的环境变量，例如
`GLM_API_KEY`、`DASHSCOPE_API_KEY`、`DEEPSEEK_API_KEY` 和 `JENIYA_API_KEY`。

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
- Secret、MCP、LSP、CODE.md、Skills、Session 和自定义 Agent 定义不属于 Settings。
- 修改 Settings 后应重启 Pillar，使 Root Runtime 获取新的不可变配置快照。

实现细节见 [`document.ts`](./document.ts)、[`schema.ts`](./schema.ts)、
[`resolve.ts`](./resolve.ts) 和 [`load.ts`](./load.ts)。
