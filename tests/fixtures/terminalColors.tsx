import {Box} from "ink";
import {cleanup, render} from "ink-testing-library";
import {StructuredDiff} from "../../src/ui/fileChanges/StructuredDiff.js";
import {StatusBar} from "../../src/ui/status/StatusBar.js";

const view = render(<Box flexDirection="column">
    <StatusBar cwd="/workspace" model="STATUS" permissionMode="ask" collaborationMode="build"
        tokenCount={12} percentUsed={0.01} warning={false} tokenStatus="actual"/>
    <StructuredDiff width={40} expanded={false} hunks={[{oldStart: 1, oldLines: 1, newStart: 1, newLines: 1,
        lines: [{type: "remove", oldLineNumber: 1, content: "const value = 'old';"},
            {type: "add", newLineNumber: 1, content: "const value = 'new';"}]}]}/>
</Box>);
process.stdout.write(JSON.stringify(view.lastFrame()));
cleanup();
