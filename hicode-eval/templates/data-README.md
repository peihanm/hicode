# HiCode 评测存储规范

本 README 是此评测根目录唯一的存储和清理规范。评测 Agent 在开始操作、上下文压缩或恢复后必须重新阅读本文件，并核对 `state/settings.json`。规则、路径或生命周期变化时同时更新本文件、仓库中的模板和 AGENTS.md。运行日志不是操作规范。

## 唯一根目录

源码在 HiCode 仓库的 `hicode-eval/`；真实数据和任务配置统一使用本根目录。评测代码目录不保存数据集清单、依赖配方或 Dockerfile；config 已整体进入离线备份。根目录不得位于源码仓库内，不得是 symlink。路径由 `src/host/layout.ts` 生成，禁止另建台账、任意数据根或独立 catalog 路径。

| 路径 | 内容和写入者 | 保留与清理 |
| --- | --- | --- |
| `state/layout.json` | 当前格式身份，只由 init 创建 | 保留，不接收旧格式 |
| `state/settings.json` | 引擎、模型连接声明、并发、预算、缓存配额 | 不存 Key；离线修改，重启后生效 |
| `state/catalog.json` | 当前系统唯一题目成绩和环境状态，worker 或离线持锁命令写入 | 保留，不手改成绩，不导入假 Run |
| `state/batches/` | worker 创建的批次与尝试关联 | 保留小型元数据 |
| `state/maintenance*.json` | 最近清理结果或错误，由资源管理写入 | 仅保留最新回执，不形成第二套台账 |
| `state/preparation.json` | worker 后台环境准备的当前进度与结果 | 仅保留最近一次；取消另列 cancelled，不计依赖失败；就绪状态以 catalog 为准 |
| `state/validation.json` | 最近一次本地假模型 Linux 链路快检回执；与成绩分离 | 只保留最新回执，不计真实模型通过 |
| `datasets/<dataset>/definition.json`、`recipes/`、`runtime.Dockerfile` | 按数据集逐项审定的输入/依赖/运行声明；register 和 prepare 校验 | 存在 Data，不批量导入旧 config，不保存真实 Key或历史评分 |
| `environments/runtime/` | 当前公共运行底座的固定 images.json 与 Dockerfile | 从公开固定来源建立，配方变化重新准备 |
| `state/import.json` | register 的原子导入 journal | 中断后由持锁 gc 回收未入账题包/准备输入；已追加的审定声明保留，不代表登记或就绪，不能当作第二台账 |
| `datasets/<dataset>/tasks/<id>/` | register 校验并复制的冻结题包 | 未测、未通过保留；通过后可由持锁资源清理释放 |
| `environments/tasks/`、`layers/` | 当前环境绑定、层身份及最多 32 KiB 构建日志 | 保留小型重建依据；存在回执不等于镜像可用 |
| `environments/preparations/` | 审定的特殊准备输入 | 仅保留仍被题目引用的材料 |
| `runs/<id>/` | 单题日志、终端、状态、判题和收集回执 | passed 后归档重型目录，保留小型终端和判题记录 |
| `runs/<id>/evidence/terminal-diagnostics.json` | runner 终端采集失败与恢复诊断，仅发生采集异常时生成 | 随原证据保留／压缩；不是作答状态或判题结论 |
| `runs/service/` | 当前 worker/dashboard 的启动、运行和环境维护日志；不存题目或成绩 | 每项只保留一份当前日志，重新运行时覆盖；不混入单题 Run |
| `runs/<id>/evidence.tar.gz`、`archive.json` | 校验过的完整证据包和 SHA256 | 保留；不能直接作为可写工作区或 Actor 输入 |
| `cache/payload/` | 当前冻结的 HiCode 源码与版本 | 有未结束批次时禁止替换；更新只能离线显式处理 |
| `cache/builds/` | 临时构建或导入目录 | 命令 finally 清理；离线 gc 清理残留 |
| `cache/downloads/` | 固定版本公开源码下载和可重建缓存 | 无活动使用且可重建才清理；不存模型日志或 Key |

