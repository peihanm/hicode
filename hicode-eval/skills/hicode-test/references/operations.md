# 当前 CLI 与证据入口

先解析 Skill 目录的 realpath，再向上定位包含 `hicode-eval/src/cli.ts` 的 checkout。先核对现有服务；不要把技能安装目录当 checkout。维护契约以该 checkout 的 `hicode-eval/README.md`、`src/host/types.ts` 和 CLI 为准；只有命令不确定或实现变更时再查它们。

## 路径与复用

在当前工具调用中显式填写 `HE_ROOT`（checkout）、`HE_DATA`（仓库外数据根）、`HE_CATALOG`（成绩台账）、`HE_ENVIRONMENTS`（镜像回执）、`HE_PAYLOAD`（固定源码包）、`HE_PORT` 和 `HE_BATCH_FILE`。变量不会自动跨工具调用保存。通用配置在 `hicode-eval/config/`；临时提交文件放在外部数据目录的 `operator/batch-configs/`，不要存回源码目录。固定回归题组可以复用 `config/regression15.json`，不要误将示例题目当作用户选题。

现有数据根的 `config.json` 记录真实 catalog/environments/payload/model/concurrency；`.service.lock/owner.json` 记录 PID/启动身份。结合监听进程和 status 核对，不能只凭旧 owner 文件杀进程。模型凭据不打印、不复制到任务文件。

服务和 batch 都限制并发，实际运行受两者共同约束。只读核对后能复用就直接提交，不再次运行 prepare/安装依赖/全量测试。payload 的 manifest 记录 commit、overlay 和归档 hash；仅必要时冻结新版本，不能默认把未提交源码装进被测版本。

## 常用命令

从 checkout 根目录执行；同一服务的命令使用同一个端口：

```bash
bash hicode-eval/eval.sh catalog --port "$HE_PORT"
bash hicode-eval/eval.sh submit --file "$HE_BATCH_FILE" --port "$HE_PORT"
bash hicode-eval/eval.sh status --batch "$HE_BATCH" --port "$HE_PORT"
bash hicode-eval/eval.sh wait --batch "$HE_BATCH" --wait-seconds 30 --port "$HE_PORT"
```

status/wait 输出含完整任务清单，接收后只打印批次 state/counts、run 的 task/state/execution/grading/collection/note 和 schedulingBlocked；不要把完整 JSON 灌进上下文再重读。需要时通过现有 `src/host/client.ts` 的 `Client.status()` 读取并投影，不为单次检查编写新的监控系统。

先用 `bash hicode-eval/eval.sh --help` 确认入口；路径变更后的离线检查用 `bun test hicode-eval/tests`，Python 用 `PYTHONPATH=hicode-eval/src/host:hicode-eval/src/worker:hicode-eval/src/datasets python3 -B -m unittest discover -s hicode-eval/tests`。正常启动已有环境不重复运行这些开发验证。

批次 JSON 包含可选 `network`、`name`、`tasks`（`{id, agentSeconds}` 对象数组）与 `concurrency`（1–5）。`agentSeconds` 是每题时限，范围 30–7200 秒，省略使用服务默认 1800 秒；没有批次级 budget 参数。同一轮的不同预算放进同一个批次，不再按时间分组。配置示例：`{"name":"本轮","tasks":[{"id":"polyglot-c-py","agentSeconds":900},{"id":"modernize-scientific-stack","agentSeconds":600}],"concurrency":3}`。以已保存的用户约定为准，不直接运行示例文件中的题目。

执行进程 `worker` 独占调度和台账 lease；仅在不存在或已空闲且配置确需更新时启动/重启，任务运行中不能另开同数据根的执行进程：

```bash
bash hicode-eval/eval.sh worker \
  --data-dir "$HE_DATA" --catalog "$HE_CATALOG" --environments "$HE_ENVIRONMENTS" --payload "$HE_PAYLOAD" \
  --docker-context "$HE_CONTEXT" --machine "$HE_MACHINE" \
  --concurrency "$HE_CONCURRENCY" --worker-port 8879
```

看板是独立进程，可随时重启，不取消跑题、不加载 Key；默认看板 8878、执行控制 8879。启动看板：

```bash
bash hicode-eval/eval.sh serve --data-dir "$HE_DATA" --port "$HE_PORT" --worker-port 8879
```

状态、终端与日志读取原子记录，提交/取消/恢复等操作经认证后转给同一数据根的 worker。执行服务连接未确认时只读查看；不要将看板停止当成任务取消。

