# Local HTTP MCP demo

Run from the HiCode repository; its dependencies must already be installed:

```sh
bun tooling/examples/mcp/http-demo.ts
```

The server listens only on `127.0.0.1:8787`. An optional positional argument changes the port. Keep this terminal open; Ctrl+C stops the service.

Add the `http_demo` entry to the existing `mcpServers` object in your test project's `.hicode/mcp.json`, then restart HiCode:

```json
{
  "mcpServers": {
    "http_demo": {
      "url": "http://127.0.0.1:8787/mcp"
    }
  }
}
```

Use HiCode's current source version with Streamable HTTP support. This example uses neither an API key nor an external service.

Try asking: “Use the http_demo MCP tools to greet HiCode, calculate 17 + 25, and wait 3 seconds before returning ‘HTTP test complete’. Include the request IDs returned by the server.”

The three read-only tools are `hello`, `add` and `wait`. Each successful call returns a fresh request ID. To test cancellation, request a 30-second wait and press Esc while it is running. The server terminal shows calls and cancellation; `/health` reports availability and the active session count. Closing HiCode disconnects its MCP session but leaves this separately started server running.
