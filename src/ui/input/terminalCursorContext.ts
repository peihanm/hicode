import {createContext, createElement, useContext, type ReactNode} from "react";
import {TERMINAL_CURSOR_ANCHOR_MARKER} from "./terminalCursor.js";

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

export function useTerminalCursorAnchor(): string {
    return useContext(TerminalCursorAnchorContext)
        ? TERMINAL_CURSOR_ANCHOR_MARKER
        : "";
}