默认由服务解析用户现有模型；显式覆盖才使用 `--source/--model` 或 `--model-config`。复用宿主可保留的工具会话运行服务。

恢复只处理已有现场，不重新做题：

```bash
bash hicode-eval/eval.sh recover --run "$HE_RUN" --port "$HE_PORT"
bash hicode-eval/eval.sh resume --batch "$HE_BATCH" --port "$HE_PORT"
```

recover 用于 needs_recovery，证据不足会拒绝；resume 只恢复既有未启动队列，不能重跑完成或已取消批次。`cancel --batch` 会取消整批，不能拿它处理单题问题。发布已完成批次分析可用 `report --batch ID --file FILE`，不会调用模型。

## 证据

相对 `HE_DATA`：

| 入口 | 用途 |
| --- | --- |
| `batches/ID.json` | 固定版本、模型、题目、预算、run IDs |
| `runs/ID/state.json` | 执行/判题/收集状态与时间 |
| `runs/ID/preparation.log` | 初始化和依赖诊断 |
| `runs/ID/live/screen.txt` | 最近 TUI，不能仅据画面静止判断停止 |
| `runs/ID/live/events.jsonl` | 有序事件；外层 at 为毫秒，agent_event 的内层 event 含工具与模型事件 |
| `runs/ID/verification.txt` | 判题输出摘要；完整日志见 evidence/logs/verifier/output.txt |
| `runs/ID/evidence/` | 收集的 project、home、job、logs、outcome/result |
| `runs/ID/collection.json` | 收集结果与文件哈希 |

工具按内层 toolCallId 配对，模型耗时看 model_stream_start/end；审批状态看 approval_review/state。请求日志遵循被测版本的 HiCode Storage Layout，仅在排查具体问题时定位；它可能含代码和凭据相关上下文，分享前脱敏。

一次状态核对后根据任务结束、用户追问或明确异常再读取。若用户只要求启动，交付网页地址与实际运行情况后结束回复；不得承诺不存在的自动唤醒功能。

周期收集失败见 `collection-error.txt`，不能仅据此判断 Agent 执行失败。快照中的符号链接只记录目标文本，不应解引用读取宿主文件。FEAL 编译只使用封存后的独立测试副本；Headless 临时根只用于判题。判题依赖准备失败是 unavailable，不能计作模型答错。

选题、镜像准备及等待源码完成的交接步骤见 [准备流程](preparation.md)。准备记录与真实运行记录分开，只有提交成功才有 batch/run ID。

## 已完成 SWE 的仅验收复核

仅在用户明确要求复验时使用 `bun hicode-eval/src/cli.ts regrade --data-dir "$HE_DATA" --run RUN_ID`。它先核对历史原题包、`prediction.json` 和原 `model.patch` 哈希；如果补丁与预测均未落盘且原判题不可用，则核验完整收集回执后从原封存工作区重建补丁。随后在单独目录执行原判题；不会运行 Agent、调用模型或重交任务。结果位于 `runs/RUN_ID/rechecks/REVIEW_ID/`，含 `result.json`、`logs/verifier/validity.json`、原目标与回归测试状态；首次 run 的状态与分数不回写。验收环境、补丁或原测试节点无法完成时记录 `unavailable`，不是模型代码失败。复验成功也只是这次补丁判题结论，不改变首次执行事实。


成绩台账与清理独立：`catalog.json` 保留累计通过和尝试摘要，`run-archive/` 保留精简补丁和判题依据。`environment.json` 是该次实际镜像层身份，`environments/preparation-report.json` 区分已准备、失败和缺题包。`catalog` 的 environmentPrepared 表示已有回执，运行前还会验证源内容和镜像。

用户主动要求单题重跑时：`bash hicode-eval/eval.sh retry --run "$HE_RUN" --port "$HE_PORT"`。返回关联原 run 的新单题 batch；原批次统计不改变。重复调用相同原 run 返回同一后继。模型/payload 不匹配时需恢复原服务配置；不要通过改写原状态绕过限制。

补判的网络修复可显式使用 `regrade --verifier-proxy http://HOST:PORT`。仅接受无凭据 HTTP(S) origin，代理只进入该次 verifier，localhost 测试服务器仍直连，Actor/模型网关不受影响。保留原 URL、TLS 校验、测试断言与封存答案；不可为通过而伪造网页响应。环境修正后的补判成绩单独记录，不静默覆盖原 run。
