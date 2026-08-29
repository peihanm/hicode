import React, {memo} from "react";
import {Box, Text} from "ink";
import type {FileChange} from "../../fileChanges/index.js";
import {COLORS} from "../theme.js";
import {StructuredDiff} from "./StructuredDiff.js";

function stat(value: number | null, prefix: "+" | "-"): string {
    return `${prefix}${value === null ? "?" : value}`;
}

export const FileChangeView = memo(function FileChangeView({
                                                               path,
                                                               changes,
                                                               width,
                                                               expanded,
                                                           }: {
    path: string;
    changes: FileChange[];
    width: number;
    expanded: boolean;
}) {
    const added = changes.every((change) => change.linesAdded !== null)
        ? changes.reduce((sum, change) => sum + (change.linesAdded ?? 0), 0)
        : null;
    const removed = changes.every((change) => change.linesRemoved !== null)
        ? changes.reduce((sum, change) => sum + (change.linesRemoved ?? 0), 0)
        : null;
    const isNew = changes.some((change) => change.kind === "create");
    const isDeleted = changes.some((change) => change.kind === "delete");

    return (
        <Box flexDirection="column" marginTop={1}>
            <Box>
                <Text dimColor>└ </Text>
                <Text bold>{path}</Text>
                <Text> (</Text>
                <Text color={COLORS.diffAdded}>{stat(added, "+")}</Text>
                <Text> </Text>
                <Text color={COLORS.diffRemoved}>{stat(removed, "-")}</Text>
                {isNew && <Text dimColor>, new file</Text>}
                {isDeleted && <Text dimColor>, deleted</Text>}
                <Text>)</Text>
            </Box>
            <Box flexDirection="column" marginLeft={2}>
                {changes.map((change, index) => (
                    <React.Fragment key={`${index}-${change.diffStatus}`}>
                        {index > 0 && <Text dimColor>...</Text>}
                        {change.diffStatus === "unavailable" ? (
                            <Text dimColor>Diff unavailable ({change.diffUnavailableReason ?? "error"})</Text>
                        ) : (
                            <StructuredDiff
                                hunks={change.hunks}
                                width={Math.max(20, width - 2)}
                                expanded={expanded}
                                omittedDiffLines={change.omittedDiffLines}
                                defaultMaxLines={isNew ? 40 : 120}
                            />
                        )}
                    </React.Fragment>
                ))}
            </Box>
        </Box>
    );
});
