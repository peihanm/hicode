import {useEffect, useRef, useState} from "react";
import {Box, Text, useInput} from "ink";
import TextInput from "ink-text-input";
import {LLM_PROVIDER_NAMES, PROVIDER_BASE_URLS, type LLMProviderName} from "../../llm/providerRegistry.js";
import type {PrimaryModelRuntime} from "../../runtime/primaryModel.js";
import type {ModelConfiguration} from "../../settings/modelConfiguration.js";
import {COLORS} from "../theme.js";

type Page = {kind: "list"} | {kind: "provider" | "remove-model" | "key" | "endpoint" | "model-id"; source: LLMProviderName}
    | {kind: "confirm-remove"; source: LLMProviderName; id: string; label: string}
    | {kind: "model-label"; source: LLMProviderName; id: string};

export function ProvidersDialog({runtime, configuration, onClose}: {
    runtime: PrimaryModelRuntime;
    configuration: ModelConfiguration;
    onClose(): void;
}) {
    const [page, setPage] = useState<Page>({kind: "list"});
    const [selected, setSelected] = useState(0);
    const [value, setValue] = useState("");
    const [busy, setBusy] = useState(false);
    const [notice, setNotice] = useState("");
    const [error, setError] = useState("");
    const mounted = useRef(true);
    useEffect(() => () => {mounted.current = false;}, []);
    const sources = runtime.sources;
    const source = "source" in page ? sources[page.source] : undefined;
    const configured = (name: LLMProviderName) => runtime.hasCredential(name);
    const edit = ["key", "endpoint", "model-id", "model-label"].includes(page.kind);
    const navigate = (next: Page, initial = "") => {setPage(next); setValue(initial); setSelected(0); setError(""); setNotice("");};

    const save = async (input: string) => {
        if (!edit || busy || !("source" in page)) return;
        if (page.kind === "model-id") {
            if (!input.trim() || input.trim().length > 200) {setError("Enter the API model ID (up to 200 characters)"); return;}
            navigate({kind: "model-label", source: page.source, id: input.trim()});
            return;
        }
        setBusy(true); setError("");
        // The secret stays only in this form and the credential writer, never in conversation events.
        setValue("");
        try {
            let message = "Saved. Available immediately.";
            if (page.kind === "key") message = `Key saved to ${await configuration.saveKey(page.source, input)}. Available immediately.`;
            else if (page.kind === "endpoint") await configuration.saveEndpoint(page.source, input);
            else if (page.kind === "model-label") await configuration.addModel(page.source, page.id, input);
            if (mounted.current) {navigate({kind: "provider", source: page.source}); setNotice(message);}
        } catch (reason) {
            if (mounted.current) setError(reason instanceof Error ? reason.message : "Could not save configuration");
        } finally {if (mounted.current) setBusy(false);}
    };

    const remove = async (source: LLMProviderName, id: string) => {
        setBusy(true); setError("");
        try {
            await configuration.removeModel(source, id);
            if (mounted.current) {navigate({kind: "remove-model", source}); setNotice("Model removed. API key and endpoint kept.");}
        } catch (reason) {
            if (mounted.current) setError(reason instanceof Error ? reason.message : "Could not remove model");
        } finally {if (mounted.current) setBusy(false);}
    };

    useInput((_input, key) => {
        if (busy) return;
        if (key.escape) {
            if (page.kind === "list") onClose();
            else if (page.kind === "provider") navigate({kind: "list"});
            else if (page.kind === "confirm-remove") navigate({kind: "remove-model", source: page.source});
            else navigate({kind: "provider", source: page.source});
            return;
        }
        if (edit) return;
        const count = page.kind === "list" ? LLM_PROVIDER_NAMES.length : page.kind === "remove-model" ? (source?.models.length ?? 0) + 1 : page.kind === "confirm-remove" ? 2 : 5;
        if (key.upArrow) setSelected(index => (index + count - 1) % count);
        else if (key.downArrow) setSelected(index => (index + 1) % count);
        else if (key.return) {
            if (page.kind === "list") navigate({kind: "provider", source: LLM_PROVIDER_NAMES[selected]!});
            else if (page.kind === "provider") {
                if (selected === 0) navigate({kind: "key", source: page.source});
                else if (selected === 1) navigate({kind: "endpoint", source: page.source}, source?.baseUrl ?? PROVIDER_BASE_URLS[page.source]);
                else if (selected === 2) navigate({kind: "model-id", source: page.source});
                else if (selected === 3) navigate({kind: "remove-model", source: page.source});
                else navigate({kind: "list"});
            } else if (page.kind === "remove-model") {
                const model = source?.models[selected];
                if (model) navigate({kind: "confirm-remove", source: page.source, id: model.id, label: model.label});
                else navigate({kind: "provider", source: page.source});
            } else if (page.kind === "confirm-remove") {
                if (selected === 0) navigate({kind: "remove-model", source: page.source});
                else void remove(page.source, page.id);
            }
        }
    });

    const row = (text: string, index: number) => <Text key={text} color={index === selected ? COLORS.accent : undefined} bold={index === selected}>{index === selected ? "› " : "  "}{text}</Text>;
    return <Box flexDirection="column" paddingLeft={2} paddingRight={2}>
        <Text bold color={COLORS.accent}>◆ {source?.label ?? "PROVIDERS"}</Text>
        {page.kind === "list" ? <Box marginTop={1} flexDirection="column">
            {LLM_PROVIDER_NAMES.map((name, index) => row(`${sources[name].label} · ${configured(name) ? "Configured" : "Key required"}`, index))}
        </Box> : page.kind === "provider" ? <>
            <Box marginTop={1} flexDirection="column">
                {row(`API key · ${configured(page.source) ? "Configured — replace" : "Add key"}`, 0)}
                {row(`API endpoint · ${source?.baseUrl ? "Custom" : "Default"}`, 1)}
                {row("Add model", 2)}
                {row("Remove model", 3)}
                {row("Back", 4)}
            </Box>
            <Box marginTop={1} flexDirection="column">
                <Text color={COLORS.dim}>Models · use /model to switch</Text>
                {source?.models.slice(0, 8).map(model => <Text key={model.id} wrap="truncate-end">  {model.label} · {model.id}</Text>)}
                {source && source.models.length > 8 && <Text color={COLORS.dim}>  {source.models.length - 8} more models in /model</Text>}
            </Box>
        </> : page.kind === "remove-model" ? <Box marginTop={1} flexDirection="column">
            <Text color={COLORS.dim}>Select a model to remove</Text>
            {!source?.models.length && <Text>No models configured.</Text>}
            {source?.models.slice(Math.max(0, selected - 7), Math.max(0, selected - 7) + 8).map((model, index) => row(`${model.label} · ${model.id}`, Math.max(0, selected - 7) + index))}
            {row("Back", source?.models.length ?? 0)}
        </Box> : page.kind === "confirm-remove" ? <Box marginTop={1} flexDirection="column">
            <Text>Remove {page.label}?</Text>
            <Text color={COLORS.dim}>{page.id}</Text>
            <Text color={COLORS.dim}>Removes this catalog entry. API key and endpoint are kept.</Text>
            {row("Cancel", 0)}
            {row("Remove model", 1)}
        </Box> : <Box marginTop={1} flexDirection="column">
            <Text>{page.kind === "key" ? "API key (hidden)" : page.kind === "endpoint" ? "API base URL (empty restores default)" : page.kind === "model-id" ? "Model ID (required, exactly as the API expects)" : "Display name (optional, defaults to model ID)"}</Text>
            {page.kind === "model-label" && <Text color={COLORS.dim}>Model ID: {page.id}</Text>}
            <Box><Text color={COLORS.accent}>› </Text><TextInput value={value} onChange={next => setValue(next.slice(0, page.kind === "key" ? 8192 : 2048))}
                mask={page.kind === "key" ? "•" : undefined} focus={!busy} onSubmit={input => {void save(input);}}/></Box>
        </Box>}
        {error && <Box marginTop={1}><Text color={COLORS.error}>{error}</Text></Box>}
        {notice && <Box marginTop={1}><Text color={COLORS.dim}>{notice}</Text></Box>}
        <Box marginTop={1}><Text color={COLORS.dim}>{busy ? "Saving…" : edit ? "Enter save · Esc back" : "↑↓ select · Enter open · Esc back"}</Text></Box>
    </Box>;
}