根目录顶层只允许 README.md、state、datasets、environments、runs、cache 以及 worker 的 `.service.lock/`。旧体系位于根目录之外的离线备份，当前服务不读取、不自动迁移旧记录。`docs/eval/` 保留按数据集的历史结果和最新结论，不能手工修改运行台账来匹配文档。

## 状态与所有权

- `(dataset,id)` 是题目身份，同名题不能混用。当前支持 Terminal-Bench 2.1、SWE-bench Verified、DeepSWE。2.0 留在离线历史中，没有生产执行分支。
- 成绩为 passed / unpassed / untested；环境独立为 unprepared / ready / evicted / failed。删除镜像必须更新环境状态，不能删除成绩。
- worker 是调度、模型凭据、容器、成绩和自动清理的唯一 owner，持有根目录 service lease。register、prepare、gc 和 regrade 必须获得同一 lease，运行服务期间拒绝离线写入。新题可通过 register --live 交持锁 worker 登记；只追加所选新题声明和冻结题包，不覆盖已登记题目或修改已有声明，其他题继续执行。登记与提交/清理共用控制队列，台账登记与成绩/环境更新共用同一写入队列。离线和在线登记复用校验与原子导入。请求超时先查 catalog，不能盲目重复登记。在线服务题补判由 worker 接收，复用同一调度器、台账和冻结执行包，只占一个并发名额；其他题继续执行和提交，操作状态保存在原 Run 的 rechecks 中。同题重跑、准备与补判互斥；关闭取消补判，重启先确认中断补判容器已销毁，清理不明时停止调度。
- 普通 Terminal 补判使用同一 regrade/recheck 入口，不提供重启脚本；须校验原答案、完成事件与容器销毁回执，直接运行原判题，不调用模型。服务题仍要求审定重启脚本与服务快照。判题 PATH 的首项必须对应所选 verifierPython，原测试启动的 python 子进程使用同一已准备环境。
- 已登记题的环境可通过 prepare-environments --live 交给 worker 后台准备，其他题的执行继续；活动或待恢复题不得重建。原题和声明先审定，离线持锁或交 worker 在线登记，准备期间不运行清理，不提交正在构建的题。退出 worker 时取消当前准备、终止其宿主构建/下载进程组，不再启动后续题，再等待锁与 staging 收尾；已完成镜像保留，未完成题不记为依赖失败。
- serve 只读原子记录并转交控制请求，不初始化执行资源。8878 是默认网页端口，8879 是默认 worker 端口。重启网页不停止跑题。
- 作答 CLI 身份固定后，进程存活由同一 pidfd 判断，终端采集只负责画面。采集命令每次最多 2 秒，失败后按 2／4／8 秒退避、保留上一帧并记录 terminal-diagnostics.json，不因采集失败终止作答。启动／输入握手、事件完整性、输出预算和真实进程退出仍严格检查；tmux 错误只记录可信操作名称（如 tmux capture-pane），不拼接完整命令参数、提示词或环境；保留退出码、信号、耗时、超时额度和有界输出，当前模型 Key 在输出截断前脱敏。执行模块修改只在服务空闲时重启部署。
- 完成定义必须同时满足执行 completed、原判题 passed 和收集 complete。错误、超时、取消不伪装成通过。启动前取消没有判题结论。
- Docker create使用独立120秒、start使用60秒的有界预算，不计入模型作答时间。客户端超时不证明daemon取消了创建；未确认的create保留本题容器声明、网络和setup-failed.json的containerCreationPending标记，进入needs_recovery。只由worker在观察到归属匹配的容器后清理并确认收尾；一次空查询不能作为已清理证明。原异常证据保留，重试创建关联新尝试；修复部署仍须等待服务空闲。
- 私有 verifier 只读挂载官方镜像中的 `/opt/ctrf` 与 `/opt/jest-ctrf` 报告工具（存在时），校验目录及 symlink 边界；不开放整份 `/opt`，不把报告工具追加到 Actor 视图。镜像固定 pnpm `.tools` 版本缓存复制到本题容器 `/opt/hicode-verifier-pnpm`，校验并重写内部链接后只读挂载；仅设置 PNPM_HOME，不挂载原 Home、用户设置或整份 /root，禁网判题不下载工具链。
- 每题使用独立容器、网络和可写 Home。作答进程只能通过本题模型网关访问接口；隐藏验收材料在确认 Agent 执行封锁或停止后物化。权限、收尾或证据不明时保留现场并停止新调度。
- 正常完成的服务题必须先确认 `--single-task` 已封锁执行（持久化成功、工具回执完整、无运行或待消费子 Agent），并关闭模型网关；保留 HiCode Runtime 及其托管 Shell 服务，让私有 verifier 在独立文件／PID 视图中访问本题服务。判题完成、取消或失败后再关闭 Runtime、服务 namespace 和容器。未确认封锁不得暴露隐藏测试；超时／作答失败仍走原有停止确认，不保证服务存活。不能通过关闭全局 Task 清理或自行 daemonize 来替代此交接。
- 默认允许联网，数据集适配器按原题许可逐题收窄；Terminal-Bench 2.1 只有冻结 task.toml 的 environment.allow_internet=true 才开放，false／缺失则隔离，DeepSWE 始终隔离。settings 和批次 network=isolated 可进一步禁网，open 不能覆盖原题限制。同批允许混合模式，实际模式写入各 Run，retry 沿用原模式。服务题联网时共享本题独立容器的网络，禁网时保留私有无外网 namespace；两者均保留文件、进程、隐藏判题隔离和本题模型网关，真实 Key 不进入作答环境。修改默认配置只在空闲 worker 停止后持 service lease 原子保存，再恢复服务；不改变已有 Run。

