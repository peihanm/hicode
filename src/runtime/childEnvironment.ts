const SECRET_ENVIRONMENT_NAME =
    /(?:^|_)(?:API_?KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|PRIVATE_?KEY)(?:_|$)/i;

export interface ChildProcessEnvironment {
    readonly base: NodeJS.ProcessEnv;
    readonly excludedNames: ReadonlySet<string>;
}

function copySafeValues(
    target: NodeJS.ProcessEnv,
    source: NodeJS.ProcessEnv,
    excludedNames: ReadonlySet<string>
): void {
    for (const [name, value] of Object.entries(source)) {
        if (
            value !== undefined &&
            !excludedNames.has(name.toUpperCase()) &&
            !SECRET_ENVIRONMENT_NAME.test(name)
        ) {
            target[name] = value;
        }
    }
}

/** Build the environment capability exposed to project-owned child processes. */
export function createChildProcessEnvironment(
    source: NodeJS.ProcessEnv,
    secretNames: readonly string[]
): ChildProcessEnvironment {
    const excludedNames = new Set(secretNames.map((name) => name.toUpperCase()));
    const base: NodeJS.ProcessEnv = {};
    copySafeValues(base, source, excludedNames);
    return {base, excludedNames};
}

export function mergeChildProcessEnvironment(
    environment: ChildProcessEnvironment,
    ...overrides: Array<NodeJS.ProcessEnv | undefined>
): NodeJS.ProcessEnv {
    const result: NodeJS.ProcessEnv = {...environment.base};
    for (const override of overrides) {
        if (override) {
            copySafeValues(result, override, environment.excludedNames);
        }
    }
    return result;
}
