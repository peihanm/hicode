import {Box, Text} from "ink";
import type {ImageReference} from "../../images/content.js";
import {COLORS} from "../theme.js";

export function ImageAttachments({images, preparing}: {images: readonly ImageReference[]; preparing: boolean}) {
    if (!images.length && !preparing) return null;
    return <Box flexDirection="column">
        {images.slice(0, 8).map((reference, index) => <Text key={`${reference.imageId}-${index}`} color={COLORS.dim} wrap="truncate-end">
            {`图片 ${index + 1} · ${(reference.label ?? reference.imageId.slice(0, 18)).replace(/[\u0000-\u001f\u007f]/g, "")} · ${reference.image.width}×${reference.image.height} · 原图 ${reference.image.sourceWidth}×${reference.image.sourceHeight} · ${Math.ceil(reference.image.byteLength / 1024)} KiB`}
        </Text>)}
        {images.length > 8 && <Text color={COLORS.dim}>{`另有 ${images.length - 8} 张；/detach 编号或 all 移除后再提交`}</Text>}
        <Text color={COLORS.dim}>{preparing ? "正在准备图片 · Esc 取消" : "/attach 路径 · /paste-image · /detach 编号或 all · Enter 提交"}</Text>
    </Box>;
}
