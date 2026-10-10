# HiCode Eval

HiCode 的公开题评测器。源码在本目录，真实题包、数据集清单、依赖配方、Dockerfile、模型连接声明、环境回执和日志统一放仓库外的评测根目录。现有网页和执行服务独立运行。当前系统不接收旧配置、旧台账或旧 Run。

**操作前、上下文压缩或恢复后，先阅读评测根目录的 README.md。** 它是目录、写入和清理的唯一操作规范；模板在 [templates/data-README.md](templates/data-README.md)。调整存储规则时同时更新模板、实际 README 和本机 AGENTS.md。`docs/eval/` 只维护数据集题目结论。

## 初始化与运行

所有操作都显式使用同一个 `--root`，不支持独立 catalog/environments/payload 路径。示例中的 `/path/eval-data` 替换为本机的实际根目录：

```bash
bash hicode-eval/eval.sh init --root /path/eval-data
bash hicode-eval/eval.sh register --root /path/eval-data --dataset terminal-bench-2.1 --tasks /path/validated-tasks --ids dna-assembly
bash hicode-eval/eval.sh prepare-environments --root /path/eval-data --ids terminal-bench-2.1:dna-assembly
bash hicode-eval/eval.sh prepare --root /path/eval-data
bash hicode-eval/eval.sh worker --root /path/eval-data --worker-port 8879
bash hicode-eval/eval.sh serve --root /path/eval-data --port 8878 --worker-port 8879
```

init 不访问 Docker 或模型，创建空台账，并从 HiCode 当前 Settings 导入模型连接与强度（也可用 --model-config 显式指定）；Key 只在 worker 进程通过声明的环境变量或 HiCode 的本机 .env 读取，不复制到评测根。模型、引擎、并发和时限在 `state/settings.json` 配置。prepare 要求干净 HiCode 工作树；明确需要当前改动时使用 `--snapshot-worktree`。worker 可以启动空根目录，第一次提交前校验冻结源码；每题在对应数据集镜像和 Docker 后端内独立安装运行版本；Python 执行模块在 worker 启动时冻结。

register 校验原题和公开/私有输入边界后复制到 `datasets/<dataset>/tasks/<id>`。依赖按固定配方准备，运行前再次验证源码及不可变镜像身份。系统依赖由 Data 声明中的 systemPackages 明确指定，commands 只校验命令存在，不在代码中猜包名。软件源在 Data 的运行 Dockerfile 配置。使用本机代理下载时只作用于构建，不作用于 Actor。Docker 引擎必须具备审定的嵌套 namespace、seccomp 和 AppArmor 条件，不能关闭安全边界来启动任务。

## 提交、状态与复核

```bash
bash hicode-eval/eval.sh submit --root /path/eval-data --file /path/batch.json --reasoning max
bash hicode-eval/eval.sh status --root /path/eval-data
bash hicode-eval/eval.sh cancel --root /path/eval-data --batch BATCH_ID
bash hicode-eval/eval.sh recover --root /path/eval-data --run RUN_ID
bash hicode-eval/eval.sh retry --root /path/eval-data --run RUN_ID
```

批次项必须包含 dataset 和 id，单题可设 agentSeconds（30–10800 秒）。服务和批次并发均最多 5。示例应放在 Data 的 state/batch-example.json。每次尝试只执行一次，完成后用原判题评分。启动前取消保留未测；错误、超时和模型答错分别存储。恢复只校验原证据，不再次调用模型；retry 创建新尝试，不覆盖旧分数。已通过题不再提交，旧成绩保留在 `docs/eval` 离线记录中。

submit 可用 `--reasoning max`，或在提交文件顶层添加 `reasoning: {effort: "max"}`；CLI 选项优先于文件，两者都省略时沿用 state/settings.json 的 model.reasoning，显式 default 使用厂商默认。支持档位按模型校验，批次、执行与 retry 使用冻结值；看板显示英文 Reasoning，实际请求字段在原请求日志。`--reasoning` 仅用于新 submit，retry 不允许覆盖原强度。不修改已运行任务，也不为参数变更重建依赖镜像。

