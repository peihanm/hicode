import {useMemo, useState} from "react";
import {Box, Text, useInput} from "ink";
import {stripVTControlCharacters} from "node:util";
import type {LoadedSkill} from "../../skills/types.js";
import {layoutTerminalMarkdown} from "../conversation/TerminalMarkdown.js";
import {panelWindow, usePanelLayout, wrapPanelText} from "../panelLayout.js";
import {PanelViewport} from "../dialogs/PanelViewport.js";
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
    const {width, height, padding, contentWidth: columns} = usePanelLayout();
    const visibleLines = Math.max(1, height - 10);
    const [index, setIndex] = useState(0);
    const [detail, setDetail] = useState(false);
    const [issuesOpen, setIssuesOpen] = useState(false);
    const [offset, setOffset] = useState(0);
    const selected = skills[index];
    const detailText = selected ? [
        selected.description.trim() || "No description provided.",
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
    const labels = skills.map(skill => wrapPanelText(`❯ ${clean(skill.name)} · ${sourceLabels[skill.source]}`, columns));
    const descriptions = skills.map(skill => wrapPanelText(clean(skill.description).replace(/\s+/g, " ").trim() || "No description provided.", Math.max(1, columns - 2)));
    const window = panelWindow(skills.map((_, i) => labels[i]!.length + descriptions[i]!.length + 1), index, height - 8);

    return <Box flexDirection="column" paddingX={padding} width={width}>
        <Box flexDirection="column" width={columns}>
            <Text bold color={COLORS.accent}>◆ Skills <Text color={COLORS.dim} bold={false}>· {skills.length} available</Text></Text>
            {issues.length > 0 && <Text color={COLORS.dim}>{issues.length} loading issue(s) · i {issuesOpen ? "back" : "details"}</Text>}
            {detail && selected && <Box marginTop={1}>
                <Text bold>{clean(selected.name)} <Text bold={false} color={COLORS.dim}>· {sourceLabels[selected.source]}</Text></Text>
            </Box>}
            {showingText ? <Box flexDirection="column" marginTop={1}>
                {rows.slice(start, start + visibleLines).map((row, i) => <Text key={i}>{row || " "}</Text>)}
                {rows.length > visibleLines && <Text color={COLORS.dim}>{start + 1}–{Math.min(rows.length, start + visibleLines)} / {rows.length}</Text>}
            </Box> : <Box flexDirection="column" marginTop={1}>
                <PanelViewport width={columns} height={Math.max(2, height - 8)} resetKey={selected?.name ?? "empty"}
                    lines={skills.slice(window.start, window.end).flatMap((skill, i) => {
                        const active = window.start + i === index;
                        return [
                            ...wrapPanelText(`${active ? "❯ " : "  "}${clean(skill.name)} · ${sourceLabels[skill.source]}`, columns)
                                .map((line, j) => <Text key={`name-${i}-${j}`} color={active ? COLORS.accent : undefined} bold={active}>{line}</Text>),
                            ...descriptions[window.start + i]!.map((line, j) => <Text key={`description-${i}-${j}`} color={COLORS.dim}>{`  ${line}`}</Text>),
                            " ",
                        ];
                    })}/>
                {(window.start > 0 || window.end < skills.length) && <Text color={COLORS.dim}>{index + 1} / {skills.length}</Text>}
            </Box>}
            <Box marginTop={1}><Text color={COLORS.dim}>{showingText
                ? `↑↓ scroll · Esc ${detail ? "back" : "close"}`
                : "↑↓ select · Enter details · Esc close"}</Text></Box>
        </Box>
    </Box>;
}