模型强度随连接声明保存在 `state/settings.json` 的 `model.reasoning.effort`。init 可从 HiCode 当前 Settings 导入；submit 的 --reasoning 选项优先于文件顶层；文件顶层 `reasoning: {effort: "max"}` 覆盖本批，省略沿用服务默认，`default` 保留厂商默认参数省略语义。批次冻结完整模型选择，manifest/job/Actor/模型网关均使用原值；retry 沿用原强度，regrade 不调用模型。不得给旧记录推填强度，实际字段查请求日志。GLM 5.3/5.3 Flash 强制思考，网关不接受 off；后台复盘沿用本 Turn 冻结的模型强度，不再按用途关闭思考或降为 low。方舟 Agent Plan 为独立 `ark-agent-plan` 来源，使用 `ARK_AGENT_PLAN_API_KEY` 和专属 `/api/plan/v3`，与其他账号分开。DeepSeek 4.1 Flash 的 default 省略 effort、off 编码 none；网关显式档位只接受冻结值，default 保留 Provider 现有的有限停滞恢复，不混用其他思考开关。更新源码只在空闲时更新 payload 与重启 worker，不需重建题目依赖镜像。

评测 worker 支持多模型批次共存：state/settings.json 的 model 是默认连接，models 是额外审定连接列表，source/model 组合必须唯一。新 submit 可通过顶层 model: {source, model} 或 --model-source SOURCE --model MODEL 选择，CLI 优先；只能选择已配置连接，不能随请求覆盖 baseUrl、apiKeyEnv 或传 Key。未选模型沿用默认；强度优先级为 CLI、提交顶层 reasoning、所选连接默认、厂商 default。worker 启动在边界读取所有声明凭据（进程环境→项目.env→用户.env），只驻留内存；逐题按冻结 batch.model 选择对应 Key。不同模型批次共用全局并发上限及 service lease；retry/continue 沿用原模型、连接与强度，不要求它仍是默认，但原连接必须仍在配置中且完整匹配（默认强度变化不影响冻结值）。追加或更换连接与 Key 仍需空闲时重新加载 worker；已配置模型之间提交无需切账号或重启。单批次仍冻结一个模型，不增加逐题覆盖或第二套调度。

## 镜像的实际存放位置

