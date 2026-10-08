# HiCode Eval

[English](README.en.md)

使用可复用环境镜像，每次尝试启动独立 Linux 容器，批量测试 HiCode 完成公开编程任务的能力。CLI 提交任务，网页查看完整 TUI 和进度，结束后自动运行原题测试并保存日志。每题独立尝试一次，不追加纠错提示、不自动重跑。

已适配题目见 [Terminal-Bench 2.0 清单](config/terminal-bench.json)与 [Terminal-Bench 2.1 清单](config/terminal-bench-2.1.json)；SWE-bench Verified 使用冻结题包。此工具用于研发回归；审定依赖配方、ARM64 环境和可调时限与官方环境存在差异，结果不等同于官方榜单成绩。

批次执行状态与累计成绩由 CLI `status` 查询。持久 `catalog.json` 保留已通过、未通过、待测试；正在运行从当前任务派生。删除历史工作区不会删除台账。

## 目录与记录

```text
src/
  cli.ts     命令行入口
  host/      宿主调度、状态、Linux 连接与源码打包
  worker/    Linux 执行、判题、终端记录与收尾
  web/       只读看板与终端组件
config/      题目适配清单、固定回归题组与配置示例
tests/       离线回归测试
skills/      Codex 批量评测操作说明
```

题目文件、源码 payload、凭据和运行记录保存在仓库外。`config/` 只保存通用声明、固定回归题组和示例；累计成绩以外部 `catalog/catalog.json` 为准，未归档的提交与运行证据在 `<data-dir>/batches/`、`runs/`，已归档的精简证据在 `catalog/run-archive/`（旧证据可打包）。近期待提交的选题配置放在仓库外的 `../hicode-eval-data/operator/batch-configs/`；`operator/records/` 只保留仍在使用或被台账引用的状态记录，人工操作日志只暂存于 `operator/logs/`，处理完即删除。

## 1. 准备环境与数据

以下命令从 **HiCode 仓库根目录**执行。宿主需要 Git、Bun 1.3+、Python 3.9+ 和 Docker CLI。Mac 上先按 [开发容器说明](../.devcontainer/README.md) 安装 Colima、Compose 和 Buildx，并创建 `hicode` 虚拟机。原生 Linux 可使用自己的 Docker context，但需准备同样的嵌套沙箱策略，详见该文档。

```bash
bun install --frozen-lockfile
bash .devcontainer/linux.sh engine-start
```

这一步只启动 Docker 引擎并加载嵌套沙箱策略，不创建开发或旧评测容器。先登记题包并构建干净镜像，再按文末“重建准备容器”创建 `hicode-eval-clean`，之后启动服务。准备容器不挂载宿主目录或旧评测卷，只缓存固定 HiCode payload；题目依赖仅在镜像构建阶段安装。

将上游题目下载到仓库外，并固定为已审核版本：

```bash
git clone https://github.com/harbor-framework/terminal-bench-2.git ../terminal-bench-2
git -C ../terminal-bench-2 checkout --detach 69671fbaac6d67a7ef0dfec016cc38a64ef7a77c
```

`config/terminal-bench.json` 校验已接入题目的完整文件哈希，题目变更后会拒绝执行。仓库不附带题目或参考解；使用数据集须遵守上游许可与使用条件。无需安装 Harbor。

## 2. 配置模型并固定源码

运行 `bun run start`，用 `/providers` 配置连接、Key 和模型，再用 `/model` 选择默认模型，完成后退出。评测服务读取 **本仓库及用户 `~/.hicode`** 的设置；不读取题目目录或其他项目的模型配置。

也可以复制 [config/example.model.json](config/example.model.json) 为 `../hicode-eval-data/model.local.json`，填写模型 ID、接口地址和 Key 的环境变量名，启动时传 `--model-config ../hicode-eval-data/model.local.json`。此 JSON **不存 Key 值**。Key 从进程环境、本仓库 `.env`、`~/.hicode/.env` 依次补缺；可通过 `/providers` 保存，无需把凭据写进命令行。`source` 目前支持 `qwen`、`deepseek`、`glm`、`openrouter`。

