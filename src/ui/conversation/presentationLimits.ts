export function limitTerminalText(
    value: string,
    maxCharacters: number,
    label: string
): string {
    if (value.length <= maxCharacters) return value;
    return `${value.slice(0, maxCharacters)}\n\n[${label} truncated in terminal view]`;
}
