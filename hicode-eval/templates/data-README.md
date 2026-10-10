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
| `state/preparation.json` | worker 后台环境准备的当前进度与结果 | 仅保留最近一次；就绪状态以 catalog 为准 |
| `state/validation.json` | 最近一次本地假模型 Linux 链路快检回执；与成绩分离 | 只保留最新回执，不计真实模型通过 |
| `datasets/<dataset>/definition.json`、`recipes/`、`runtime.Dockerfile` | 按数据集逐项审定的输入/依赖/运行声明；register 和 prepare 校验 | 存在 Data，不批量导入旧 config，不保存真实 Key或历史评分 |
| `environments/runtime/` | 当前公共运行底座的固定 images.json 与 Dockerfile | 从公开固定来源建立，配方变化重新准备 |
| `state/import.json` | register 的原子导入 journal | 中断后由离线 gc 回收未入账输入，不能当作第二台账 |
| `datasets/<dataset>/tasks/<id>/` | register 校验并复制的冻结题包 | 未测、未通过保留；通过后可由持锁资源清理释放 |
| `environments/tasks/`、`layers/` | 当前环境绑定、层身份及最多 32 KiB 构建日志 | 保留小型重建依据；存在回执不等于镜像可用 |
| `environments/preparations/` | 审定的特殊准备输入 | 仅保留仍被题目引用的材料 |
| `runs/<id>/` | 单题日志、终端、状态、判题和收集回执 | passed 后归档重型目录，保留小型终端和判题记录 |
| `runs/service/` | 当前 worker/dashboard 的启动、运行和环境维护日志；不存题目或成绩 | 每项只保留一份当前日志，重新运行时覆盖；不混入单题 Run |
| `runs/<id>/evidence.tar.gz`、`archive.json` | 校验过的完整证据包和 SHA256 | 保留；不能直接作为可写工作区或 Actor 输入 |
| `cache/payload/` | 当前冻结的 HiCode 源码与版本 | 有未结束批次时禁止替换；更新只能离线显式处理 |
| `cache/builds/` | 临时构建或导入目录 | 命令 finally 清理；离线 gc 清理残留 |
| `cache/downloads/` | 固定版本公开源码下载和可重建缓存 | 无活动使用且可重建才清理；不存模型日志或 Key |

根目录顶层只允许 README.md、state、datasets、environments、runs、cache 以及 worker 的 `.service.lock/`。旧体系位于根目录之外的离线备份，当前服务不读取、不自动迁移旧记录。`docs/eval/` 保留按数据集的历史结果和最新结论，不能手工修改运行台账来匹配文档。

## 状态与所有权

- `(dataset,id)` 是题目身份，同名题不能混用。当前支持 Terminal-Bench 2.1、SWE-bench Verified、DeepSWE。2.0 留在离线历史中，没有生产执行分支。
- 成绩为 passed / unpassed / untested；环境独立为 unprepared / ready / evicted / failed。删除镜像必须更新环境状态，不能删除成绩。
- worker 是调度、模型凭据、容器、成绩和自动清理的唯一 owner，持有根目录 service lease。register、prepare、gc 和 regrade 必须获得同一 lease，运行服务期间拒绝离线写入。
- 已登记题的环境可通过 prepare-environments --live 交给 worker 后台准备，其他题的执行继续；活动或待恢复题不得重建。原题和声明先离线审定，准备期间不运行清理，不提交正在构建的题。退出 worker 时等待准备收尾。
- serve 只读原子记录并转交控制请求，不初始化执行资源。8878 是默认网页端口，8879 是默认 worker 端口。重启网页不停止跑题。
- 完成定义必须同时满足执行 completed、原判题 passed 和收集 complete。错误、超时、取消不伪装成通过。启动前取消没有判题结论。
- 每题使用独立容器、网络和可写 Home。作答进程只能通过本题模型网关访问接口；隐藏验收材料在确认 Agent 停止后物化。权限、收尾或证据不明时保留现场并停止新调度。
- 默认允许联网，数据集适配器按原题许可逐题收窄；Terminal-Bench 2.1 只有冻结 task.toml 的 environment.allow_internet=true 才开放，false／缺失则隔离，DeepSWE 始终隔离。settings 和批次 network=isolated 可进一步禁网，open 不能覆盖原题限制。同批允许混合模式，实际模式写入各 Run，retry 沿用原模式。服务题联网时共享本题独立容器的网络，禁网时保留私有无外网 namespace；两者均保留文件、进程、隐藏判题隔离和本题模型网关，真实 Key 不进入作答环境。修改默认配置只在空闲 worker 停止后持 service lease 原子保存，再恢复服务；不改变已有 Run。

## 镜像的实际存放位置

镜像和 BuildKit 缓存位于 `state/settings.json` 指定 Docker context 的 Linux Docker Root，不是本目录里的 tar 文件。用显式 `docker --context CONTEXT info --format '{{.DockerRootDir}}'` 查询。Colima 的宿主数据盘由 Colima 管理；本机实际 profile、数据盘文件和容量记录在本节末尾的“本机定位”。禁止直接删除 Docker Root 或虚拟磁盘，禁止无范围 system prune。

- 环境必须由固定配方或官方 digest 重建，配方保存在 Data 的数据集/运行目录，不保存镜像、真实题包和运行产物。
- cleanup 先核对所有题目绑定、活动任务和运行/停止容器引用。公共底座保留；共享依赖只要仍被未测、未通过题引用就保留。
- 通过题专用镜像可删除，使用明确 imageId 和本系统标签，不能强制删除冲突镜像或误删外部标签。Docker 不可达必须保留待处理状态。
- 所有任务结束且没有 needs_recovery 后，worker 自动执行资源收尾。人工 gc 默认预览，`--apply` 才删除。
- BuildKit 清理仅在 `gc --apply --build-cache` 时执行，保留默认 8 GB，只清理超过 7 天的缓存；不能为了空间不足放宽执行隔离。
- Docker 内释放空间不保证 Mac 文件立即缩小。服务空闲时可对审定 Colima 数据盘执行 fstrim，再分别测 Linux df 和宿主 du；不要通过重建空盘掩盖实际占用。

## 日志归档与备份

通过题收集完成、成绩入账、容器销毁回执确认后，先核验原证据哈希，再打包 evidence、task、inputs、public-test-inputs 和 worker。完整读取压缩包校验后写 SHA256 回执，最后才删除原目录。取消、异常和未通过现场保留供复核，不默认删除。归档失败保留原文件和错误回执，不改变题目成绩。

旧体系备份只用于人工查阅。需要重建某题时，从公开题库/审定配方重新验证，或显式 register 一份已核对的冻结题包；不恢复旧服务配置、成绩 JSON、环境绑定或运行状态。备份未核验前不得删除唯一原件。

执行初始化只校验冻结 HiCode payload；release 和执行模块在每题的数据集镜像内安装并预检，不依赖其他数据集引擎的常驻准备容器。

## 操作入口

从 HiCode checkout 执行 `bash hicode-eval/eval.sh --help`。所有命令使用 `--root DIR`。顺序：init → register → prepare-environments → prepare → worker/serve → submit → 原判题 → 资源收尾。源码变更先进行离线定向测试，无需为每次查看状态跑全量验证。假模型和环境快检不能记作真实通过。

## 本机定位

此节仅由本机维护，不进入 Git：数据根、离线备份根、Docker context、Colima profile、Docker Root、数据盘文件、磁盘容量和服务端口。实际值以 settings 和引擎查询为准。