镜像和 BuildKit 缓存位于 `state/settings.json` 指定 Docker context 的 Linux Docker Root，不是本目录里的 tar 文件。用显式 `docker --context CONTEXT info --format '{{.DockerRootDir}}'` 查询。Colima 的宿主数据盘由 Colima 管理；本机实际 profile、数据盘文件和容量记录在本节末尾的“本机定位”。禁止直接删除 Docker Root 或虚拟磁盘，禁止无范围 system prune。

- 环境必须由固定配方或官方 digest 重建，配方保存在 Data 的数据集/运行目录，不保存镜像、真实题包和运行产物。
- cleanup 先核对所有题目绑定、活动任务和运行/停止容器引用。公共底座保留；共享依赖只要仍被未测、未通过题引用就保留。
- 通过题专用镜像可删除，使用明确 imageId 和本系统标签，不能强制删除冲突镜像或误删外部标签。Docker 不可达必须保留待处理状态。
- 所有任务结束且没有 needs_recovery 后，worker 自动执行资源收尾。人工 gc 默认预览，`--apply` 才删除。
- BuildKit 清理仅在 `gc --apply --build-cache` 时执行，保留默认 8 GB，只清理超过 7 天的缓存；不能为了空间不足放宽执行隔离。
- 新 Docker 后端必须先通过正式容器的 AppArmor、内层 user namespace 与 seccomp 预检；能运行题目测试不等于能运行 HiCode Sandbox。跨架构翻译后端在预检通过前只能用于离线性能实验。
- Apple Silicon 上的 DeepSWE 使用 VZ + Rosetta 混合层时，HiCode、Bun、Bubblewrap、socat、apply-seccomp 和 runner Python 必须为 ARM64 原生，官方题目与 verifier 保持 AMD64。数据集 runtime.Dockerfile 只可通过 `{{runtime_<name>}}` 使用公共 images.json 的固定 ARM64 输入；EnvironmentStore 校验 digest/架构并冻结 AMD64 构建平台。必须通过完整假模型 runner、收集和隐藏判题 smoke 后才能投入真实评测。
- Rosetta 题容器的模型域名由 worker 在宿主解析，只接受实际取得的公网 IPv4，并通过本题 `--add-host` 固定；HTTPS URL、Host、SNI 和证书验证保持原域名。宿主解析不可用或没有公网 IPv4 时，使用受限的 AliDNS HTTPS A 查询，校验问题域名、CNAME 链、响应大小和公网地址；失败仍拒绝启动。不修改 VM/系统 DNS、代理或 TLS 验证，也不写入猜测地址。本地假模型和直接 IP 不使用该映射。
- 用户明确授权修复 Colima 自身 DNS 入口时，只操作指定 profile，使用 VM 的 networkctl 实际报告的上游，修复失效的 resolv.conf；需要持久化时使用该 profile 的幂等启动 provision。正常 DNS 入口保持不变，不更换公网解析器、不修改宿主 DNS/代理或 TLS，不把此维护操作加入题目执行链。验证包括普通域名解析、原域名 HTTPS 和 Docker 官方 digest 拉取；已有镜像的拉取不作为下载带宽证据，重启持久性未经重启实测不能宣称已验证。
- Docker daemon 若持续卡在 `Initializing buildkit`，常规路径仍使用受管 BuildKit GC。只有在服务完全空闲、daemon 无法启动且任务镜像确认由 containerd 保留时，才可停止 Docker，把唯一的 `/var/lib/docker/buildkit` 可重建元数据移动到 VM 内明确的恢复目录；禁止删除 Docker Root，并须验证镜像、正式安全预检和 worker 后再恢复评测。
- 扩容只用 Colima 官方命令，在无活动评测、构建及容器执行时调整指定 profile；不直接改虚拟盘文件，不切换默认 Docker context，不停止其他项目的虚拟机。
- 内存与并发调整须预留虚拟机系统余量，同时核对服务总并发（包含补判）和批次并发；每题内存上限不是预留内存。用户授权调整数据集默认资源时，在空闲worker停止后持同一service lease校验并保存settings，重启后验证生效，记录实际资源；重型题运行期间不同时构建环境。
- 已退役的专用 Colima profile 仅在用户明确授权、当前 settings 和环境绑定不再引用、无活动或待恢复任务时，使用 `colima delete --profile NAME --data --force` 清理；保留宿主题目、成绩、日志和离线备份，不直接删除虚拟盘文件。
- Docker 内释放空间不保证 Mac 文件立即缩小。服务空闲时可对审定 Colima 数据盘执行 fstrim，再分别测 Linux df 和宿主 du；不要通过重建空盘掩盖实际占用。

