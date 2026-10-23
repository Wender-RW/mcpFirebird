# MCP Firebird Configuration

This document describes the different configuration options available for MCP Firebird.

## Environment Variables

You can configure the server using environment variables:

```bash
# Basic configuration
export FIREBIRD_HOST=localhost
export FIREBIRD_PORT=3050
export FIREBIRD_DATABASE=/path/to/database.fdb
export FIREBIRD_USER=SYSDBA
export FIREBIRD_PASSWORD=masterkey
export FIREBIRD_ROLE=undefined  # Optional

# Enterprise Managed Authorization (EMA)
export FIREBIRD_API_KEY=my_secret_token_123

# Logging configuration
export LOG_LEVEL=info  # Options: debug, info, warn, error
```

You can create a `.env` file in the project root to set these variables. A `.env.example` file is provided as a template.

## Example .env file

```
FIREBIRD_HOST=localhost
FIREBIRD_PORT=3050
FIREBIRD_DATABASE=F:\Proyectos\SAI\EMPLOYEE.FDB
FIREBIRD_USER=SYSDBA
FIREBIRD_PASSWORD=masterkey
FIREBIRD_ROLE=

# Enterprise Managed Authorization (EMA)
FIREBIRD_API_KEY=my_secret_token_123

# Transport configuration
TRANSPORT_TYPE=sse  # Recommended: sse (HTTP Streamable). Legacy: stdio
SSE_PORT=3003
```

## Connecting More Than One Database

With the `stdio` transport, the model can open other databases on the same Firebird server during the conversation. No restart or second server entry is needed.

Three tools manage the connections:

- `connect-database` takes `path` and an optional `alias`. It opens the database, tests the connection and returns the alias to use.
- `list-databases` returns the default database and the connected ones, each with its alias and path.
- `disconnect-database` takes `alias`, closes the connections of that database and removes the alias.

Every tool that queries a database also accepts an optional `database` argument with an alias. Without it, or with `default`, the tool uses the database configured at startup, as before.

```json
{ "path": "D:\\clients\\c42\\erp.fdb" }
```

`connect-database` answers with the alias, here `erp`:

```json
{ "alias": "erp", "path": "D:\\clients\\c42\\erp.fdb", "alreadyConnected": false }
```

Later calls name the database:

```json
{ "tableName": "CUSTOMERS", "database": "erp" }
```

Rules for the path and the alias:

- The path must be absolute: a drive letter followed by a separator (`D:\data\app.fdb` or `D:/data/app.fdb`), or a path that starts with `/`.
- Host, port, user, password, role and wire encryption always come from the server configuration. `connect-database` refuses any other field.
- A path that would change the server is refused before any connection: a host prefix (`srv:/data/app.fdb`), a UNC path (`\\srv\share`), a protocol (`inet://srv/app.fdb`), a relative path and an alias of `databases.conf`.
- Without `alias`, the alias is the file name without extension, in lowercase, with every character outside `a-z`, `0-9`, `_` and `-` replaced by `_`. If the alias exists, `-2`, `-3` and so on are appended.
- An informed `alias` uses only `a-z`, `0-9`, `_` and `-`, up to 63 characters. `default` is reserved, and an alias already used by another path is an error.
- Connecting a path that is already connected, even written differently (`d:/data/app.fdb` and `D:\data\app.fdb`), returns the existing alias.

What stays on the default database: the resources (`firebird://...`), the prompts, the events (`POST_EVENT`) and the audit table. Connected databases follow the same security policy as the default one: allowed tables and operations, data masking, resource limits and audit.

With `http`, `sse` and `unified`, the three connection tools are not registered, and `database` accepts only `default`.

### Risks

The model can connect to any database that the server credential can open on that Firebird server, including `security4.fdb` and databases of other applications. Reduce the exposure before enabling this in a shared server:

- Set `DatabaseAccess = Restrict <folder list>` in `firebird.conf`, so the Firebird server only opens files in those folders.
- Run the MCP server with a Firebird user that does not have the `SYSDBA` role.
- Keep tool approval enabled in the client for `connect-database`. Text returned by a query can try to make the model connect another database.
- The security policy was written for the default database. Table names differ in other databases, so check `allowedTables` and `rowFilters` before connecting them.

## Using with npx

You can run the server directly with npx:

```bash
npx mcp-firebird --host localhost --port 3050 --database /path/to/database.fdb --user SYSDBA --password masterkey
```

## Streamable HTTP (SSE) Transport [RECOMMENDED]

MCP Firebird fully supports **Streamable HTTP (SSE)** for communication with network clients (like n8n or remote Claude deployments). This is the recommended transport mode.

```bash
# Run with Streamable HTTP transport
export TRANSPORT_TYPE=sse
export SSE_PORT=3003
npx -y mcp-firebird
```

Or using command line parameters:

```bash
npx -y mcp-firebird --transport-type sse --sse-port 3003 --database /path/to/database.fdb --host localhost --port 3050 --user SYSDBA --password masterkey --api-key my_secret_token_123
```

### HTTP Client Examples (EMA Authorization)

```javascript
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

// Connect using the Streamable HTTP protocol with EMA Bearer Token
const transport = new StreamableHTTPClientTransport(
    new URL("http://localhost:3003/mcp"),
    {
        headers: {
            "Authorization": "Bearer my_secret_token_123"
        }
    }
);

const client = new Client(
    { name: "my-client", version: "1.0.0" },
    { capabilities: { resources: { subscribe: true } } }
);

await client.connect(transport);
console.log("Successfully connected!");
```

## Configuration with Claude Desktop

To use the MCP Firebird server with Claude Desktop:

### Windows
```powershell
code $env:AppData\Claude\claude_desktop_config.json
```

### macOS/Linux
```bash
code ~/Library/Application\ Support/Claude/claude_desktop_config.json
```

Add the following configuration:

```json
{
  "mcpServers": {
    "mcp-firebird": {
      "command": "npx",
      "args": [
        "-y",
        "mcp-firebird",
        "--database",
        "C:\\path\\to\\database.fdb",
        "--host",
        "localhost",
        "--port",
        "3050",
        "--user",
        "SYSDBA",
        "--password",
        "masterkey"
      ]
    }
  }
}
```

> **Note**: Make sure to use absolute paths in the configuration.

After saving the file, you need to completely restart Claude Desktop.
