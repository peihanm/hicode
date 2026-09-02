import {createAndRunCodeCase} from "../cases/createAndRunCode.js";
import {fixFailingTestCase} from "../cases/fixFailingTest.js";
import {leetcodeWebCase} from "../cases/leetcodeWeb.js";
import type {EvalCase} from "./types.js";

const CASES: readonly EvalCase[] = [
    fixFailingTestCase,
    createAndRunCodeCase,
    leetcodeWebCase,
];

export function listEvalCases(): readonly EvalCase[] {
    return CASES;
}

export function getEvalCase(caseId: string): EvalCase {
    const found = CASES.find((candidate) => candidate.id === caseId);
    if (!found) {
        throw new Error(
            `未知 Eval Case ${caseId}；可用 Case: ${CASES.map((item) => item.id).join(", ")}`
        );
    }
    return found;
}
