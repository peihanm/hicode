// edit_file 工具的辅助函数

// 简单 diff 预览：显示 old/new 的前几行
export function formatDiff(oldStr: string, newStr: string): string {
    const oldPreview = truncate(oldStr, 200);
    const newPreview = truncate(newStr, 200);
    return `- ${oldPreview}\n+ ${newPreview}`;
}

function truncate(s: string, max: number): string {
    if (s.length <= max) return JSON.stringify(s);
    return JSON.stringify(s.slice(0, max)) + "...";
}