## 日志归档与备份

服务题补判在原 Run 的 `rechecks/<reviewId>/` 保存输入哈希、原成绩、原测试日志、结果、operation.json 操作状态及容器销毁回执。仅恢复已封锁且完整收集的答案和服务快照；重启脚本只能恢复服务并清除上次测试副作用，不能改答案或测试。补判不调用模型，真实结果更新当前 Run 和台账，原证据保留；与 worker 使用同一 service lease。

通过题收集完成、成绩入账、容器销毁回执确认后，先核验原证据哈希，再打包 evidence、task、inputs、public-test-inputs 和 worker。完整读取压缩包校验后写 SHA256 回执，最后才删除原目录。取消、异常和未通过现场保留供复核，不默认删除。归档失败保留原文件和错误回执，不改变题目成绩。

DeepSWE 证据导出保留完整 Actor project/Home、执行事件、原题、补丁与判题日志；跳过根目录的 baseline、verifier-project、verifier-home 三份可由固定镜像与补丁重建的副本，不跳过 Actor 内同名目录。保留 100000 条目／8 GiB 边界。收集使用当前 worker 启动时冻结的导出模块，collection.json 记录 exporterSha256；恢复已停止题目不覆盖原执行模块、不调用模型。

Linux 的大小写／Unicode 冲突路径在宿主 evidence 中使用可还原的存储名，映射保存在 `.hicode-evidence-paths.json` 并进入 collection.json 的哈希回执。不得按 Mac 上的存储名反推原答案、删除冲突条目或跟随 symlink；原路径仅在 Linux 判题副本中恢复。导出视图位于单题容器 `/eval/evidence-export/<runId>`，随容器销毁，不另建永久数据目录。

Terminal-Bench 2.1 和 DeepSWE 的可续跑现场只由 runner 在超时、取消或模型失败且完整停机后、隐藏判题上传前生成。`runs/<id>/evidence/continuation.tar.gz` 与 `continuation.json` 保存工作区、Home、原会话身份、累计执行时长、本地模型网关端口和审定服务目录；压缩包及解压内容均受 8 GiB／100000 文件上限约束，不跟随 symlink。标准入口不能拿判题后的 project/Home 当续跑输入，不能为旧记录人工补造快照。

DeepSWE 的当前格式完整收集超时尝试若无正式快照，可显式用 continue --restore-actor 恢复封存 Actor：必须核验原冻结执行/隔离/判题模块与当前审定代码一致（判题使用独立 workspace/Home）、完整 shutdown seal、会话保存、收集哈希和容器销毁回执；只取 Actor project/Home，不取 verifier 副本、隐藏测试或判题日志。不改原证据或成绩，不伪称此前已有快照；新尝试记 continueOf.inputSource=sealed-deep-actor，临时包放 cache/builds 并在发布/失败后清理。

continue 由同一持锁 worker 创建新的关联尝试，追加 30–10800 秒，冻结原模型、强度、网络、题目、payload 和环境身份；保留原成绩。恢复时沿用快照记录的模型网关端口，保持思考回放的连接身份。网页只读小型快照元数据，提交及执行前才核验完整哈希。新 Run 的 `continuation-input.tar.gz` 仅用于恢复，恢复后删除容器内副本，完整收集后删除宿主副本；原快照留在父 Run。恢复仅为原 Home 路径提供绑定到本题新 Home 的受限别名，不挂载原 Run、控制目录或隐藏测试。服务重启和训练 checkpoint 恢复由模型处理，不恢复进程内存或临时 tmpfs。活动、待恢复或已通过题拒绝续跑；无有效快照且不满足上述 DeepSWE 封存恢复条件的尝试拒绝续跑。SWE-bench Verified 未开放此能力。