冻结待测版本：

```bash
bash hicode-eval/eval.sh prepare --payload ../hicode-eval-data/payload-v1
```

默认要求工作区干净。测试未提交代码时追加 `--snapshot-worktree`，仅纳入 `src/`、`package.json`、`bun.lock` 和 `tsconfig.json` 的修改。payload 只包含这些运行输入，记录提交号、覆盖文件及归档哈希；每个新版本使用新的输出目录。

原生项目可预编译冻结源码并保存构建产物到题包准备基线，共享依赖镜像保持复用。启动时离线安装本题源码，准备上限为 5 分钟，不占用模型做题预算。

## 3. 登记、准备与提交

准备好原题输入后，登记到持久台账，再按审定配方构建可复用环境：

```bash
bash hicode-eval/eval.sh register-tasks \
  --catalog ../hicode-eval-data/catalog/catalog.json --tasks ../terminal-bench-2
bash hicode-eval/eval.sh prepare-environments \
  --catalog ../hicode-eval-data/catalog/catalog.json \
  --environments ../hicode-eval-data/environments
```

环境分为公共底座、依赖组合、可选题目特殊准备；每次运行只新建容器的可写层。默认准备未通过与待测试，有题包但缺依赖的任务报告 blocked；没有审定题包的任务仍待适配。已通过的任务可之后用 `--ids DATASET:ID` 准备。同名题跨数据集时必须写完整身份；依赖镜像按配方复用，环境绑定按数据集版本和题目 ID 区分。提交批次前会重新核验所选题目的题包、当前配方和镜像；绑定过期时直接拒绝提交，不先产生失败的 Run。公共底座由 `config/clean-base.Dockerfile`、`clean-base-images.json` 的官方镜像摘要及 HiCode 锁文件构建，不再导出缓存机的系统目录。SWE 依赖声明位于 `config/environment-recipes/<环境 ID>.json`，记录完整包版本和 Python 补丁版本；没有配方的组合保持未准备，逐组添加。配方变化产生新的镜像身份，不改旧镜像。系统包与通用判题依赖的实际版本清单位于镜像 `/opt/hicode-environment/`；当前 apt 仓库和通用判题传递依赖仍按构建时解析，尚不承诺跨日期逐字节重建一致。

服务默认每题 1 CPU、4096 MiB，支持 `--cpus`、`--memory-mb`；最多并发 5，默认网络 isolated。

```bash
bash hicode-eval/eval.sh serve \
  --data-dir ../hicode-eval-data/runs \
  --catalog ../hicode-eval-data/catalog/catalog.json \
  --environments ../hicode-eval-data/environments \
  --payload ../hicode-eval-data/payload-v1 \
  --docker-context colima-hicode \
  --machine hicode-eval-clean \
  --concurrency 3
```

服务先部署固定源码，依赖未变时复用生产依赖，否则只在此阶段安装一次。出现服务地址后打开 **http://127.0.0.1:8878**。网页只负责查看；保留服务终端，在另一个终端提交：

```bash
bash hicode-eval/eval.sh catalog
bash hicode-eval/eval.sh submit --file hicode-eval/config/example.batch.json
bash hicode-eval/eval.sh status --batch BATCH_ID
bash hicode-eval/eval.sh wait --batch BATCH_ID --wait-seconds 30
```

将 `BATCH_ID` 替换为提交返回的 ID。同一批次可以混合不同执行时限，任务用 `id` 和可选的 `agentSeconds` 声明：

```json
{
  "name": "本轮测试",
  "tasks": [
    { "id": "cancel-async-tasks", "agentSeconds": 900 },
    { "id": "log-summary-date-ranges", "agentSeconds": 1800 }
  ],
  "concurrency": 3
}
```

省略某题的 `agentSeconds` 时使用服务默认值（1800 秒）；每题可设置 30–7200 秒。并发最多 4，不能超过服务上限。页面逐题显示时限，运行结束后自动补位。实际预算和原题预算均会记录，加长时限属于研发评测条件。固定 15 道回归配置见 [regression15.json](config/regression15.json)。

