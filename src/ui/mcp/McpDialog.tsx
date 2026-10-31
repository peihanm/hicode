import {useTerminalInput} from "../input/terminalInput.js";
import {useEffect, useRef, useState} from "react";
import {Box, Text} from "ink";
import {stripVTControlCharacters} from "node:util";
import type {McpManagerLike, McpServerSnapshot, McpToolPolicy} from "../../mcp/types.js";
import type {PermissionRules} from "../../permissions/types.js";
import type {Tool} from "../../tools/types.js";
import {panelWindow, usePanelLayout, wrapPanelText} from "../panelLayout.js";
import stringWidth from "string-width";
import {PanelViewport} from "../dialogs/PanelViewport.js";
import {COLORS} from "../theme.js";

const clean = (value: string) => stripVTControlCharacters(value).replace(/[\x00-\x1f\x7f]/g, " ");
const choices = ["inherit", "ask", "deny", "allow"] as const;
const labels = {inherit: "Default", ask: "Ask every time", deny: "Blocked", allow: "Allowed"};
interface Review {server: McpServerSnapshot; tools: readonly Tool[]; policy: McpToolPolicy}
function restriction(tool: Tool, rules: PermissionRules): string | undefined {
    if (rules.deny.some(rule => rule.toolName === tool.name)) return "Deny rule in settings";
    if (rules.ask.some(rule => rule.toolName === tool.name)) return "Ask rule in settings";
    return undefined;
}