旧体系备份只用于人工查阅。需要重建某题时，从公开题库/审定配方重新验证，或显式 register 一份已核对的冻结题包；不恢复旧服务配置、成绩 JSON、环境绑定或运行状态。备份未核验前不得删除唯一原件。

执行初始化只校验冻结 HiCode payload；release 和执行模块在每题的数据集镜像内安装并预检，不依赖其他数据集引擎的常驻准备容器。

HiCode作答与续跑启动必须显式使用冻结release的tsconfig（bun --tsconfig-override），不能受题库工作目录的JSX配置影响；不修改原题tsconfig、工作目录或做题工具的运行配置。 进程识别必须匹配同一完整Bun启动参数与本题UID，再取得唯一pidfd；不得假定源码入口处于固定参数位置。

## 操作入口

环境构建直连软件源超时时，先验证现有构建代理可用，再通过 `prepare-environments --live --build-proxy URL` 交给同一 worker；代理只作用于本次镜像构建，不修改系统代理、模型连接或 Actor 网络策略。

从 HiCode checkout 执行 `bash hicode-eval/eval.sh --help`。所有命令使用 `--root DIR`。顺序：init → register → prepare-environments → prepare → worker/serve → submit → 原判题 → 资源收尾。源码变更先进行离线定向测试，无需为每次查看状态跑全量验证。假模型和环境快检不能记作真实通过。

## 本机定位

此节仅由本机维护，不进入 Git：数据根、离线备份根、Docker context、Colima profile、Docker Root、数据盘文件、磁盘容量和服务端口。实际值以 settings 和引擎查询为准。

审定服务题可声明 verifierProcessView 与 /tmp 下具名 verifierSockets；只向私有判题提供本题封锁时的服务 PID 目录和指定归属 socket，判题仍使用独立 PID namespace，self/net 来自自己的 Proc。Proc 构造辅助进程进入服务 PID 前先 chroot 到空 tmpfs，隐藏文件不能经辅助进程 root 暴露；socket 放本题 service-tmp，只绑定审定文件，不开放整份 tmp 或控制目录。

批量续跑使用 continue-batch 控制请求，由同一 worker 审定并原子发布一个批次；batch.continuations 按新 Run 分别冻结原会话与快照。启动失败且没有输入确认或 Agent 事件的尝试，在收集/销毁校验后复用原输入；开始作答后必须用新保存的正式快照，不能退回原输入。DeepSWE 已封锁、完成的答案可使用同一在线 regrade/recheck 链路补判（含判题时取消的尝试），占一个共享并发名额，与其他题和后台环境准备并行，不争第二把总锁，不调用模型。

公共运行底座保留；DeepSWE 的逐题官方镜像封装底图不属于公共底座，仅被通过题引用且无容器占用时可回收。按题目层、依赖层、底图的顺序删除，不强制删除有引用的镜像。

DeepSWE 作答失败但完整停止的原答案也可补判：必须校验收集哈希、保存完整的失败事件、shutdown 停机证明和容器销毁回执；补判仅更新独立判题结果，不能把 failed 执行改成 completed。

DeepSWE 的 Go 私有判题从固定镜像 `/root/go/bin` 校验并复制普通可执行文件到新 verifier Home 的 `go/bin`，只对这些已校验的工具文件逐个只读挂载；`go/bin` 目录保持本题用户可写，允许测试新建日志或自己的构建产物，不把整目录设为只读。保留独立可写 Home 和模块缓存，不使用 Actor 安装的工具，不暴露镜像 Home 或在禁网判题时下载。

