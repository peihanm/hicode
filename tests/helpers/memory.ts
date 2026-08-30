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
import {createTestStorage} from "./tempProject.js";
import {testChildEnvironment} from "./childEnvironment.js";

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
        storage: createTestStorage(cwd),
        cwd,
        getModelTarget: () => ({
            source: "glm",
            provider: "glm",
            model: "glm-test",
            label: "GLM Test",
        }),
        getModelSource: () => ({
            id: "glm",
            label: "GLM Test",
            apiKeyEnv: "GLM_API_KEY",
            models: [{id: "glm-test", label: "GLM Test"}],
        }),
        shellRunner: createShellRunner(
            createDisabledSandboxRuntime(),
            testChildEnvironment
        ),
        settings: {
            enabled: options.enabled ?? true,
            autoExtract: options.autoExtract ?? false,
        },
    });
}
