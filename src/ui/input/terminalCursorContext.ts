import {createContext, createElement, useContext, type ReactNode} from "react";
import {TERMINAL_CURSOR_ANCHOR_MARKER, TERMINAL_CURSOR_ANCHOR_END} from "./terminalCursor.js";

const TerminalCursorAnchorContext = createContext(false);

export function TerminalCursorAnchorProvider({
    children,
    enabled,
}: {
    children: ReactNode;
    enabled: boolean;
}) {
    return createElement(
        TerminalCursorAnchorContext.Provider,
        {value: enabled},
        children
    );
}

export function useTerminalCursorTransform(): (text: string) => string {
    const enabled = useContext(TerminalCursorAnchorContext);
    return text => enabled
        ? TERMINAL_CURSOR_ANCHOR_MARKER + text + TERMINAL_CURSOR_ANCHOR_END
        : text;
}
