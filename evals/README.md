# Pillar SDK Eval Harness

该目录只保存可以提交到 Git 的 Case、Fixture、Runner 和 Verifier。真实运行现场默认保存在
`~/.pillar-evals/runs/<run-id>/`，不会写入 Fixture、当前项目的 `.pillar/` 或真实 `~/.pillar` Session。

```bash
bun run eval -- --list

bun run eval -- \
  --case fix-failing-test \
  --env-file /absolute/provider.env \
  --source qwen \
  --model qwen3.8-flash

bun run eval -- --trend

bun run eval:suite -- \
  --cases fix-failing-test,create-and-run-code,leetcode-web \
  --env-file /absolute/provider.env

bun run eval -- --inspect <run-id>

# 较重的端到端 Web Case
bun run eval -- --case leetcode-web --env-file /absolute/provider.env
```

运行时默认每 15 秒在 stderr 打印一次心跳，例如模型正在 reasoning、准备哪个 Tool、执行哪个 Tool、是否
等待 Interaction，以及最后一次 SDK 信号距今多久。`active`、`quiet` 和 `stalled` 只表示可观测活性，
不会自动终止任务；Case 的 hard timeout 才会取消 Turn。可用 `--heartbeat-ms 5000` 调整频率，或用
`--quiet` 关闭。`leetcode-web` 默认允许最多 15 分钟，软耗时预算为 12 分钟。

Suite 会在 Provider 调用前校验全部 Case，然后顺序复用单 Case Runner；每个 Case 保留自己的 Run 现场，
额外在 `~/.pillar-evals/suites/<suite-id>/suite-report.json` 写入一次汇总。单项基础设施失败不会跳过后续
Case，任一失败会让 Suite 命令非零退出。使用 `--cases all` 必须显式承担所有 Case 的模型费用。

`--inspect` 不调用 Provider，也不执行被测代码。它可直接给出失败断言与 verifier stderr、最后模型信号、
失败 Tool、修改文件、Token/迭代、权限等待时间和最终回答 preview；对被中断、尚未生成 report 的 running
现场同样有效。Inspect 把全部持久化输入视为不可信数据，限制大小/数量并拒绝 Symlink。

每个运行目录包含：

```text
manifest.json          Case、模型、Session 和路径索引
report.json            总结果、失败分类、usage、预算和断言
transcript.json        Prompt、最终回答、工具和文件修改摘要
sdk-events.jsonl       完整 SDK protocol event（含节流后的 turn.progress）；可能含敏感源码
interactions.jsonl     Host interaction 请求和裁决
diagnostics.jsonl      Host diagnostic
verification.json      独立验证断言和命令输出
diff.patch             相对 Fixture 基线的完整 Git diff
workspace/             Agent 实际修改后的项目
pillar-home/           本次运行独立的 Pillar Storage
verifier-home/         不含真实用户凭证的 verifier HOME
```

每个 Case 同时定义硬执行上限和软质量预算。硬 `maxIterations`/timeout 防止失控；软预算检查迭代数、
input/output/total Token 和 Turn duration，超额会保留完整结果但令 Case 以 `budget` 分类失败。可用
`--budget-iterations`、`--budget-input-tokens`、`--budget-output-tokens`、`--budget-total-tokens` 与
`--budget-duration-ms` 覆盖本次阈值。

默认 `<eval-root>/trend-report.json` 从 `runs/*/report.json` 自动重建，按 Case、Provider 和模型汇总通过率、
平均 Token/迭代/耗时与最近变化。它不是第二份历史真相源；可随时用 `bun run eval -- --trend` 回填旧 Run。

Verifier 使用显式 argv，不经过 shell，也不会继承 Provider Key。SDK Host 只从 `--env-file` 把 Key
加载进当前 Eval 进程；env 文件内容不会复制到运行目录。Settings 文件只提取模型来源和模型目录，Hooks、
权限规则和其他用户运行状态不会带入 Eval。

Fixture 中故意失败且会被 Bun 自动发现的测试使用 `.fixture` 后缀；Harness 复制 workspace 后再去掉该
后缀。不要把失败的 `*.test.ts` 或 `*.spec.ts` 直接放在仓库内的 Fixture 目录。

默认 `--keep all`，便于开发 Agent 检查完整现场。稳定后可使用 `--keep failed`，成功时只保留报告、对话、
事件、Diff 和验证结果；`--keep none` 同样删除失败运行的 workspace 与 Pillar Home。