`--source` 和 `--model` 可成对覆盖已配置模型；自定义连接使用 `--model-config`。更换端口时，所有 CLI 命令都传同一个 `--port`。同一评测机只运行一个服务，不在任务期间部署另一个版本。

CLI 可由人或 Codex 等工具操作，**不依赖 Codex 做调度或判题**。真实任务调用配置的模型并产生费用，离线测试不调用模型。

## 评测网络模式

服务默认允许联网，可用 `serve --network isolated` 改成隔离模式。也可以在提交的批次 JSON 中指定：

```json
{"name":"独立评测","network":"isolated","concurrency":3,"tasks":[{"id":"regex-log"}]}
```

- `open`：做题过程可联网，适用于需要在线资源的任务。
- `isolated`：准备依赖和判题仍可联网；做题时 curl、pip、Fetch 等无法访问外网，模型请求通过固定的模型代理转发。普通依赖可从已准备的本地缓存安装。

不填 `network` 时继承服务默认值。模式随批次冻结，不影响其他批次，也不热切换正在运行的任务。网络隔离失败会停止准备，不自动放开网络。真实模型 Key 留在隔离环境外；代理不接受任意目标网址、跨域重定向或服务端搜索工具。Actor 仅挂入本题、必要运行工具和本题依赖；其他题目、准备缓存、grader 与终端采集留在 Host。本题 HiCode 存储和请求日志仍可用。

## 判题、日志与停止

新增题目的数据库、图片和日历按 `config/terminal-bench.json` 中的 `inputs` 清单精确复制并校验哈希，不复制整个题目目录。图片题需要模型显式支持图片输入。

执行完成后自动上传原题测试并判题；执行期间不向 Agent 提供测试或参考解。使用原测试断言及 pytest 参数，把原 `test.sh` 的安装步骤移到环境准备阶段。`cancel-async-tasks` 还保留原测试辅助文件的复制步骤。

模型明确失败后，评测器会及时结束本次尝试并记录执行失败；确认进程停止和记录完整后，再独立运行原题判题。每题的 verifierPackages 只在作答结束后安装，避免作答时借用这些判题专用依赖。

判题能读取该题安装的 Python 依赖，固定判题版本优先。FEAL 的编译只写入判题专用测试副本；Headless 所需的根目录路径使用判题进程的临时根目录。pytest 缓存写入可写日志目录，警告在展示中汇总，完整输出保留在 `evidence/logs/verifier/output.txt`。

明确公开的自测辅助文件可以单独只读挂载，不开放隐藏验收。路径追踪判题使用停止作答后的独立工作区副本，`/app` 与 `/tmp` 在同一隔离挂载；chroot 能力仅限该判题 user namespace，系统路径仍只读。启动检查 pip 入口与必需命令，初始化完整输出保存到 `initializer.txt`。终端采集与网页轮询约 1 秒。

- `passed` / `failed`：pytest 退出码与本次 CTRF 报告一致，生成有效判分。
- 判题超时、启动失败、未收集到测试或报告不一致：记为异常，无有效判分，不伪造 0 分。
- 执行超时先停止 Agent 再验收；用户取消不判题。执行状态与判题状态分别保存。

```text
宿主 <data-dir>/
  config.json
  batches/<batch-id>.json
  runs/<run-id>/
    state.json / manifest.json
    task/ / task-files.json    原题快照与哈希
    live/events.jsonl          执行事件
    live/screen.txt            最新 TUI 画面
    preparation.log           环境及执行诊断
    verification.txt          原题测试输出摘要（完整输出见 evidence/logs/verifier/output.txt）
    evidence/                 代码、Home、日志等现场
    collection.json           导出校验记录
    evidence/outcome.json     清理前保存的执行/判题事实
    evidence/result.json      清理确认后的最终回执

每题独立容器：/eval/runs/<run-id>/
Linux 运行版本与依赖：/opt/hicode/
```

事件与画面持续传回并增量落盘；完整现场在任务结束时导出，不在事件消费循环中周期复制，避免阻塞判题交接。突然关闭机器可能丢失尚未导出的内容；保留异常容器检查。日志可能含源码、提示词和工具输出，分享前需脱敏。

