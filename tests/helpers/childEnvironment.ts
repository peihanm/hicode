import {createChildProcessEnvironment} from "../../src/runtime/childEnvironment.js";

export const testChildEnvironment = createChildProcessEnvironment(
    process.env,
    []
);