只有用户明确要求放弃已取消且收集失败的现场，才可通过同一 worker 的 `abandon-cancelled-run` 结束该尝试；先复用原 recovery 校验真实停机和 cancelled/unavailable 结果，保存 runs/<id>/abandonment.json 停机证明，再销毁本题容器。保留本机日志，明确丢弃未完整收集的工作区；collection 仍为 retained，不提供续跑、不造完整回执或通过成绩。普通取消和 recover 不自动丢弃现场。

DeepSWE 正常收尾和 retained 恢复共用冻结的 evidence_export，并使用 ARM64 原生控制 Python：完整 Actor 因 project/node_modules 超过 100000 条目时，自动只在导出视图将该依赖树分成每包最多 50000 条目的存储归档，逐文件回读校验字节、模式、链接及未变更状态；dependency-archives.json 记录原路径、条目、原字节数、树哈希和分包 SHA256。依赖树另有 1000000 条目预算，原始依赖与其他证据合计仍限 8 GiB，导出文件仍限 100000 条目／8 GiB；非依赖源码／日志超限继续拒绝。原 Actor、Git、补丁和日志不改，不删除原依赖；失败清理导出视图并保留现场，重试重新生成。归档不自动解压、不作为自动续跑依赖，补判从固定镜像重建依赖。

DeepSWE原题使用缩写Git基线时，declaredBaseCommit保存原始引用，baseCommit冻结官方完整40位提交，必须核验前缀与固定镜像HEAD；不改原题metadata、collect、文件哈希或验收。镜像型题的特殊依赖按审定preparation脚本构建独立task层，核验输入哈希，不通过修改活动题共享运行配方来补依赖。

重型镜像准备可使用 `prepare-environments --live --after-evaluations`：请求立即入队，进度记录 waitingForEvaluations；有执行或排队评测时不启动构建，空闲后由同一worker继续。关闭会取消等待，不新建外部后台进程。

评测容器的文件句柄（nofile）软／硬上限由 RunContainers 显式设置为 65536，不继承 Docker 的 1024 软上限；不改 VM／Docker 全局配置。该额度与收集的 100000 条目／8 GiB 边界无关。源码变更经空闲 worker 重启后仅对新容器生效，不修改现有 Run。

DeepSWE 固定镜像含 /root/.cache/ms-playwright 时，作答准备和独立判题将经校验的浏览器缓存复制到 /opt/hicode-task/ms-playwright，内部链接须留在缓存内并重写为相对链接；限定25000条目／2 GiB，只复制普通文件、目录和内部链接。目录通过现有依赖视图只读挂载，两种独立 Home 使用同一 PLAYWRIGHT_BROWSERS_PATH；不暴露/root、不使用Actor下载结果、不在禁网判题时下载。无该缓存的题目不追加浏览器依赖。修改执行模块须等全部评测／构建空闲后重启worker生效。

DeepSWE 的 Go 镜像准备必须用固定源镜像中 `GOTOOLCHAIN=local go env GOMODCACHE` 的实际目录复制模块与工具链缓存到 `/opt/hicode-go/pkg/mod`，不得假设缓存位于 `/root/go/pkg`；源缓存缺失或为 symlink 时构建失败。Actor 与独立 verifier 均须在禁网隔离视图中验证工具链和所需模块可读，不能以目录存在代替可用性验证。

DeepSWE 私有 verifier 的 Corepack 缓存从固定镜像 /root/.cache/node/corepack/v1/pnpm 经有界校验复制到 /opt/hicode-verifier-corepack，保持内部链接并只读挂载。固定镜像若有 lastKnownGood.json，只读取最多16 KiB的普通非链接文件；仅保留 pnpm 激活记录，校验版本格式并确认该版本目录实际存在于固定缓存，拒绝外部路径和未缓存版本，不复制其他包管理器设置。私有判题显式设置 COREPACK_HOME、COREPACK_ENABLE_NETWORK=0、COREPACK_DEFAULT_TO_LATEST=0，使用固定激活版本，不查询最新版本；Actor不可见，不挂载镜像Home、不在判题时下载。
