# 操作入口

先读数据根 README.md。CLI 使用 --root，服务和离线命令共享同一根，不接受独立 catalog/environments/data-dir 路径。命令与当前参数用 bash hicode-eval/eval.sh --help 查询。

worker 是唯一运行 owner；serve 只读结果，可独立重启。真实提交前核对 payload、模型来源、预算与 dataset/id；超时先查提交结果，不重复调用。未通过复验用当前 regrade，恢复用 recover，都不追加模型作答。需要新模型尝试时用户主动 retry。

状态读取后只输出题目/state/execution/grading/collection/note，不把模型请求全文灌入上下文。证据在根 runs/<id>，通过题归档到同目录 evidence.tar.gz；先验证 archive.json 的 SHA256，不自动恢复为工作区。分享请求日志前脱敏。docs/eval 按数据集维护结论，不放逐批报告。
