import {useTerminalInput} from "../input/terminalInput.js";
import {useState} from "react";
import {Box, Text} from "ink";
import {TextInput} from "../input/TextInput.js";
import type {ConfirmReq} from "../turn/types.js";
import {COLORS} from "../theme.js";
import {usePanelLayout, wrapPanelText} from "../panelLayout.js";
import type {UserQuestion, UserAnswers} from "../../runtime/userQuestions.js";

const MAX_CUSTOM_ANSWER_CHARS = 16_384;

/** Hidden async editors retain their draft while the main composer or an approval has focus. */
export function AskDialog({req, onDone, active = true, onBack}: {
    req: ConfirmReq;
    onDone(): void;
    active?: boolean;
    onBack?(): void;
}) {
    const {questions} = req.input as {questions: UserQuestion[]};
    const [index, setIndex] = useState(0);
    const [answers, setAnswers] = useState<UserAnswers>({});
    const [selectedIndex, setSelectedIndex] = useState(0);
    const [selected, setSelected] = useState<number[]>([]);
    const [isTyping, setIsTyping] = useState(false);
    const [draft, setDraft] = useState("");
    const {padding, contentWidth} = usePanelLayout();
    const question = questions[index]!;
    const options = question.options ?? [];
    const typing = !question.options || isTyping;

    const submit = (answer: string | string[]) => {
        const next = {...answers, [question.question]: answer};
        if (index === questions.length - 1) {
            req.resolve({behavior: "allow", answers: next});
            onDone();
        } else {
            setAnswers(next);
            setIndex(index + 1);
            setSelectedIndex(0);
            setSelected([]);
            setIsTyping(false);
            setDraft("");
        }
    };
    const selectedLabels = () => selected.map(i => options[i]!.label);
    const submitText = (text: string) => {
        const value = text.trim();
        if (!value) return;
        submit(question.multi_select ? [...new Set([...selectedLabels(), value])] : value);
    };
    const toggle = () => setSelected(values => values.includes(selectedIndex)
        ? values.filter(i => i !== selectedIndex)
        : [...values, selectedIndex].sort((a, b) => a - b));

    useTerminalInput((input, key) => {
        if ((key.shift && key.rightArrow) || (key.meta && key.downArrow) || key.escape) {
            if (onBack) onBack();
            else if (typing && question.options) setIsTyping(false);
            return;
        }
        if (typing) return; // TextInput owns text, paste and Enter.
        if (key.upArrow) setSelectedIndex(i => (i - 1 + options.length + 1) % (options.length + 1));
        else if (key.downArrow) setSelectedIndex(i => (i + 1) % (options.length + 1));
        else if (input === " " && question.multi_select && selectedIndex < options.length) toggle();
        else if (key.return) {
            if (selectedIndex === options.length) setIsTyping(true);
            else if (question.multi_select) {if (selected.length) submit(selectedLabels());}
            else submit(options[selectedIndex]!.label);
        }
    }, {isActive: active});

    if (!active) return null;
    const rows = (text: string, color?: string) => wrapPanelText(text, contentWidth).map((line, i) =>
        <Text key={i} color={color}>{line}</Text>);
    const hint = `${question.multi_select && !typing ? "↑↓ move · Space select · " : options.length && !typing ? "↑↓ select · " : ""}Enter ${index === questions.length - 1 ? "submit" : "next"} · ${onBack ? "Shift+→ / Esc back" : "Esc cancel"}`;
    return <Box flexDirection="column" paddingX={padding}>
        <Text color={COLORS.dim}>{questions.length > 1 ? `Question ${index + 1} of ${questions.length}` : "Question"}</Text>
        <Box marginTop={1} flexDirection="column">{rows(question.question)}</Box>
        <Box marginTop={1} flexDirection="column">
            {options.map((option, i) => <Box key={i} flexDirection="column">
                {rows(`${selectedIndex === i && !typing ? "›" : " "} ${i + 1}. ${question.multi_select ? (selected.includes(i) ? "[x] " : "[ ] ") : ""}${option.label}`,
                    selectedIndex === i && !typing ? COLORS.accent : undefined)}
                {option.description && rows(`     ${option.description}`, COLORS.dim)}
            </Box>)}
            {typing ? <Box>
                <Text color={COLORS.accent}>› </Text>
                <Box flexGrow={1} flexShrink={1} minWidth={0}>
                    <TextInput value={draft} onChange={value => setDraft(value.slice(0, MAX_CUSTOM_ANSWER_CHARS))}
                        onSubmit={submitText} placeholder="Type your answer"/>
                </Box>
            </Box> : rows(`${selectedIndex === options.length ? "›" : " "} ${options.length + 1}. ${draft || "Type your own answer"}`,
                selectedIndex === options.length ? COLORS.accent : COLORS.dim)}
        </Box>
        <Box marginTop={1} flexDirection="column">{rows(hint, COLORS.dim)}</Box>
    </Box>;
}
