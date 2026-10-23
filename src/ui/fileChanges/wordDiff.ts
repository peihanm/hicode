import {diffWordsWithSpace} from "diff";
import type {DiffHunk} from "../../fileChanges/index.js";

interface WordPart {
    value: string;
    changed: boolean;
}

export function pairChangedLines(hunk: DiffHunk): Map<number, number> {
    const pairs = new Map<number, number>();
    let index = 0;
    while (index < hunk.lines.length) {
        if (hunk.lines[index]?.type !== "remove") {
            index += 1;
            continue;
        }
        const removes: number[] = [];
        while (hunk.lines[index]?.type === "remove") removes.push(index++);
        const adds: number[] = [];
        while (hunk.lines[index]?.type === "add") adds.push(index++);
        for (let pair = 0; pair < Math.min(removes.length, adds.length); pair++) {
            pairs.set(removes[pair]!, adds[pair]!);
            pairs.set(adds[pair]!, removes[pair]!);
        }
    }
    return pairs;
}

export function getWordParts(
    current: string,
    paired: string,
    type: "add" | "remove"
): WordPart[] | null {
    if (current.length + paired.length > 10_000) return null;
    const oldText = type === "remove" ? current : paired;
    const newText = type === "add" ? current : paired;
    const parts = diffWordsWithSpace(oldText, newText);
    const totalLength = oldText.length + newText.length;
    const changedLength = parts
        .filter((part) => part.added || part.removed)
        .reduce((sum, part) => sum + part.value.length, 0);
    if (totalLength === 0 || changedLength / totalLength > 0.4) return null;

    return parts.flatMap((part) => {
        if (type === "add" && part.removed) return [];
        if (type === "remove" && part.added) return [];
        return [{
            value: part.value,
            changed: type === "add" ? Boolean(part.added) : Boolean(part.removed),
        }];
    });
}
