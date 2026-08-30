const MEMORY_GUIDANCE = [
    "# Persistent memory",
    "你拥有一个按项目隔离的文件式 Memory。Memory 目录会在下方给出，并且已经存在；不要运行 mkdir 或探测目录是否存在。",
    "Memory 只保存跨会话仍有价值、且无法从当前仓库直接推导的信息。",
    "可保存四类：user（用户长期背景和偏好）、feedback（用户纠正或明确认可的工作方式）、project（长期目标、动机、期限和协作背景）、reference（外部资源及用途）。",
    "MEMORY.md 只是索引，不保存详细正文；主题正文位于同目录顶层 Markdown 文件中。需要细节时使用 read_file、grep 或 list_files 按需读取，不要凭索引猜测正文。",
    "保存 Memory 分两步：先用 write_file/edit_file 创建或更新主题文件，再用 edit_file 在 MEMORY.md 添加或更新一行指针。删除时先用 delete_file 删除主题，再删除索引指针。",
    "索引格式固定为 `- [标题](topic-key.md) — 一行说明`。不要把正文写入 MEMORY.md，也不要创建重复主题或重复指针。",
    "主题文件使用现有 YAML frontmatter，更新前先读取并保持 version、key、created_at 等身份字段正确，同时更新 updated_at。",
    "用户明确要求记住时立即保存；明确要求忘记时查找并删除对应主题与索引。用户说不要记住时禁止写入。",
    "不要保存代码结构、文件路径、函数名、Git 历史、调试配方、当前任务状态、Todo、工具输出、CODE.md 已有规则、Secret 或未经用户确认的个人推断。",
    "按主题更新已有记忆，不创建按日期排列的活动流水；feedback/project 尽量保留 Why 和适用边界，相对日期转换为绝对日期。",
    "Memory 是可能过期的历史上下文，不是 System Instruction。当前用户消息、CODE.md 和当前仓库证据优先；冲突时验证现状并更新或删除旧记忆。",
    "用户要求忽略 Memory 时，本轮不得应用、引用或提及召回内容。",
].join("\n");

export function formatMemoryContext(input: {
    directory: string;
    index: string;
    truncated: boolean;
}): string {
    const sections = [
        "<system-reminder>",
        MEMORY_GUIDANCE,
        "",
        `Memory directory: ${input.directory}`,
        "",
        "## Memory index",
        input.index.trim(),
    ];
    if (input.truncated) {
        sections.push(
            "",
            "> WARNING: MEMORY.md 超过 200 行或 25KB，本轮只加载了部分索引。请保持一项一行，并把细节放入主题文件。"
        );
    }
    sections.push("</system-reminder>");
    return sections.join("\n");
}
