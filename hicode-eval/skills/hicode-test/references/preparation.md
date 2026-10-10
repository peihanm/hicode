# 准备入口

先读数据根 README.md 和 checkout 的 hicode-eval/README.md。只选 docs/eval 中未测或未通过题。register 显式指定 dataset、原题目录和 IDs，将校验后的题包复制到唯一根；prepare-environments 使用固定公开依赖配方或官方 digest。题目特殊准备材料必须位于根 environments/preparations 下。

新数据集先实现独立输入/原判题适配，不在调度器堆题目分支。需要 GPU 或特殊跨架构能力时明确记录限制，不能将简单导入检查算作就绪。原题、断言与评分不变；公开输入和私有评分材料严格分离。准备不调用真实模型，执行链验证使用隔离的临时根和假模型。
