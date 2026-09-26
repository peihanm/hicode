import {expect, test} from "bun:test";
import {createServer} from "node:http";
import {connect, type Socket} from "node:net";
import {createChildProcessEnvironment, mergeChildProcessEnvironment} from "../../src/runtime/childEnvironment.js";

test("Node child fetch honors the configured proxy and NO_PROXY without command prefixes", async () => {
    const node = Bun.which("node");
    if (!node) throw new Error("Node is required for child proxy integration tests");
    const destination = Bun.serve({hostname: "127.0.0.1", port: 0, fetch: () => new Response("PROXY_FIXTURE_OK")});
    const destinationPort = destination.port;
    if (destinationPort === undefined) {await destination.stop(true); throw new Error("Missing destination port");}
    const tunnels: string[] = [];
    const sockets = new Set<Socket>();
    const proxy = createServer((_request, response) => {response.writeHead(500).end();});
    proxy.on("connection", socket => {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
    });
    proxy.on("connect", (request, socket, head) => {
        tunnels.push(request.url ?? "");
        if (request.url !== "hicode-proxy-fixture.invalid:80") {socket.destroy(); return;}
        const upstream = connect({host: "127.0.0.1", port: destinationPort}, () => {
            socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
            if (head.length) upstream.write(head);
            socket.pipe(upstream).pipe(socket);
        });
        sockets.add(upstream);
        upstream.on("close", () => sockets.delete(upstream));
        upstream.on("error", () => socket.destroy());
        socket.on("error", () => upstream.destroy());
        socket.on("close", () => upstream.destroy());
    });
    try {
        await new Promise<void>((resolve, reject) => {
            proxy.once("error", reject);
            proxy.listen(0, "127.0.0.1", resolve);
        });
        const address = proxy.address();
        if (!address || typeof address === "string") throw new Error("Missing proxy address");
        const env = mergeChildProcessEnvironment(createChildProcessEnvironment({
            HTTP_PROXY: `http://127.0.0.1:${address.port}`, NO_PROXY: "127.0.0.1", NODE_NO_WARNINGS: "1",
        }, []));
        const child = Bun.spawn([node, "--input-type=module", "-e", `
            for (const url of ['http://hicode-proxy-fixture.invalid/', 'http://127.0.0.1:${destination.port}/']) {
                const response = await fetch(url, {signal: AbortSignal.timeout(3000)});
                if (await response.text() !== 'PROXY_FIXTURE_OK') throw new Error('Unexpected response');
            }
            console.log('PROXY_AND_BYPASS_OK');
        `], {env, stdout: "pipe", stderr: "pipe"});
        const deadline = setTimeout(() => child.kill(), 8000);
        try {
            const [code, stdout, stderr] = await Promise.all([
                child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
            ]);
            expect(stderr).toBe("");
            expect(code).toBe(0);
            expect(stdout).toContain("PROXY_AND_BYPASS_OK");
            expect(tunnels).toEqual(["hicode-proxy-fixture.invalid:80"]);
        } finally {clearTimeout(deadline); child.kill(); await child.exited;}
    } finally {
        for (const socket of sockets) socket.destroy();
        await new Promise<void>(resolve => proxy.close(() => resolve()));
        await destination.stop(true);
    }
}, 12000);
