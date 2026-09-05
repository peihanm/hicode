// Skill 工具：调用 skill（工作流模板）
// 参考 claude-code src/tools/SkillTool/SkillTool.ts
//
// 关键设计：
//
// 1. 注入机制（重要差异）：
//    claude-code：tool_result 只返回占位 "Launching skill: X"，
//    真正 skill 内容通过 newMessages（user message with isMeta:true）注入。
//    简化版：直接把 skill content 作为 tool_result 返回，效果等价——
//    LLM 下一轮迭代照样能读到完整内容。不需要扩展 Tool 接口加 newMessages 字段。
//
// 2. 入参：skill + args（跟 claude-code 一致）
//    - skill：必填，skill 名（如 verify / debug）
//    - args：可选，参数串，会替换 skill 内容里的 $ARGUMENTS
//
// 3. 参数替换：只支持 $ARGUMENTS（最常用）
//    claude-code 还支持 $0/$1/$foo/${CLAUDE_SKILL_DIR}/${CLAUDE_SESSION_ID}
//
// 4. checkPermissions 直接 allow：注入 prompt 无副作用，跟 todoWrite 一样

import {z} from "zod";
import {dirname} from "node:path";
import type {Tool, ToolContext} from "../types.js";
import type {PermissionResult} from "../../permissions/index.js";

const inputSchema = z.object({
    skill: z
        .string()
        .describe('要调用的 skill 名称，如 "verify" 或 "debug"。可用 skill 列表见上下文提醒'),
    args: z
        .string()
        .optional()
        .describe("可选参数，会替换 skill 内容里的 $ARGUMENTS 占位符"),
});

type Input = z.infer<typeof inputSchema>;

export const skillTool: Tool<typeof inputSchema> = {
    name: "skill",
    description: [
        "调用一个 skill（工作流模板）。skill 内容会作为指令返回，按它执行后续工作。",
        "",
        "重要：用户提到 skill 名（如 review/verify/debug 等）或说\"用 X skill\"时，",
        "必须第一个动作就调本工具拿流程指导，再按返回内容执行。不要跳过 skill 自己干。",
        "",
        "可用 skill 列表见上下文提醒。",
        "",
        "使用场景：",
        "1. 用户说\"用 X skill\"或提到 skill 名 — 立即调本工具拿流程",
        "2. 完成编码任务后 — 调 verify 跑验证流程",
        "3. 遇到 bug 或测试失败 — 调 debug 按系统化流程调试",
    ].join("\n"),
    parameters: inputSchema,

    isReadOnly: () => true,

    async checkPermissions(): Promise<PermissionResult> {
        // 注入 prompt 无副作用，直接放行
        return {behavior: "allow"};
    },

    async execute({skill, args}: Input, ctx: ToolContext): Promise<string> {
        const found = ctx.skills.find((s) => s.name === skill);
        if (!found) {
            const available = ctx.skills.map((s) => s.name).join(", ");
            return `Skill "${skill}" 不存在。可用 skill: ${available || "(无)"}`;
        }

        // 参数替换：始终替换 $ARGUMENTS
        // 有 args 时替换成 args；没传时替换成空串（避免原样输出占位符给用户看）
        // 参考 claude-code argumentSubstitution.ts:appendIfNoPlaceholder
        const argsValue = args ?? "";
        const source = found.source === "host"
            ? {source: found.source, id: found.id}
            : {source: found.source, filePath: found.filePath, resourceRoot: dirname(found.filePath)};
        const resolution = found.source === "host"
            ? "此 Skill 为 Host inline 内容，没有本地资源目录。资源必须使用正文中 Host 明确提供的绝对路径或资源标识；不得根据 Skill 名称猜目录。"
            : "Skill 自带的 scripts、references、assets 等相对资源路径以 resourceRoot 为基准，读取或执行时使用拼接后的绝对路径。项目路径仍以当前工作目录为基准，不要把项目文件解析到 Skill 目录。含空格的 Shell 路径需要正确引用。";
        return ["<skill-source>", JSON.stringify(source), resolution,
            "加载 Skill 不扩大文件或命令权限；后续操作仍通过现有工具执行链。", "</skill-source>", "",
            found.content.replace(/\$ARGUMENTS/g, () => argsValue)].join("\n");
    },
};
