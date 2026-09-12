// Helpers for edit_file.

// Small diff preview showing initial old/new lines.
export function formatDiff(oldStr: string, newStr: string): string {
    const oldPreview = truncate(oldStr, 200);
    const newPreview = truncate(newStr, 200);
    return `- ${oldPreview}\n+ ${newPreview}`;
}

function truncate(s: string, max: number): string {
    if (s.length <= max) return JSON.stringify(s);
    return JSON.stringify(s.slice(0, max)) + "...";
}
