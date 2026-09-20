import {useCallback, useEffect, useRef, useState} from "react";
import type {Key} from "ink";
import type {FileSuggestions, FileSuggestionResult} from "../../runtime/fileSuggestions.js";
import type {InputAtomicRange, InputBoundaryState} from "./MultilineTextInput.js";
import {completeFileMention, fileMentionAt} from "./fileMention.js";

type Source = Pick<FileSuggestions, "search" | "cancel">;
interface MenuState extends FileSuggestionResult {key: string; loading: boolean; error?: string;}
const EMPTY: MenuState = {key: "", paths: [], limited: false, loading: false};

export function useFileSuggestions(source: Source | undefined, disabled: boolean, ranges: readonly InputAtomicRange[],
    registerEscape?: (handler: (() => boolean) | undefined) => void) {
    const [edit, setEdit] = useState<InputBoundaryState>({value: "", cursorOffset: 0});
    const [dismissed, setDismissed] = useState<string>();
    const [menu, setMenu] = useState<MenuState>(EMPTY);
    const [selected, setSelected] = useState(0);
    const mention = fileMentionAt(edit, ranges);
    const key = mention ? JSON.stringify([mention.start, mention.end, mention.query]) : "";
    const active = !!source && !disabled && !!key && dismissed !== key;
    const stateRef = useRef({active, key, menu, selected});
    stateRef.current = {active, key, menu, selected};
    const dismiss = useCallback(() => {
        const state = stateRef.current;
        if (!state.active) return false;
        state.active = false;
        setDismissed(state.key);
        source?.cancel();
        return true;
    }, [source]);
    useEffect(() => {registerEscape?.(dismiss); return () => registerEscape?.(undefined);}, [registerEscape, dismiss]);
    useEffect(() => {
        if (!active || !mention || !source) {source?.cancel(); return;}
        let current = true;
        const controller = new AbortController();
        stateRef.current.selected = 0;
        setSelected(0);
        setMenu({...EMPTY, key, loading: true});
        // Debounce ranking, while the source shares one enumeration across keystrokes.
        const timer = setTimeout(() => {
            void source.search(mention.query, controller.signal).then(result => {
                if (current) setMenu({...result, key, loading: false});
            }).catch(error => {
                if (current && !controller.signal.aborted) setMenu({...EMPTY, key, error: error instanceof Error ? error.message : "File search failed"});
            });
        }, 60);
        return () => {current = false; clearTimeout(timer); controller.abort("file-query-changed");};
    }, [source, active, key]);
    useEffect(() => () => source?.cancel(), [source]);
    const onEdit = (next: InputBoundaryState) => {
        const token = fileMentionAt(next, ranges);
        const tokenKey = token ? JSON.stringify([token.start, token.end, token.query]) : "";
        stateRef.current = {...stateRef.current, key: tokenKey, active: !!source && !disabled && !!tokenKey && dismissed !== tokenKey};
        setEdit(previous => previous.value === next.value && previous.cursorOffset === next.cursorOffset ? previous : next);
        if (!token || tokenKey !== dismissed) setDismissed(undefined);
    };
    const onKey = (_input: string, pressed: Key, state: InputBoundaryState): true | InputBoundaryState | undefined => {
        const current = fileMentionAt(state, ranges);
        const currentKey = current ? JSON.stringify([current.start, current.end, current.query]) : "";
        if (!source || disabled || !current || dismissed === currentKey) return undefined;
        if (pressed.escape) {if (!registerEscape) dismiss(); return true;}
        if (pressed.shift || pressed.ctrl || pressed.meta) return undefined;
        if (pressed.upArrow || pressed.downArrow) {
            const next = menu.paths.length ? (stateRef.current.selected + (pressed.upArrow ? -1 : 1) + menu.paths.length) % menu.paths.length : 0;
            stateRef.current.selected = next;
            setSelected(next);
            return true;
        }
        if (!pressed.return && !pressed.tab) return undefined;
        // Never submit a draft while its file query is pending, stale, empty or failed.
        if (menu.key !== currentKey || menu.loading || !menu.paths.length) return true;
        const path = menu.paths[Math.min(stateRef.current.selected, menu.paths.length - 1)]!;
        source.cancel();
        setDismissed(currentKey);
        return completeFileMention(state, current, path);
    };
    return {active, menu: menu.key === key ? menu : {...EMPTY, loading: true}, selected,
        onEdit, onKey};
}
