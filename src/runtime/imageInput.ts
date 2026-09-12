import {requestApproval} from "../permissions/approval.js";
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
    if (paths.length > IMAGE_MAX_COUNT) throw new Error("Up to 8 images may be attached");
    const supported = supportsToolImages(resources.settings.sources[ctx.provider], ctx.model);
    if (!supported) throw new Error("This model/interface does not support images; switch to the Qwen 3.8 Flash trial interface");
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
            const {decision} = await requestApproval(ctx, "view_image", input, permission.behavior === "ask" ? permission.message : "Reading image attachments requires approval", `image:${canonicalPath}`, {signal: ctx.signal, allowPersistent: false});
            if (decision.behavior !== "allow") throw new Error("Image attachment read denied");
        }
        throwIfTurnAborted(ctx.signal);
        const data = await readLocalImage(input.path!, ctx.storage);
        const content = await importUserInput([{type: "image", data}], ctx.toolResultStore, supported, ctx.signal);
        if (Array.isArray(content)) for (const part of content) if (part.type === "image") references.push({...part, label: basename(selectedPath).slice(0, 256)});
    }
    return references;
}