判题交接使用独立的、关联 run ID 的请求与原子回执：宿主先确认接收，再上传隐藏测试，最后确认就绪或返回上传失败。接收等待最多 30 秒，交接总等待最多 180 秒；取消会结束等待。隐藏测试只在作答进程全部停止后上传。

证据快照记录符号链接目标，不跟随链接。最终导出仍须成功才能提交终态。 导出失败时保留已经确认的执行／判题事实，但不发布分数；页面的执行与判题记录面板可查看失败摘要和采集诊断。

关闭网页不影响任务。Ctrl+C 关闭评测服务会取消当前任务；准备容器可在服务退出后用 `docker --context colima-hicode stop hicode-eval-clean` 停止；它不是运行任务的容器。服务重启不自动重跑或接续已执行的题；从未启动且无执行痕迹的题保留排队，发现其他未完成现场会停止新调度，需先核查现场。确认异常任务已收尾后，可用 `bash hicode-eval/eval.sh resume --batch BATCH_ID` 显式恢复现有排队调度；此命令不清除异常、不重跑已完成题。

取消指定批次：`bash hicode-eval/eval.sh cancel --batch BATCH_ID`。跑完后可让 Codex 读取日志做复盘；可选的 `report --batch BATCH_ID --file report.md` 仅保存人工或外部分析，不调用模型、不改判分。

若任务因清理或收集失败停在 `needs_recovery`，保持服务运行后执行：

```bash
bash hicode-eval/eval.sh recover --run RUN_ID
```

恢复会核验任务身份、原进程已退出、完成事件和判题证据，只清理该题残留进程，重新导出现场并更新原记录；不调用模型、不重新判题、不停止其他题。证据不足或不一致时拒绝恢复并保留现场。重复执行不会重复做题；恢复成功后继续调度已有队列。恢复前状态保存为 `state.before-recovery.json`，核验回执保存为 `evidence/recovery.json`。 Docker 交接等待首个确认最多 25 秒；宿主命令超时会标出实际期限。Docker 交接等执行异常后，服务会短暂等待原 runner 写入结局；若恢复校验通过，会自动对账并继续排队任务。没有可信结局时仍停在 `needs_recovery`，需要人工检查。

网页固定在当前窗口内，任务列表与终端历史分别滚动；调整窗口高度会改变终端可见行数，不会重播输出。

## 扩充题目与开发验证

其他人可以复用这套 CLI、TUI 观察、自动验收和证据收集流程。目前运行器面向 HiCode；接其他 Agent 需要实现相应执行和完成事件适配。

新增题目需审核原始初始化、依赖、路径和判题脚本，补齐 runner 适配与离线测试，再登记完整哈希。不要仅添加题目 ID 或删除原测试来获得通过结果。

每次尝试使用独立容器、网络、Home 和 `/app` 挂载；这是可信的本地研发环境，不是面向陌生用户的安全隔离服务。任务清单可声明固定版本的 Python 包，构建阶段预装，runner 只复制到该题的 `/app/.eval-python`；增加依赖会改变该题环境，诊断分数须与原始环境分开记录。当前不接要求修改系统配置、全局安装依赖或特殊硬件的题。

```bash
bun test hicode-eval/tests
PYTHONPATH=hicode-eval/src/host:hicode-eval/src/worker:hicode-eval/src/datasets python3 -B -m unittest discover -s hicode-eval/tests
bun run check
```

Python 调度辅助代码只用标准库；验收依赖安装在评测镜像中。`web/vendor/` 包含带 MIT 许可的 xterm.js，保留其许可证。运行数据、payload、数据集和凭据放在仓库外，不提交到 Git。

评测任务在独立 UID 与外层只读挂载隔离内使用 `full-access`，允许题目工作区的 Git 写操作，无需人工审批；这不改变日常 HiCode 的权限。控制目录只读，任务进程全部停止后才上传并运行原题测试。宿主系统、其他任务仍受外层隔离保护。

