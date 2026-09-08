import {basename} from "node:path";
import {realpath} from "node:fs/promises";
import {viewImageTool} from "../tools/viewImage/viewImage.js";
import {resolvePermission} from "../permissions/index.js";
import {resolveToolPath} from "../tools/shared/paths.js";
import {readLocalImage} from "../images/localFile.js";
import {importUserInput} from "../images/input.js";
import {supportsToolImages} from "../images/capability.js";
import {IMAGE_MAX_COUNT, type ImageReference} from "../images/content.js";
import type {RootRuntimeResources} from "./resources.js";
import type {ToolContext} from "../tools/types.js";
import {throwIfTurnAborted} from "./abort.js";

/** Explicit user selection is input import, sharing tool path policy but not inventing a tool call. */
export async function importSelectedImages(paths: readonly string[], resources: RootRuntimeResources, ctx: ToolContext): Promise<ImageReference[]> {
    if (paths.length > IMAGE_MAX_COUNT) throw new Error("最多添加 8 张图片");
    const supported = supportsToolImages(resources.settings.sources[ctx.provider], ctx.model);
    if (!supported) throw new Error("当前模型/接口不支持图片输入；请切换到 Qwen 3.8 Flash trial 接口");
    const references: ImageReference[] = [];
    for (const path of paths) {
        throwIfTurnAborted(ctx.signal);
        const selectedPath = resolveToolPath(ctx.cwd, path);
        const canonicalPath = await realpath(selectedPath);
        const input = viewImageTool.parameters.parse({path: canonicalPath});
        const selectionPermission = await resolvePermission(viewImageTool, {path: selectedPath}, ctx);
        if (selectionPermission.behavior === "deny") throw new Error(selectionPermission.message);
        const permission = await resolvePermission(viewImageTool, input, {...ctx, cwd: await realpath(ctx.cwd),
            workspaceBoundary: ctx.workspaceBoundary ? await realpath(ctx.workspaceBoundary) : undefined});
        if (permission.behavior === "deny") throw new Error(permission.message);
        if (permission.behavior === "ask" || selectionPermission.behavior === "ask") {
            const decision = await ctx.canUseTool("view_image", permission.behavior === "ask" ? permission.message : "图片附件读取需要确认", input, {signal: ctx.signal, allowPersistent: false});
            if (decision.behavior !== "allow") throw new Error("图片附件读取被拒绝");
        }
        throwIfTurnAborted(ctx.signal);
        const data = await readLocalImage(input.path!, ctx.storage);
        const content = await importUserInput([{type: "image", data}], ctx.toolResultStore, supported, ctx.signal);
        if (Array.isArray(content)) for (const part of content) if (part.type === "image") references.push({...part, label: basename(selectedPath).slice(0, 256)});
    }
    return references;
}
