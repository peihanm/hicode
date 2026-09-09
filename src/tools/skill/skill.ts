import {z} from "zod";
import {dirname} from "node:path";
import type {Tool, ToolContext} from "../types.js";
import type {PermissionResult} from "../../permissions/index.js";

const inputSchema = z.object({
    skill: z
        .string()
        .describe('当前可用 skill 列表中的名称；不要猜测未提供的名称'),
    args: z
        .string()
        .optional()
        .describe("可选参数，会替换 skill 内容里的 $ARGUMENTS 占位符"),
});

type Input = z.infer<typeof inputSchema>;

export const skillTool: Tool<typeof inputSchema> = {
    name: "skill",
    description: [
        "读取当前可用的 Skill 工作流指导。可用名称及用途见上下文中的 Skill 列表。",
        "用户明确要求使用某个已提供的 Skill 时，先调用本工具读取；否则根据任务与 Skill 描述的实际匹配程度决定是否使用。",
        "只使用列表中实际存在的名称；没有适用 Skill 时继续使用现有工具，不猜测或反复尝试固定名称。",
        "Skill 不新增工具或扩大权限，后续操作仍受当前能力边界约束。",
    ].join("\n"),
    parameters: inputSchema,

    isReadOnly: () => true,

    async checkPermissions(): Promise<PermissionResult> {
        // 注入 prompt 无副作用，直接放行
        return {behavior: "allow"};
    },

    async execute({skill, args}: Input, ctx: ToolContext) {
        const found = ctx.skills.find((s) => s.name === skill);
        if (!found) {
            const available = ctx.skills.map((s) => s.name).join(", ");
            return {content: `Skill "${skill}" 不存在。可用 skill: ${available || "(无)"}`, outcome: "failed"};
        }

        // 参数替换：始终替换 $ARGUMENTS
        // 有 args 时替换成 args；没传时替换成空串（避免原样输出占位符给用户看）
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