export function McpDialog({manager, getRules, onSave, onClose}: {
    manager?: McpManagerLike;
    getRules(): PermissionRules;
    onSave(name: string, configHash: string, policy: McpToolPolicy): Promise<void>;
    onClose(): void;
}) {
    const {width, height, padding, contentWidth: columns} = usePanelLayout();
    const [, setRevision] = useState(0);
    useEffect(() => manager?.subscribe(() => setRevision(value => value + 1)), [manager]);
    const [index, setIndex] = useState(0);
    const [review, setReview] = useState<Review>();
    const [row, setRow] = useState(0);
    const [busy, setBusy] = useState(false);
    const busyRef = useRef(false);
    const [notice, setNotice] = useState("");
    const [error, setError] = useState("");
    const servers = manager?.getSnapshots() ?? [];
    const server = servers[Math.min(index, Math.max(0, servers.length - 1))];
    const rules = getRules();
    const currentTools = manager?.getTools() ?? [];
    const current = review && servers.find(server => server.name === review.server.name);
    const stale = review && (!current || current.status !== "connected" || current.configHash !== review.server.configHash ||
        JSON.stringify(current.toolPolicy) !== JSON.stringify(review.server.toolPolicy) ||
        review.tools.some(tool => !currentTools.includes(tool)) || currentTools.filter(tool => tool.searchSource?.name === review.server.name).length !== review.tools.length);
    const focusedTool = review?.tools[row - 1];
    const open = (server: McpServerSnapshot) => {
        setReview({server, tools: (manager?.getTools() ?? []).filter(tool => tool.searchSource?.name === server.name),
            policy: structuredClone(server.toolPolicy ?? {default: "ask", exceptions: {}})});
    };
    const run = async (action: () => Promise<void>) => {
        busyRef.current = true; setBusy(true); setError(""); setNotice("");
        try {await action();}
        catch (error) {setError(clean(error instanceof Error ? error.message : String(error)).slice(0, 200));}
        finally {busyRef.current = false; setBusy(false);}
    };
    useTerminalInput((input, key) => {
        if ((key.ctrl && input === "c") || input === "\x03") {onClose(); return;}
        if (busyRef.current) return;
        if (key.escape) {
            if (review) {setReview(undefined); setRow(0); setError(""); setNotice("");}
            else onClose();
            return;
        }
        if (key.upArrow || key.downArrow) {
            const delta = key.upArrow ? -1 : 1;
            if (review) setRow(value => Math.max(0, Math.min(value + delta, review.tools.length)));
            else setIndex(value => Math.max(0, Math.min(value + delta, servers.length - 1)));
            return;
        }
        if (!review && input === "r" && server && manager) {
            void run(async () => {await manager.reconnect(server.name); setNotice("Connection refreshed.");});
        } else if (!review && key.return && server) {
            open(server); setRow(0); setError(""); setNotice("");
        } else if (review && !stale && input === " ") {
            const policy = structuredClone(review.policy);
            if (row === 0) policy.default = policy.default === "allow" ? "ask" : "allow";
            else if (focusedTool && !restriction(focusedTool, rules)) {
                const value = policy.exceptions[focusedTool.name] ?? "inherit";
                const next = choices[(choices.indexOf(value) + 1) % choices.length]!;
                if (next === "inherit") delete policy.exceptions[focusedTool.name];
                else policy.exceptions[focusedTool.name] = next;
            }
            setReview({...review, policy}); setNotice("");
        } else if (review && !stale && key.return && review.server.configHash) {
            void run(async () => {
                await onSave(review.server.name, review.server.configHash!, review.policy);
                const saved = manager?.getSnapshots().find(server => server.name === review.server.name);
                if (saved) open(saved);
                setNotice("Saved for this project · effective immediately.");
            });
        }
    });
    const toolName = (tool: Tool) => clean(tool.name.split("__").slice(2).join("__") || tool.name);
    const serverSummary = (item: McpServerSnapshot) => `  ${item.status} · ${item.toolCount} tools · ${item.toolPolicy?.default === "allow" ? "Allow by default" : "Ask when needed"}`;
    const toolRows = (review?.tools ?? []).map((tool, index) => {
        const value = review!.policy.exceptions[tool.name] ?? "inherit";
        const settingsAllow = value === "inherit" && rules.allow.some(rule => rule.toolName === tool.name && rule.content === undefined);
        const policyLabel = restriction(tool, rules) ?? (settingsAllow ? "Allowed by settings" : labels[value]);
        const selected = index + 1 === row;
        const nameRows = wrapPanelText(`${selected ? "❯ " : "  "}${toolName(tool)}`, columns >= 64 ? columns - 27 : columns);
        return columns >= 64 ? nameRows.map((text, i) => <Text key={`${tool.name}-${i}`}>
            <Text color={selected ? COLORS.accent : undefined}>{text}</Text>
            {i === 0 && <Text color={COLORS.dim}>{" ".repeat(Math.max(1, columns - 24 - stringWidth(text)))}{policyLabel}</Text>}
        </Text>) : [
            ...nameRows.map((text, i) => <Text key={`name-${i}`} color={selected ? COLORS.accent : undefined}>{text}</Text>),
            ...wrapPanelText(`  ${policyLabel}`, columns).map((text, i) => <Text key={`policy-${i}`} color={COLORS.dim}>{text}</Text>),
        ];
    });
    const serverRows = servers.map((item, position) => [
        ...wrapPanelText(`${position === index ? "❯ " : "  "}${clean(item.name)}`, columns)
            .map((text, i) => <Text key={`name-${i}`} bold={position === index} color={position === index ? COLORS.accent : undefined}>{text}</Text>),
        ...wrapPanelText(serverSummary(item), columns).map((text, i) => <Text key={`summary-${i}`} color={COLORS.dim}>{text}</Text>), " ",
    ]);
    const bodyHeight = Math.max(2, height - (review ? 17 : 10));
    const bodyRows = review ? toolRows : serverRows;
    const {start, end} = panelWindow(bodyRows.map(rows => rows.length), review ? Math.max(0, row - 1) : index, bodyHeight);
    return <Box flexDirection="column" paddingX={padding} width={width}>
        <Box width={columns} flexDirection="column">
            <Text bold color={COLORS.accent}>◆ MCP <Text bold={false} color={COLORS.dim}>· {review ? clean(review.server.name) : `${servers.length} servers`}</Text></Text>
            {review ? <>
                <Box marginTop={1}><Text color={row === 0 ? COLORS.accent : undefined}>{row === 0 ? "❯ " : "  "}Default: {review.policy.default === "allow" ? "Allow tools" : "Ask when needed"}</Text></Box>
                <Text color={COLORS.dim}>{review.policy.default === "allow" ? "Applies to current and future tools, including code execution." : "Read-only tools stay allowed; other tools require approval."}</Text>
                <Box marginTop={1} flexDirection="column">
                    <Box marginBottom={1}><Text bold>Tool exceptions <Text bold={false} color={COLORS.dim}>· Default follows the policy above</Text></Text></Box>
                    {review.tools.length === 0 && <Text>No tools available. Go back and reconnect this server.</Text>}
                    <PanelViewport width={columns} height={bodyHeight} resetKey={`${review.server.name}:${row}`}
                        lines={toolRows.slice(start, end).flat()}/>
                </Box>
                {(start > 0 || end < review.tools.length) && <Text color={COLORS.dim}>{Math.max(1, row)} / {review.tools.length}</Text>}
                {stale && <Text color={COLORS.warning}>Connection or tools changed. Esc to reopen and review.</Text>}
            </> : <Box marginTop={1} flexDirection="column">
                {!servers.length && <Text>No MCP servers configured. Add them in .hicode/mcp.json.</Text>}
                <PanelViewport width={columns} height={bodyHeight} resetKey={`server:${server?.name ?? "empty"}`}
                    lines={serverRows.slice(start, end).flat()}/>
                {server?.error && <Text color={COLORS.warning}>{clean(server.error).slice(0, 200)}</Text>}
            </Box>}
            {notice && <Box marginTop={1}><Text color={COLORS.accent}>{notice}</Text></Box>}
            {error && <Box marginTop={1}><Text color={COLORS.error}>{error}</Text></Box>}
            <Box marginTop={1} flexDirection="column">
                <Text color={COLORS.dim}>{busy ? "Saving or reconnecting…" : review
                    ? "↑↓ select · Space change · Enter save"
                    : "↑↓ select · Enter permissions · r reconnect"}</Text>
                <Text color={COLORS.dim}>{review ? "Esc back · Ctrl+C close" : "Esc / Ctrl+C close"}</Text>
            </Box>
        </Box>
    </Box>;
}
