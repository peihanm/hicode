import {createContext, createElement, useCallback, useContext, useSyncExternalStore, type ReactNode,} from "react";
import {useStdout} from "ink";

const DEFAULT_TERMINAL_WIDTH = 80;

export function normalizeTerminalWidth(columns: number | undefined): number {
    return columns && Number.isFinite(columns) && columns > 0
        ? Math.floor(columns)
        : DEFAULT_TERMINAL_WIDTH;
}

/**
 * Ink 会在 stdout resize 时重算 Yoga，但直接读取 stdout.columns 不会触发
 * React render。所有依赖列宽生成文本或折行的组件都通过这个 Hook 订阅尺寸。
 */
const TerminalWidthContext = createContext<number | undefined>(undefined);

function useObservedTerminalWidth(enabled: boolean, widthOverride?: number): number {
    const {stdout} = useStdout();
    const subscribe = useCallback(
        (onStoreChange: () => void) => {
            if (!enabled || widthOverride !== undefined) return () => {};
            let timer: ReturnType<typeof setTimeout> | undefined;
            const handleResize = () => {
                if (timer) clearTimeout(timer);
                timer = setTimeout(onStoreChange, 50);
                timer.unref?.();
            };
            stdout.on("resize", handleResize);
            return () => {
                if (timer) clearTimeout(timer);
                stdout.off("resize", handleResize);
            };
        },
        [enabled, stdout, widthOverride]
    );
    const getSnapshot = useCallback(
        () => widthOverride ?? normalizeTerminalWidth(stdout.columns),
        [stdout, widthOverride]
    );
    return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function TerminalSizeProvider({children}: {children: ReactNode}) {
    const width = useObservedTerminalWidth(true);
    return createElement(TerminalWidthContext.Provider, {value: width}, children);
}

export function useTerminalWidth(widthOverride?: number): number {
    const inheritedWidth = useContext(TerminalWidthContext);
    const observedWidth = useObservedTerminalWidth(
        inheritedWidth === undefined,
        widthOverride
    );
    return widthOverride ?? inheritedWidth ?? observedWidth;
}
