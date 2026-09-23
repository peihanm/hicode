import {
    createContext,
    createElement,
    useCallback,
    useContext,
    useMemo,
    useSyncExternalStore,
    type ReactNode,
} from "react";
import {useStdout} from "ink";

const DEFAULT_TERMINAL_WIDTH = 80;
const DEFAULT_TERMINAL_HEIGHT = 24;

interface TerminalSize {
    width: number;
    height: number;
}

export function normalizeTerminalWidth(columns: number | undefined): number {
    return columns && Number.isFinite(columns) && columns > 0
        ? Math.floor(columns)
        : DEFAULT_TERMINAL_WIDTH;
}

export function normalizeTerminalHeight(rows: number | undefined): number {
    return rows && Number.isFinite(rows) && rows > 0
        ? Math.floor(rows)
        : DEFAULT_TERMINAL_HEIGHT;
}

/** Ink recomputes Yoga on stdout resize, but reading columns/rows does not trigger React render. One Provider subscription publishes dimensions instead of per-component listeners. */
const TerminalSizeContext = createContext<TerminalSize | undefined>(undefined);

function useObservedTerminalSize(
    enabled: boolean,
    widthOverride?: number,
    heightOverride?: number
): TerminalSize {
    const {stdout} = useStdout();
    const subscribe = useCallback(
        (onStoreChange: () => void) => {
            if (
                !enabled ||
                (widthOverride !== undefined && heightOverride !== undefined)
            ) return () => {};
            let timer: ReturnType<typeof setTimeout> | undefined;
            const handleResize = () => {
                if (timer) clearTimeout(timer);
                timer = setTimeout(onStoreChange, 75);
                timer.unref?.();
            };
            stdout.on("resize", handleResize);
            return () => {
                if (timer) clearTimeout(timer);
                stdout.off("resize", handleResize);
            };
        },
        [enabled, heightOverride, stdout, widthOverride]
    );
    const getSnapshot = useCallback(
        () => `${widthOverride ?? normalizeTerminalWidth(stdout.columns)}:${heightOverride ?? normalizeTerminalHeight(stdout.rows)}`,
        [heightOverride, stdout, widthOverride]
    );
    const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
    const separator = snapshot.indexOf(":");
    return {
        width: Number(snapshot.slice(0, separator)),
        height: Number(snapshot.slice(separator + 1)),
    };
}

export function TerminalSizeProvider({children}: {children: ReactNode}) {
    const observed = useObservedTerminalSize(true);
    const size = useMemo(
        () => ({width: observed.width, height: observed.height}),
        [observed.height, observed.width]
    );
    return createElement(TerminalSizeContext.Provider, {value: size}, children);
}

export function useTerminalSize(overrides: {
    width?: number;
    height?: number;
} = {}): TerminalSize {
    const inherited = useContext(TerminalSizeContext);
    const observed = useObservedTerminalSize(
        inherited === undefined,
        overrides.width,
        overrides.height
    );
    return {
        width: overrides.width ?? inherited?.width ?? observed.width,
        height: overrides.height ?? inherited?.height ?? observed.height,
    };
}

export function useTerminalWidth(widthOverride?: number): number {
    return useTerminalSize({width: widthOverride}).width;
}