Terminal 的固定包在依赖镜像中分别安装到 `/opt/hicode-terminal/actor` 与 `verifier`，运行时复制到本题目录；没有共享 wheel 缓存或运行时联网补装分支。

题面粘贴与提交分开发送，收到 Agent 的 `model_stream_start` 才确认执行并开始计时。提交后 15 秒无确认会标记启动异常，不消耗整题时限空等。

评测到时先向已确认身份的 HiCode 主进程发送 SIGTERM，最多等待 10 秒收尾，持续收集工具结果和日志，然后清理该题 UID 的残留进程。收尾窗口不用于继续答题，执行状态仍为 timeout；判题通过也不改为 completed。`evidence/shutdown.json` 记录进程是否退出、Turn 是否保存和未闭合的工具调用；强制清理时不伪造缺失事件。

## 接入新的公开数据集

Terminal-Bench 2.0、2.1 和 SWE-bench Verified 共用批次、并发、每题时限、TUI、取消和证据收集；输入校验及判题由数据集模块负责。`Run.dataset` 与题目 ID 共同确定身份。同名题提交时使用 `{ "dataset": "terminal-bench-2.1", "id": "regex-log" }`；只有 ID 在 catalog 中唯一时才能省略 dataset。2.1 的审定范围以独立清单为准，新增题目需逐题核对原 Dockerfile、公开输入和判题依赖，不能因 2.0 有同名题便直接登记。

Terminal 题目从固定上游目录登记；SWE 题目从外部审定的冻结 bundle 登记。当前评测器不下载原始 SWE 数据集或生成题包，接入者需提供题面、原始源码基线、仅供宿主判题的材料、版本回执及文件哈希，格式由 `src/host/sweTasks.ts` 校验。缺少材料先准备题包，不能回退到旧共享环境安装器。

```bash
bash hicode-eval/eval.sh register-tasks --catalog CATALOG --swe-tasks PREPARED_SWE_DIR
bash hicode-eval/eval.sh register-tasks --catalog CATALOG --tasks REVIEWED_TASKS --dataset terminal-bench-2.1
bash hicode-eval/eval.sh prepare-environments --catalog CATALOG --environments ENVIRONMENTS --ids terminal-bench-2.1:regex-log
```

`REVIEWED_TASKS` 指已审定的外部冻结题包目录，不直接使用下载的原始题库。

依赖只通过 `config/environment-recipes/` 和可选特殊准备层构建；题包校验通过不代表已有可用依赖镜像。现有 SWE 配方及其可用性以生产校验为准，其他组合逐组审定、补齐并验证，不因历史通过就视为就绪。

- Agent 仅收到原始题面、指定 base code、仓库自带公开测试和各题独立的 Python 环境，工作目录 `/testbed`。不提供 gold patch、hints、隐藏 test patch 或评分测试名单。
- Agent 结束或超时后先停止该题所有进程，再由宿主读取实际文件，以受保护的安装基线导出新增、修改、删除、二进制及可执行位变化。忽略 Agent 控制的 Git/index/hooks，不采信模型自报补丁。新增且可识别的运行缓存不进入提交补丁，已有夹具与新增源码保留，完整现场仍归档。
- `prediction.json` 使用官方 `instance_id`、`model_name_or_path`、`model_patch` 字段；`patch-manifest.json` 记录原 base commit、安装基线 commit、数据 revision 和补丁哈希。
- 在干净代码、独立依赖和新 Home 中重放补丁，原 hidden test patch 仅此时进入判题视图。使用官方 4.1.0 的对应仓库测试命令、日志解析和 FAIL_TO_PASS/PASS_TO_PASS 评分；保存原始 `logs/verifier/output.txt` 和 `report.json`，不转换成虚构的 CTRF。
- 无完整测试输出、初始化失败或判题超时记为 `unavailable`，不误判模型错误；官方回归测试未通过记为 `failed`。Django 命名测试的异常若有测试正文栈帧，按执行失败记录；加载或 setup/teardown 异常仍保留为 `unavailable`。恢复只核验已有报告和补丁哈希，不重跑 Agent 或判题。

