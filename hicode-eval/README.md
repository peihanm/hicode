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

评测 worker 支持多模型批次共存：state/settings.json 的 model 是默认连接，models 是额外审定连接列表，source/model 组合必须唯一。新 submit 可通过顶层 model: {source, model} 或 --model-source SOURCE --model MODEL 选择，CLI 优先；只能选择已配置连接，不能随请求覆盖 baseUrl、apiKeyEnv 或传 Key。未选模型沿用默认；强度优先级为 CLI、提交顶层 reasoning、所选连接默认、厂商 default。worker 启动在边界读取所有声明凭据（进程环境→项目.env→用户.env），只驻留内存；逐题按冻结 batch.model 选择对应 Key。不同模型批次共用全局并发上限及 service lease；retry/continue 沿用原模型、连接与强度，不要求它仍是默认，但原连接必须仍在配置中且完整匹配（默认强度变化不影响冻结值）。追加或更换连接与 Key 仍需空闲时重新加载 worker；已配置模型之间提交无需切账号或重启。单批次仍冻结一个模型，不增加逐题覆盖或第二套调度。

```bash
bash hicode-eval/eval.sh submit --root /path/eval-data --file /path/batch.json --reasoning max
bash hicode-eval/eval.sh submit --root /path/eval-data --file /path/qwen-batch.json --model-source qwen --model qwen3.8-flash --reasoning xhigh
bash hicode-eval/eval.sh status --root /path/eval-data
bash hicode-eval/eval.sh cancel --root /path/eval-data --batch BATCH_ID
bash hicode-eval/eval.sh recover --root /path/eval-data --run RUN_ID
bash hicode-eval/eval.sh retry --root /path/eval-data --run RUN_ID
bash hicode-eval/eval.sh continue --root /path/eval-data --run RUN_ID --agent-seconds 2400 --prompt "继续完成原任务。"
```

批次项必须包含 dataset 和 id，单题可设 agentSeconds（30–10800 秒）。服务和批次并发均最多 5。示例应放在 Data 的 state/batch-example.json。每次尝试只执行一次，完成后用原判题评分。启动前取消保留未测；错误、超时和模型答错分别存储。恢复只校验原证据，不再次调用模型；retry 创建新尝试，不覆盖旧分数。已通过题不再提交，旧成绩保留在 `docs/eval` 离线记录中。

Terminal-Bench 2.1 和 DeepSWE 的超时、取消和模型失败尝试，在确认会话已保存、工具回执完整且作答进程已停止后生成判题前快照。网页的“继续作答”可设置追加时间和补充要求；CLI 用 continue。同一批次有多道可续跑题时，可用“继续本批次未完成的题”，一次发布一个包含所有所选题目的新批次；每个 Run 独立冻结 checkpoint 与来源，统一使用共享并发。它恢复原工作区、Home、会话和审定服务目录，在新独立容器中调用 HiCode --resume，沿用原模型、推理档位、网络、题目和冻结源码，占同一共享并发名额。恢复时保留原模型网关端口，使会话中的思考记录仍对应同一连接身份。进程内存和临时 tmpfs 不恢复；服务需重新启动，训练有 checkpoint 才能接着训练。retry 仍从头开始，原尝试和成绩均保留。

标准续跑接收判题前生成且通过收集回执、哈希、容器销毁回执和环境身份校验的快照。DeepSWE 的已收集超时尝试若没有快照，可显式使用 `continue --restore-actor`（网页自动选择对应入口）：审定原冻结 runner、隔离与判题模块，核验停机封锁、会话保存及 Actor 文件哈希后，仅从封存的 project/Home 恢复原会话；不读取 verifier 副本、隐藏测试或判题日志，不修改原证据或冒充原先已有快照。新尝试记录 `continueOf.inputSource=sealed-deep-actor`，恢复包只暂存于 cache/builds，发布后清理。保存不完整、环境或 payload 变化时拒绝续跑。SWE-bench Verified 未开放该入口。执行模块升级只在所有任务和构建结束后重启 worker，不向活动题热部署。

submit 可用 `--reasoning max`，或在提交文件顶层添加 `reasoning: {effort: "max"}`；CLI 选项优先于文件，两者都省略时沿用所选模型连接的 reasoning，显式 default 使用厂商默认。支持档位按模型校验，批次、执行与 retry 使用冻结值；看板显示英文 Reasoning，实际请求字段在原请求日志。`--reasoning` 仅用于新 submit，retry 不允许覆盖原强度。不修改已运行任务，也不为参数变更重建依赖镜像。

网络默认允许，每题由数据集适配器按原题许可收窄。Terminal-Bench 2.1 读取冻结 task.toml 的 environment.allow_internet，只有 true 才开放，false／缺失则隔离；DeepSWE 始终隔离。同一批可混合联网与禁网题。settings／批次的 network=isolated 可进一步禁网，open 不能覆盖原题限制；实际模式保存在各 Run，retry 沿用原模式。普通题与服务题均使用本题模型网关，真实 Key 不进入作答环境。联网只改变外网访问，单题容器、文件、进程与隐藏判题边界保持不变。