网络默认允许，每题由数据集适配器按原题许可收窄。Terminal-Bench 2.1 读取冻结 task.toml 的 environment.allow_internet，只有 true 才开放，false／缺失则隔离；DeepSWE 始终隔离。同一批可混合联网与禁网题。settings／批次的 network=isolated 可进一步禁网，open 不能覆盖原题限制；实际模式保存在各 Run，retry 沿用原模式。普通题与服务题均使用本题模型网关，真实 Key 不进入作答环境。联网只改变外网访问，单题容器、文件、进程与隐藏判题边界保持不变。

正常完成的服务题必须先确认 `--single-task` 已封锁执行（持久化成功、工具回执完整、无运行或待消费子 Agent），并关闭模型网关；保留 HiCode Runtime 及其托管 Shell 服务，让私有 verifier 在独立文件／PID 视图中访问本题服务。判题完成、取消或失败后再关闭 Runtime、服务 namespace 和容器。未确认封锁不得暴露隐藏测试；超时／作答失败仍走原有停止确认，不保证服务存活。不能通过关闭全局 Task 清理或自行 daemonize 来替代此交接。

SWE 的独立补判使用 `regrade --root DIR --run ID`，不调用模型，不改原答案或首次成绩；原始未通过现场仍保留。看板默认 http://127.0.0.1:8878/，断开 worker 后仍能读取保存的结果和终端。

## 资源收尾

worker 空闲且无待恢复任务时自动清理通过题专用资源。日志先校验、打包、核验回执，再移除重型副本；镜像必须通过题目与容器引用检查，无引用才删除。共享底座保留，删除后环境标为 evicted，成绩保留。可重建的临时构建目录在 finally 和离线 gc 中清理。

```bash
bash hicode-eval/eval.sh image-inventory --root /path/eval-data
bash hicode-eval/eval.sh gc --root /path/eval-data
bash hicode-eval/eval.sh gc --root /path/eval-data --apply --build-cache
```

离线变更命令和 worker 争用同一 service lease。gc 默认预览，不能在活动服务中运行。BuildKit 默认保留 8 GB，显式请求时清理超过 7 天的缓存。镜像在配置 Docker context 的 Linux Docker Root；数据根保存的是回执。宿主磁盘回收以实际测量为准。

已登记题目可在其他题作答时准备环境：使用 `prepare-environments --root DIR --live --ids DATASET:ID,...`，由持锁 worker 接收并在后台顺序构建，立即返回接收清单。原题及配方必须先离线审定并登记；不重建活动题或待恢复题的环境，也不接受同时提交正在构建的题。最近进度在 `state/preparation.json`，实际就绪以 catalog 为准。构建期间不运行资源清理；worker 退出会等待构建收尾。离线准备仍要求服务停止。

## 开发边界与验证

`src/host/layout.ts` 管路径；catalog 管成绩及环境状态；manager 管调度；resources 管归档和镜像生命周期；数据集 registry 管输入与原判题适配；Linux worker 管执行隔离、证据收集和收尾；web 只展示 HTTP 状态。不得从旧备份直接恢复运行配置或增加兼容分支。

开发验证：`bun test hicode-eval/tests`、`bunx tsc --noEmit -p hicode-eval/tsconfig.json`；Python 边界用 `PYTHONPATH=hicode-eval/src/host:hicode-eval/src/worker:hicode-eval/src/datasets python3 -B -m unittest discover -s hicode-eval/tests`。测试使用临时目录和假模型，不产生模型费用；真实 Linux 隔离测试按可用内核能力另行执行并明确报告。

数据集清单使用 Data/datasets/<dataset>/definition.json；SWE 的依赖配方放同数据集 recipes/；公共底座为 Data/environments/runtime/{images.json,Dockerfile}，数据集专用运行配方放该数据集 runtime.Dockerfile。逐题重新审定，不整份照搬历史 config。特殊准备输入可用 register --preparation DIR --script FILE 复制并冻结。
