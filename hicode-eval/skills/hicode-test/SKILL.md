---
name: hicode-test
description: HiCode 公开题的环境准备、独立容器评测和结果归档。
---

# HiCode 公开题评测

先定位 checkout 的 hicode-eval 和用户指定的唯一评测根目录。操作前、上下文压缩或恢复后必须读根目录 README.md 和 state/settings.json；存储规范只在该 README 维护，不依据旧日志猜路径。当前命令以 checkout 的 eval.sh --help 为准。

- 选题与准备：从 docs/eval 对应数据集选择未通过、未测题，校验固定题库、完整输入和原判题，再 register 和 prepare-environments。镜像可启动不等于隔离链可用；不能放宽安全边界。准备不调用模型、不造分数。
- 提交：使用同根目录 worker，核对冻结 HiCode 版本、模型来源、并发和单题时限，任务必须含 dataset/id。提交超时先查是否已落盘，不能重复提交。未经用户要求不调用真实模型、不自动重跑失败题。
- 结果：先查状态，再读异常证据。通过必须执行 completed、原判题 passed、收集 complete。结果归档到按数据集持续维护的 docs/eval 页，不新建批次报告。
- 收尾：遵守根 README 的引用和归档规则。通过题专用镜像可回收，共享镜像保留；日志压缩保留，不手删台账或活动资源。gc 默认预览，离线写入必须获得 worker 同一 service lease。
- 历史：旧备份只供人工查阅，运行代码不兼容旧格式。Terminal-Bench 2.0 不进入当前执行链。旧成绩不会通过伪造 Run 导入新台账。
- Git：代码在 HiCode 仓库，本机数据、docs/eval 和 AGENTS.md 不强制加入 Git。用户明确要求才 commit/push，不为备份另建 Git 项目。

详细执行条件见 checkout README.md；本机位置、准备和操作参考仅指向当前存储规范，不维护第二套规则。
