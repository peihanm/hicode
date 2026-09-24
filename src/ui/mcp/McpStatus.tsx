import {Box, Text} from "ink";
import {useEffect, useState} from "react";
import {stripVTControlCharacters} from "node:util";
import type {McpServerSnapshot} from "../../mcp/types.js";
import {COLORS} from "../theme.js";

const SPINNER_FRAMES = ["◐", "◓", "◑", "◒"];

function McpSpinner() {
    const [frame, setFrame] = useState(0);
    useEffect(() => {
        const timer = setInterval(() => setFrame(value => (value + 1) % SPINNER_FRAMES.length), 120);
        timer.unref?.();
        return () => clearInterval(timer);
    }, []);
    return <Text color={COLORS.accent}>{SPINNER_FRAMES[frame]}</Text>;
}

function names(servers: readonly McpServerSnapshot[]): string {
    const shown = servers.slice(0, 3).map(server => stripVTControlCharacters(server.name)
        .replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 64)).join(", ");
    return `${shown}${servers.length > 3 ? ` +${servers.length - 3}` : ""}`;
}

/** A live status above the composer, never part of the input or conversation history. */
export function McpStatus({servers, initializing = false}: {
    servers: readonly McpServerSnapshot[];
    initializing?: boolean;
}) {
    const active = servers.filter(server => server.status === "connecting" || server.status === "refreshing" ||
        (initializing && server.status === "pending-approval"));
    const failed = servers.filter(server => server.status === "failed" || server.status === "closed");
    const blocked = servers.filter(server => server.status === "denied" || (!initializing && server.status === "pending-approval"));
    if (!active.length && !failed.length && !blocked.length) return null;
    const ready = servers.filter(server => server.status === "connected").length;
    const total = servers.filter(server => server.status !== "disabled").length;
    return <Box flexDirection="column" marginTop={1}>
        {active.length > 0 && <Text color={COLORS.dim}><McpSpinner/> Connecting MCP · {ready}/{total} ready · {names(active)}</Text>}
        {failed.length > 0 && <Text color={COLORS.warning}>! MCP failed · {names(failed)} · /mcp for details</Text>}
        {blocked.length > 0 && <Text color={COLORS.dim}>! MCP not connected · {names(blocked)} · /mcp to review access</Text>}
    </Box>;
}
