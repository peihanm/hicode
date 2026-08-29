import {memo} from "react";
import {Box, Text, useStdout} from "ink";
import type {FileChange} from "../../fileChanges/index.js";
import {COLORS} from "../theme.js";
import {FileChangeView} from "./FileChangeView.js";

function total(changes: FileChange[], field: "linesAdded" | "linesRemoved") {
    return changes.every((change) => change[field] !== null)
        ? changes.reduce((sum, change) => sum + (change[field] ?? 0), 0)
        : null;
}

export const FileChangeGroup = memo(function FileChangeGroup({
                                                                 changes,
                                                                 expanded,
                                                             }: {
    changes: FileChange[];
    expanded: boolean;
}) {
    const {stdout} = useStdout();
    const width = Math.max(30, stdout.columns || 80);
    const grouped = new Map<string, FileChange[]>();
    for (const change of changes) {
        grouped.set(change.path, [...(grouped.get(change.path) ?? []), change]);
    }
    const files = [...grouped.entries()];
    const visibleFiles = expanded ? files.slice(0, 100) : files.slice(0, 8);
    const added = total(changes, "linesAdded");
    const removed = total(changes, "linesRemoved");
    const allCreated = changes.every((change) => change.kind === "create");
    const allUpdated = changes.every((change) => change.kind === "update");
    const allDeleted = changes.every((change) => change.kind === "delete");
    const verb = allCreated
        ? "Created"
        : allUpdated
            ? "Edited"
            : allDeleted
                ? "Deleted"
                : "Changed";

    return (
        <Box flexDirection="column" marginTop={1}>
            <Box>
                <Text color={COLORS.assistant}>● </Text>
                <Text bold>{verb} {files.length} file{files.length === 1 ? "" : "s"} (</Text>
                <Text color={COLORS.diffAdded}>+{added === null ? "?" : added}</Text>
                <Text> </Text>
                <Text color={COLORS.diffRemoved}>-{removed === null ? "?" : removed}</Text>
                <Text bold>)</Text>
            </Box>
            <Box flexDirection="column" marginLeft={2}>
                {visibleFiles.map(([path, fileChanges]) => (
                    <FileChangeView
                        key={path}
                        path={path}
                        changes={fileChanges}
                        width={width - 2}
                        expanded={expanded}
                    />
                ))}
                {files.length > visibleFiles.length && (
                    <Text dimColor>… {files.length - visibleFiles.length} more
                        files{expanded ? "" : " · ctrl+o to expand"}</Text>
                )}
            </Box>
        </Box>
    );
});
