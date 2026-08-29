import {join} from "node:path";
import {
    createMemoryRuntimeFactory,
    MemoryStore,
    type MemoryExtractor,
    type MemoryRuntimeFactoryDependencies,
    type MemoryRuntimeLike,
} from "../../src/memory/index.js";
import {createDisabledSandboxRuntime} from "../../src/sandbox/index.js";
import {createShellRunner} from "../../src/tools/bash/shellRunner.js";

const noChanges: MemoryExtractor = {
    async extract() {
    },
};

export function createTestMemoryRuntime(
    cwd: string,
    options: {
        enabled?: boolean;
        autoExtract?: boolean;
        extractor?: MemoryExtractor;
        createExtractor?: MemoryRuntimeFactoryDependencies["createExtractor"];
        directory?: string;
    } = {}
): MemoryRuntimeLike {
    const directory = options.directory ?? join(cwd, "memory");
    return createMemoryRuntimeFactory({
        createStore: () => new MemoryStore(directory),
        createExtractor:
            options.createExtractor ?? (() => options.extractor ?? noChanges),
    })({
        cwd,
        model: "glm-test",
        provider: "glm",
        shellRunner: createShellRunner(createDisabledSandboxRuntime()),
        settings: {
            enabled: options.enabled ?? true,
            autoExtract: options.autoExtract ?? false,
        },
    });
}