这是 **独立容器研发评测**：使用 venv 替代官方 Conda/实例镜像、从源码归档重建 Git 基线，官方脚本的环境激活及测试文件 reset commit 随之适配，测试、断言和评分规则不变。不能把这些结果表述为官方镜像下的榜单复现。支持范围由题包校验与现有配方共同决定；运行前必须完成新镜像准备和验证。


### 本题边界与环境就绪

作答使用私有文件系统根与明确的系统/运行时挂载。事件导出为 `actor-events/events.jsonl`，终端和判题日志不挂入 Actor。题干前置说明采用本题实际时限和公开测试路径；只有实际隔离网络才声明外网不可用。

接受 HiCode 的 `shutdown` 保存收尾原因；执行超时仍记为 timeout，保存、工具结果配对和 CLI 退出校验继续保留。

Xarray 的依赖与编译条件由配方声明。冻结题包必须携带真实上游 SCM 版本和公开回归预检回执，登记时校验；这些输入证据不能替代对新镜像的验证。Actor 与验收使用分别物化的环境。ARM 仅针对两项已核实且断言实际通过的 non-strict datetime XPASS 补充结果报告，其他 XPASS 和跳过不转换。

### 仅复核已有 SWE 补丁的验收

Django 的 verifier 仅在输出子测试错误时省略参数 repr，保留父测试名、原 traceback 与退出码，避免惰性对象再次抛错破坏报告。不会改写断言或把失败转换为通过。

在原 run 已完成且证据完整、专用评测机可用时，可运行：

```bash
bun hicode-eval/src/cli.ts regrade --data-dir ../hicode-eval-data/container-v1 --run RUN_ID
```

这个命令校验原 `model.patch` 哈希和冻结题包，重新运行原判题，结果保存在 `runs/RUN_ID/rechecks/REVIEW_ID/`。它不再提交任务或调用模型，也不会覆盖第一次的分数和日志。验收未启动或原目标测试没有实际执行时返回 `unavailable`；需要查看 `logs/verifier/validity.json` 和 `output.txt`。历史复验补齐的依赖及其来源单独写在 `dependency-conditions.json`。 若判题需要现有代理，可追加 `--verifier-proxy http://HOST:PORT`（无凭据的 HTTP(S) origin）；仅本次补判联网使用，localhost 测试服务器绕过代理，Actor 和服务配置不变。


## 环境存档与历史清理

`catalog.json` 独立于运行目录，后续失败不抹去历史通过；取消且尚未开始的题仍待测试。`environments/tasks/` 是题目到镜像的绑定，`layers/` 保存构建依据；特殊原生依赖可通过台账的 `preparation` 配方预编译，详情见 [架构文档](../docs/reference/HICODE-EVAL.md)。禁止把隐藏测试、参考补丁或凭据放进环境配方。

完成结果、台账与证据落盘后自动移除容器和私有网络。采集失败保留现场并进入 needs_recovery，`recover` 只核对证据和清理，不再调用模型。

```bash
# 服务空闲且已停止时，先预览，再明确执行。
bash hicode-eval/eval.sh archive-runs --catalog CATALOG --data-dir RUN_DATA
bash hicode-eval/eval.sh archive-runs --catalog CATALOG --data-dir RUN_DATA --apply
```

精简存档在台账旁的 `run-archive/`，包含成绩、最终补丁、判题报告、哈希与日志尾部。清理中断可重复 --apply；未完成时服务拒绝启动。题包、镜像及缓存不在该命令删除范围。

无费用 Docker 集成验证（使用独立临时台账，真实题包、本地假模型）：

```bash
bun hicode-eval/tests/containerSmoke.ts --catalog CATALOG --environments ENVIRONMENTS --payload PAYLOAD --task SWE_TASK_ID
# 取消路径：追加 --cancel
```

假模型不修题，预期执行 completed、判题 failed、收集 complete、容器已移除；它验证运行链路，不代表模型通过率。


## 单题重新运行

在已结束题目右侧点“重新运行”，或执行 `bash hicode-eval/eval.sh retry --run RUN_ID`。创建关联原记录的单题新批次，保留原分数，沿用原题快照、模型、源码版本、网络与预算。重复点击打开同一新尝试；需要再跑一次时，从新尝试的结束记录发起。