评测使用普通交互 CLI 与 `--event-log`，不提供 single-task 开关或 UI 执行封锁。宿主只提交一次题目；正常完成的服务题必须确认 saved turn_end 与 saved settled、UI 空闲且不等待审批、工具回执完整、无运行或待消费子 Agent，然后关闭模型网关再上传隐藏测试。保留 HiCode Runtime 及其托管 Shell 服务，让私有 verifier 在独立文件／PID 视图中访问本题服务；判题完成、取消或失败后再关闭 Runtime、服务 namespace 和容器。未确认收尾不得暴露隐藏测试；超时／作答失败仍走原有停止确认，不保证服务存活。不能通过关闭全局 Task 清理或自行 daemonize 来替代此交接。

SWE 的独立补判使用 `regrade --root DIR --run ID`，不调用模型，不改原答案或首次成绩；原始未通过现场仍保留。看板默认 http://127.0.0.1:8878/，断开 worker 后仍能读取保存的结果和终端。

已完成并完整收集的普通 Terminal 题可使用 `regrade --root DIR --run ID`，由 worker 复用原答案和原测试补判，不调用模型、不接受重启脚本。完成事件、答案哈希与原容器销毁回执都必须通过校验。

已完成并完整收集的 Terminal 服务题可使用 `regrade --root DIR --run ID --service-restart-script FILE` 补判。有 worker 时自动转交它，立即返回 `reviewId`；用 `recheck --root DIR --run ID --review ID` 查询结果。补判复用现有调度器，占一个并发名额，其他题继续运行和提交；同题的重跑、重复补判和环境重建受互斥保护，资源清理等待补判结束。worker 统一写入当前 Run 和台账，关闭时取消补判并销毁临时容器，重启先收尾中断的补判。没有 worker 时才取得同一 service lease 离线执行。

补判校验原答案和服务快照，在独立临时容器恢复服务并执行冻结原测试，不调用模型。重启脚本只恢复服务并清理首次测试的副作用，不能修改答案或断言；输入、原成绩、日志、结果、操作状态和销毁回执保存在原 Run 的 `rechecks/`。补判异常不改成绩；不能确认容器清理时保留记录并暂停调度。

## 资源收尾

多模型配置示例：保留 `settings.json.model` 作为默认 GLM 连接，在 `models` 中添加个人千问连接（不要重复添加默认连接）。Key 仍保存在原有环境变量或 `.env` 中。

```json
{
  "models": [{
    "source": "qwen",
    "model": "qwen3.8-flash",
    "apiKeyEnv": "DASHSCOPE_API_KEY",
    "baseUrl": "https://trial.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
    "imageInput": true,
    "reasoning": {"effort": "xhigh"}
  }]
}
```

提交文件顶层添加 `"model": {"source": "qwen", "model": "qwen3.8-flash"}` 即选择该连接。同一 worker 可以同时接收默认 GLM 与个人千问批次，所有任务共享服务总并发上限。

每个评测容器显式设置文件句柄软／硬上限为 65536，避免继承 Docker 的 1024 软上限，导致 MongoDB 等服务在完整验收中因句柄耗尽退出。额度只作用于本次容器，不修改 VM 或 Docker 全局配置；CPU、内存、进程与证据预算仍独立限制。

worker 空闲且无待恢复任务时自动清理通过题专用资源。日志先校验、打包、核验回执，再移除重型副本；镜像必须通过题目与容器引用检查，无引用才删除。共享底座保留，删除后环境标为 evicted，成绩保留。可重建的临时构建目录在 finally 和离线 gc 中清理。

```bash
bash hicode-eval/eval.sh image-inventory --root /path/eval-data
bash hicode-eval/eval.sh gc --root /path/eval-data
bash hicode-eval/eval.sh gc --root /path/eval-data --apply --build-cache
```

离线变更命令和 worker 争用同一 service lease。gc 默认预览，不能在活动服务中运行。BuildKit 默认保留 8 GB，显式请求时清理超过 7 天的缓存。镜像在配置 Docker context 的 Linux Docker Root；数据根保存的是回执。宿主磁盘回收以实际测量为准。

新题可用 `register --root DIR --live --dataset DATASET --tasks DIR --ids ID,... --definition FILE` 在评测期间登记。审定 definition 文件只包含所选新题声明；worker 校验冻结题包后仅追加，不允许修改已有声明或覆盖已登记题目。离线与在线登记复用同一导入逻辑，登记、控制请求与清理串行，台账登记和成绩入账共用写入队列。请求超时先查询 catalog，不能直接重复登记。准备材料仍用 `--preparation DIR --script FILE`；SWE-bench Verified 无外部 definition，省略该参数。

已登记题目可在其他题作答时准备环境：使用 `prepare-environments --root DIR --live --ids DATASET:ID,...`，由持锁 worker 接收并在后台顺序构建，立即返回接收清单。原题及配方须先审定，离线持锁或交给 worker 在线登记；不重建活动题或待恢复题的环境，也不接受同时提交正在构建的题。最近进度在 `state/preparation.json`，实际就绪以 catalog 为准。构建期间不运行资源清理；worker 退出会先取消当前构建/下载及其宿主子进程组，停止后续题的准备，再等待锁和临时目录清理；已完成镜像保留，未完成题在进度中列为 cancelled，不当作依赖失败。离线准备仍要求服务停止。

