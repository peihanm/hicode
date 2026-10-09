# 选题与干净环境准备

本流程用于“选 N 题”“先准备，等代码改完再跑”和新增依赖组合。实现及参数以 `hicode-eval/src/cli.ts`、`src/host/environments.ts` 与 README 为准。

## 选题

一次读取当前服务配置、catalog、活动任务及现有配方。用户允许代选时，按评测目的兼顾数据集、项目、任务类型和历史状态；第一批新环境回归可主要选择历史通过题，搭配少量失败/未测题，并记录构成，不能将它称为无偏总体通过率。只选择具有审定题包的候选；缺输入与缺依赖分别记录。

核对公开题面、原环境声明和现有适配，不读取参考解来选题。旧机器自带的编译器、命令和 Python 包可能掩盖 profile 缺项：对照原 Dockerfile/依赖声明补入明确配方，不能只查看旧通过状态。选定后缺环境优先解决或报告，不静默换简单题凑数。

提交 JSON 放外部 `operator/batch-configs/`，只包含 CLI 支持的 name/network/concurrency/tasks 字段。仍需处理的准备结论另放 `operator/records/`，记录题目来源、选择理由、历史状态、准备结果和待冻结源码状态，不把这些字段塞入提交 JSON。以待提交清单称呼它，不虚构 batch ID。

## 准备镜像

1. 核对现有服务和 Docker 引擎。已有题包无需重新登记；新增登记要求服务释放 catalog 写锁，不能绕过锁改正在使用的台账。
2. `register-tasks --catalog FILE --tasks DIR` 或 `--swe-tasks DIR` 校验并登记外部题包。DeepSWE 使用 `--tasks DIR --dataset deep-swe --ids deep-swe:ID,...`，只登记审定选题。缺失 SWE bundle 先提供审定输入；没有旧共享机安装入口。
3. `prepare-environments --catalog FILE --environments DIR --ids DATASET:ID1,DATASET:ID2` 只准备选定题目（显式 IDs 包含历史通过题）。同名题跨数据集时必须带数据集版本；默认不传 IDs 会处理其他未通过/待测任务，因此小批准备必须传 IDs。
4. DeepSWE 原镜像为 AMD64，使用 `--dataset-backends FILE` 指定经过完整隔离验证的 x86-64 Linux 引擎；按不可变官方镜像添加 `deep-runtime.Dockerfile` 运行层，不能套用 ARM 公共底座。其他数据集公共底座由 clean-base.Dockerfile、clean-base-images.json 和锁文件生成。SWE 配方在 `config/environment-recipes/<environment-key>.json`；Terminal profile 声明工具和 actor/verifier 包。复用相同不可变镜像，缺配方时逐组补齐。不要从旧容器导出系统目录或虚拟环境。
5. 查看本次 `preparation-report.json` 的 prepared/failed/unprepared，保存选题专属副本，避免下次准备覆盖唯一证据。构建失败查看对应 layers/*/build.log；不在运行容器里临时安装补救。

`environmentPrepared` 只是存在准备回执。最终按生产 `EnvironmentStore.resolve(task)` 核对选定题目的源哈希、当前配方与最终镜像标签；还要确认依赖链所引用的镜像存在。底座、依赖或源码变化后不能沿用过期结论。

按依赖组合批量快检必要命令、解释器和关键库。新组合使用 `tests/cleanEnvironmentSmoke.ts --catalog FILE --environments DIR --payload DIR --task ID` 离线安装公开源码、检查导入，并用实际 Git 工作树和冻结 HiCode payload 执行非 root、无外网 Actor namespace 内的沙箱预检。结果记录镜像身份、源码包 hash 和 `actorSandboxReady`；镜像、题包结构或 payload 变化后重新核验受影响组合。尚未冻结 payload 时只能记录依赖就绪，不声称完整启动已验证。SWE 的 `repository/.git`、`.git/hooks` 必须是真实目录；缺失空目录不影响文件哈希，登记/提交会独立检查并提前拒绝。仅发现具体兼容问题时扩大到相关题检查，不逐题跑参考解或完整基线。检查不应用隐藏补丁、不调用真实模型、不改变历史分数。

依赖下载缓慢时先检查本机现有代理；`prepare-environments --build-proxy URL` 只设置 Docker 构建代理参数，不保存在镜像 ENV 或传给做题进程。可仅为构建或下载命令显式使用已验证的代理，保持原配方、公开来源和固定版本，完成后仍经 `EnvironmentStore.resolve` 校验。不得修改全局网络配置或把构建代理传入 Actor，也不因下载失败改成 open。操作日志只暂存 `operator/logs/`，问题解决后删除。

声明了 initializer 的题目还需验证初始化本身：在一次性容器的非 root、无网络 namespace 中，使用实际题包输入执行并检查产物。包可导入不代表在线 clone、下载或初始 Git 历史已就绪。外部仓库失效时优先核对原题声明的固定镜像，只提取公开题目材料并校验固定提交/哈希；不要导入旧系统或编造替代仓库。保留初始化证据，未通过不得标记为可提交。

新机器使用 `bash .devcontainer/linux.sh engine-start` 准备引擎策略。按 README 从 `environments/base.json` 的 imageId 创建无挂载的 hicode-eval-clean；不启动或恢复旧评测机。不因依赖组合增多就另建 Linux 虚拟机。

## 交接待测版本

用户仍在修改 HiCode 时，可以完成题组和依赖准备，但不冻结中间版本、不提交批次。准备记录应写清 `payload=null` 或等价待冻结状态，当前服务的旧 payload 仅作定位信息。

开始测试前核对最新 Git SHA、工作区和验证结果；按用户实际要测的版本运行 `prepare --payload NEW_DIR`，只有明确测试未提交源码时才追加 `--snapshot-worktree`。核对新 manifest，并在服务空闲时切换到新 payload。若 package.json/bun.lock、环境配方或题包在等待期间变化，先重新检查受影响环境。

交付说明题数及构成、准备成功/阻塞数、清单位置、并发和单题时限，以及是否已启动模型。不要把“等代码完成”变成后台自动启动承诺。