“恢复结果”用于 needs_recovery，只核验证据和清理；重新运行则会调用模型。运行中的题不能重跑。当前服务模型或源码 payload 与原记录不同会明确拒绝。可用 `containerSmoke.ts --retry` 验证完整重跑链路，测试仅使用本地假模型。

干净构建回执使用 version 2，记录 `recipeSha256`、父镜像和不可变 imageId。每层保留 `context/` 与 `build.log`；旧 version 1 环境不会被新准备器当作干净环境使用。准备阶段可联网下载公开依赖，作答与判题仍按批次的 isolated/open 设置执行，真实模型凭据不进入构建上下文。

依赖配方同时声明 requirements（运行版本）、buildRequirements（通用编译工具）、buildGroups（需要不同工具版本的编译顺序）和 buildEnvironment（编译变量）。分组只能构建已锁定的运行包；编译专用包在镜像发布前移除，最终重新核对运行版本。独立的 BuildKit 下载缓存仅保存新构建下载的公开包，不进入作答容器。Python 3.6 环境使用固定的 CPython 3.6.15/OpenSSL 1.1.1w 公开源码和 SHA256 构建：先将官方归档放入 `<environments>/runtime-sources/`，构建时复制进临时上下文并再次校验哈希，避免容器内下载超时。源码运行时配方仅支持固定运行依赖，不接受自定义编译变量或分组；现代 Python 镜像保持原构建方式。

这两个缓存文件分别为 `Python-3.6.15.tar.xz`（[python.org](https://www.python.org/ftp/python/3.6.15/Python-3.6.15.tar.xz)，SHA256 `6e28d7cdd6dd513dd190e49bca3972e20fcf455090ccf2ef3f1a227614135d91`）和 `openssl-1.1.1w.tar.gz`（[OpenSSL](https://www.openssl.org/source/old/1.1.1/openssl-1.1.1w.tar.gz)，SHA256 `cf3098950cb4d853ad95c0841f1f9c6d3dc102dccfcacd521d93925208b76ac8`）。源码包只用于构建镜像，不进入 Actor 工作区。

## 重建准备容器

干净准备机是可销毁的源码准备容器，不挂载旧评测卷。完成 prepare-environments 后，将 `HE_ENVIRONMENTS` 设为服务使用的镜像回执目录，从其 `base.json` 读取不可变 imageId，再创建容器：

```bash
HE_BASE_IMAGE=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["imageId"])' "$HE_ENVIRONMENTS/base.json")
docker --context colima-hicode create --name hicode-eval-clean --init --user root \
  --memory 2g --cpus 1 --pids-limit 1024 \
  --security-opt seccomp=unconfined --security-opt apparmor=hicode-development \
  --security-opt systempaths=unconfined \
  --label dev.hicode.role=eval --label dev.hicode.foundation=clean-v2 \
  "$HE_BASE_IMAGE" sleep infinity
docker --context colima-hicode start hicode-eval-clean
```

服务使用 `--machine hicode-eval-clean --environments <干净回执目录>`。已有同名容器先核对镜像与标签，不覆盖其他容器；升级基础配方时另建准备容器并在服务空闲时切换。Docker 引擎/AppArmor 的系统准备仍由 .devcontainer 配置负责。


补判会保留独立证据，不调用模型。若首次补丁导出未完成，但完整工作区收集回执仍在，可以校验原工作区后重建补丁；不会修改原答案或静默覆盖首次成绩。Git 临时库禁用自动后台维护；Sphinx 补齐逐项测试报告，SymPy 测试正文抛错计为测试失败。

Matplotlib 3.6/3.7 待测题使用 Python 3.11，依赖配方同时提供原公开测试要求的绘图、字体、TeX、视频及 PDF 工具。固定哈希的原 FreeType/QHull 源码用于离线编译，两个版本可复用同一套依赖镜像。环境检查包含原题公开测试入口生成、原生模块与字体版本及基础绘图，不以可导入替代完整启动核验。
