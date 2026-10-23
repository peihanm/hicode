# Context / Memory 固定证据夹具

`scenarios.json` 固定两组五阶段任务：跨文件看板修改与暂停故障排查。每组包含早期约束、中途纠正、历史失败、后续成功和明确停止条件。

离线运行：

```sh
bun test tests/integration/memoryScenarios.test.ts
```

测试通过真实 compact 生成/持久化/Resume/标准文件回查链，验证五次压缩后原文和工具配对仍可找回；摘要模型是明确的 Fake oracle。它不执行夹具里的 Bash 文本、不启动浏览器、不花模型费用，也不证明真实模型会正确理解或使用记忆。

这套夹具只用于离线 Memory／压缩回归，不属于真实模型评测。场景 JSON 由 `tests/integration/memoryScenarios.test.ts` 直接读取。