## 开发边界与验证

作答 CLI 固定后，生命周期由 pidfd 和完整 Actor 事件确认；实时终端采样失败沿现有 ScreenSampler 退避恢复并写 terminal-diagnostics.json，不因此终止作答。命令诊断使用安全操作名称，保留退出码、信号、耗时和超时额度；不附加完整参数或环境，当前模型 Key 在 stdout/stderr 摘要截断前脱敏。启动握手、事件完整性、证据预算及隐藏判题交接保持严格检查。执行模块只在空闲时重启 worker 部署。

`src/host/layout.ts` 管路径；catalog 管成绩及环境状态；manager 管调度；resources 管归档和镜像生命周期；数据集 registry 管输入与原判题适配；Linux worker 管执行隔离、证据收集和收尾；web 只展示 HTTP 状态。不得从旧备份直接恢复运行配置或增加兼容分支。

开发验证：`bun test hicode-eval/tests`、`bunx tsc --noEmit -p hicode-eval/tsconfig.json`；Python 边界用 `PYTHONPATH=hicode-eval/src/host:hicode-eval/src/worker:hicode-eval/src/datasets python3 -B -m unittest discover -s hicode-eval/tests`。测试使用临时目录和假模型，不产生模型费用；真实 Linux 隔离测试按可用内核能力另行执行并明确报告。

数据集清单使用 Data/datasets/<dataset>/definition.json；SWE 的依赖配方放同数据集 recipes/；公共底座为 Data/environments/runtime/{images.json,Dockerfile}，数据集专用运行配方放该数据集 runtime.Dockerfile。逐题重新审定，不整份照搬历史 config。特殊准备输入可用 register --preparation DIR --script FILE 复制并冻结。

镜像型数据集的 runtime.Dockerfile 可使用 `{{runtime_<name>}}` 引用公共底座 images.json 的固定 ARM64 镜像。EnvironmentStore 在目标 context 中校验 digest 与架构、生成确定性本地标签，并对官方 AMD64 题目层显式设置构建平台。DeepSWE 的 Rosetta 配方让 HiCode、Sandbox 工具和 runner Python 原生运行于 ARM64，题目与 verifier 保持 AMD64；启用前必须通过完整零费用 Linux smoke，不能只以容器或公开测试可启动作为依据。真实模型容器使用宿主解析且通过公网校验的 HTTPS 域名 IPv4 生成本题 `--add-host`，原 URL、Host、SNI 和证书验证不变，不修改 VM DNS 或 TLS。

审定服务题可声明 verifierProcessView 与 /tmp 下具名 verifierSockets；只向私有判题提供本题封锁时的服务 PID 目录和指定归属 socket，判题仍使用独立 PID namespace，self/net 来自自己的 Proc。Proc 构造辅助进程进入服务 PID 前先 chroot 到空 tmpfs，隐藏文件不能经辅助进程 root 暴露；socket 放本题 service-tmp，只绑定审定文件，不开放整份 tmp 或控制目录。

DeepSWE 补判也使用现有 regrade/recheck 入口，交持锁 worker 占一个并发名额，可与其他题和环境准备并行；取消发生在判题阶段时，须先验证作答已完成、完成事件和答案哈希，才能按原答案补判并恢复真实执行/判题结论。大历史会话续跑的 TUI 就绪与首次请求确认分别最多等 300/120 秒，与追加作答时间分开。

公共运行底座保留；DeepSWE 的逐题官方镜像封装底图不属于公共底座，仅被通过题引用且无容器占用时可回收。按题目层、依赖层、底图的顺序删除，不强制删除有引用的镜像。

重型镜像准备可使用 `prepare-environments --live --after-evaluations`：请求立即入队，进度记录 waitingForEvaluations；有执行或排队评测时不启动构建，空闲后由同一worker继续。关闭会取消等待，不新建外部后台进程。

DeepSWE 固定镜像含 /root/.cache/ms-playwright 时，作答准备和独立判题将经校验的浏览器缓存复制到 /opt/hicode-task/ms-playwright，内部链接须留在缓存内并重写为相对链接；限定25000条目／2 GiB，只复制普通文件、目录和内部链接。目录通过现有依赖视图只读挂载，两种独立 Home 使用同一 PLAYWRIGHT_BROWSERS_PATH；不暴露/root、不使用Actor下载结果、不在禁网判题时下载。无该缓存的题目不追加浏览器依赖。修改执行模块须等全部评测／构建空闲后重启worker生效。

DeepSWE 的 Go 镜像准备必须用固定源镜像中 `GOTOOLCHAIN=local go env GOMODCACHE` 的实际目录复制模块与工具链缓存到 `/opt/hicode-go/pkg/mod`，不得假设缓存位于 `/root/go/pkg`；源缓存缺失或为 symlink 时构建失败。Actor 与独立 verifier 均须在禁网隔离视图中验证工具链和所需模块可读，不能以目录存在代替可用性验证。
