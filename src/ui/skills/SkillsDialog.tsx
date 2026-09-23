import {useMemo, useState} from "react";
import {Box, Text, useInput} from "ink";
import {stripVTControlCharacters} from "node:util";
import type {LoadedSkill} from "../../skills/types.js";
import {layoutTerminalMarkdown} from "../conversation/TerminalMarkdown.js";
import {useTerminalSize} from "../terminalSize.js";
import {COLORS} from "../theme.js";

const sourceLabels = {project: "Project", user: "User", bundled: "Built-in", host: "Host"};
const clean = (text: string) => stripVTControlCharacters(text).replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "");

export function SkillsDialog({issues = [], skills, projectDirectory, userDirectory, onClose}: {
    skills: readonly LoadedSkill[];
    issues?: readonly {path: string; message: string}[];
    projectDirectory: string;
    userDirectory: string;
    onClose(): void;
}) {
    const {width, height} = useTerminalSize();
    const columns = Math.max(1, Math.min(76, width - 4));
    const visibleItems = Math.max(1, Math.min(6, Math.floor((height - 10) / 3)));
    const visibleLines = Math.max(2, Math.min(18, height - 10));
    const [index, setIndex] = useState(0);
    const [detail, setDetail] = useState(false);
    const [issuesOpen, setIssuesOpen] = useState(false);
    const [offset, setOffset] = useState(0);
    const selected = skills[index];
    const detailText = selected ? [
        selected.description.trim() || "No description provided.",
        ...(selected.whenToUse ? [`When to use\n${selected.whenToUse}`] : []),
        selected.source === "host"
            ? `Host ID\n${selected.id}\nInline Skill; no local file.`
            : `File\n${selected.filePath}`,
        "Restart HiCode after changing Skill files.",
    ].join("\n\n") : ["No Skills loaded.", `Project\n${projectDirectory}`, `User\n${userDirectory}`,
        "Add <name>/SKILL.md, then restart HiCode."].join("\n\n");
    const rows = useMemo(() => layoutTerminalMarkdown(clean(issuesOpen ? issues.map(issue => `${issue.path}\n${issue.message}`).join("\n\n") : detailText), columns, false), [detailText, columns, issuesOpen, issues]);
    const start = Math.min(offset, Math.max(0, rows.length - visibleLines));
    const showingText = issuesOpen || detail || !skills.length;
    useInput((input, key) => {
        if (input === "i" && issues.length) {setIssuesOpen(value => !value); setOffset(0); return;}
        if (key.escape) {
            if (issuesOpen) {setIssuesOpen(false); setOffset(0); return;}
            if (detail) {setDetail(false); setOffset(0);}
            else onClose();
            return;
        }
        if (key.return && selected && !detail) {setDetail(true); setOffset(0); return;}
        if (key.upArrow || key.downArrow) {
            const delta = key.upArrow ? -1 : 1;
            if (showingText) setOffset(Math.max(0, Math.min(start + delta, rows.length - visibleLines)));
            else setIndex(Math.max(0, Math.min(index + delta, skills.length - 1)));
        }
    });
    const listStart = Math.max(0, index - visibleItems + 1);

    return <Box flexDirection="column" paddingLeft={2} paddingRight={2}>
        <Box flexDirection="column" width={columns}>
            <Text bold color={COLORS.accent}>◆ Skills <Text color={COLORS.dim} bold={false}>· {skills.length} available</Text></Text>
            {issues.length > 0 && <Text color={COLORS.dim}>{issues.length} loading issue(s) · i {issuesOpen ? "back" : "details"}</Text>}
            {detail && selected && <Box marginTop={1}>
                <Text bold wrap="truncate-end">{clean(selected.name)} <Text bold={false} color={COLORS.dim}>· {sourceLabels[selected.source]}</Text></Text>
            </Box>}
            {showingText ? <Box flexDirection="column" marginTop={1}>
                {rows.slice(start, start + visibleLines).map((row, i) => <Text key={i}>{row || " "}</Text>)}
                {rows.length > visibleLines && <Text color={COLORS.dim}>{start + 1}–{Math.min(rows.length, start + visibleLines)} / {rows.length}</Text>}
            </Box> : <Box flexDirection="column" marginTop={1}>
                {skills.slice(listStart, listStart + visibleItems).map((skill, i) => {
                    const active = listStart + i === index;
                    return <Box key={skill.name} flexDirection="column" marginBottom={1}>
                        <Text wrap="truncate-end" color={active ? COLORS.accent : undefined} bold={active}>
                            {active ? "❯ " : "  "}{clean(skill.name)} <Text bold={false} color={COLORS.dim}>· {sourceLabels[skill.source]}</Text>
                        </Text>
                        <Box paddingLeft={2}><Text color={COLORS.dim} wrap="truncate-end">{clean(skill.description).replace(/\s+/g, " ").trim() || "No description provided."}</Text></Box>
                    </Box>;
                })}
                {skills.length > visibleItems && <Text color={COLORS.dim}>{index + 1} / {skills.length}</Text>}
            </Box>}
            <Box marginTop={1}><Text color={COLORS.dim}>{showingText
                ? `↑↓ scroll · Esc ${detail ? "back" : "close"}`
                : "↑↓ select · Enter details · Esc close"}</Text></Box>
        </Box>
    </Box>;
}
