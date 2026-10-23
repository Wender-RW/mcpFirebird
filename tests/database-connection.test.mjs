// End to end through MCP clients: stdio offers the connection tools, HTTP does not.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { installSelectionDriver } from './fixtures/selection-driver.mjs';

process.env.LOG_LEVEL = 'error';
process.env.USE_NATIVE_DRIVER = 'false';
installSelectionDriver({ defaultDatabase: '/dados/padrao.fdb' });
const { closePool } = await import('../dist/db/connection.js');
const { createMcpServerInstance } = await import('../dist/server/index.js');
const { createHttpApplication } = await import('../dist/server/http-server.js');
const { loadHttpSecurityConfig } = await import('../dist/server/http-security.js');
after(closePool);

const CONNECTION_TOOLS = ['connect-database', 'list-databases', 'disconnect-database'];
const clientFor = era => new Client({ name: 'database-connection', version: '1' },
    era === 'modern' ? { versionNegotiation: { mode: { pin: '2026-07-28' } } } : {});

for (const era of ['legacy', 'modern']) {
    test(`stdio ${era}: connect, query both databases, disconnect`, { timeout: 30000 }, async () => {
        const env = { ...process.env, TRANSPORT_TYPE: 'stdio', LOG_LEVEL: 'error' };
        for (const key of ['FIREBIRD_SECURITY_CONFIG', 'SECURITY_CONFIG', 'SECURITY_CONFIG_PATH', 'FIREBIRD_SECURITY_JSON', 'QUERY_TIMEOUT', 'ALLOW_RAW_SQL']) delete env[key];
        const client = clientFor(era);
        await client.connect(new StdioClientTransport({
            command: process.execPath, args: ['tests/fixtures/selection-server.mjs'], env, stderr: 'pipe'
        }));
        try {
            const { tools } = await client.listTools();
            const names = tools.map(tool => tool.name);
            for (const name of CONNECTION_TOOLS) assert.ok(names.includes(name), name);
            const connect = tools.find(tool => tool.name === 'connect-database');
            assert.equal(connect.inputSchema.additionalProperties, false);
            assert.deepEqual(connect.inputSchema.required, ['path']);
            assert.equal(tools.find(tool => tool.name === 'list-tables').inputSchema.properties.database.type, 'string');

            const call = async (name, args) => client.callTool({ name, arguments: args });
            const connected = await call('connect-database', { path: '/dados/clientes/erp.fdb' });
            assert.deepEqual(connected.structuredContent.result, { alias: 'erp', path: '/dados/clientes/erp.fdb', alreadyConnected: false });

            assert.deepEqual((await call('list-tables', {})).structuredContent.result.tables, ['T_padrao']);
            assert.deepEqual((await call('list-tables', { database: 'erp' })).structuredContent.result.tables, ['T_erp']);
            assert.equal((await call('execute-query', { sql: 'SELECT 1 FROM T', database: 'erp' })).structuredContent.result.rows[0].DB, '/dados/clientes/erp.fdb');
            assert.equal((await call('get-database-info', { database: 'erp' })).structuredContent.result.database, 'erp');

            const listed = (await call('list-databases', {})).structuredContent.result.databases;
            assert.deepEqual(listed, [{ alias: 'default', path: '/dados/padrao.fdb' }, { alias: 'erp', path: '/dados/clientes/erp.fdb' }]);

            const failed = await call('connect-database', { path: '/dados/clientes/nao-abre.fdb' });
            assert.equal(failed.isError, true);
            assert.match(failed.content[0].text, /nao-abre\.fdb/);
            const afterFailure = (await call('list-databases', {})).structuredContent.result.databases;
            assert.deepEqual(afterFailure.map(entry => entry.alias), ['default', 'erp']);

            for (const extra of [{ password: 'x' }, { host: 'other' }]) {
                const refused = await call('connect-database', { path: '/dados/outro.fdb', ...extra }).then(result => result.isError === true, () => true);
                assert.equal(refused, true, JSON.stringify(extra));
            }
            assert.deepEqual((await call('list-databases', {})).structuredContent.result.databases.map(entry => entry.alias), ['default', 'erp']);

            assert.equal((await call('disconnect-database', { alias: 'default' })).isError, true);
            assert.deepEqual((await call('disconnect-database', { alias: 'erp' })).structuredContent.result, { alias: 'erp', path: '/dados/clientes/erp.fdb' });
            const gone = await call('list-tables', { database: 'erp' });
            assert.equal(gone.isError, true);
            assert.equal(gone.structuredContent.error.type, 'UNKNOWN_DATABASE_ALIAS');
            assert.deepEqual((await call('list-tables', {})).structuredContent.result.tables, ['T_padrao']);
        } finally { await client.close(); }
    });
}

for (const era of ['legacy', 'modern']) {
    test(`http ${era}: no connection tools, and only the default database is accepted`, { timeout: 30000 }, async () => {
        process.env.STREAMABLE_STATELESS_MODE = 'false';
        const http = createHttpApplication(createMcpServerInstance, loadHttpSecurityConfig({}));
        const listener = http.app.listen(0, '127.0.0.1');
        await once(listener, 'listening');
        const client = clientFor(era);
        try {
            await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${listener.address().port}/mcp`)));
            const { tools } = await client.listTools();
            const names = tools.map(tool => tool.name);
            for (const name of CONNECTION_TOOLS) assert.ok(!names.includes(name), name);
            assert.equal(tools.find(tool => tool.name === 'execute-query').inputSchema.properties.database.type, 'string');

            const call = async (name, args) => client.callTool({ name, arguments: args });
            assert.equal((await call('execute-query', { sql: 'SELECT 1 FROM T', database: 'default' })).structuredContent.result.rows[0].DB, '/dados/padrao.fdb');
            const refused = await call('execute-query', { sql: 'SELECT 1 FROM T', database: 'erp' });
            assert.equal(refused.isError, true);
            assert.equal(refused.structuredContent.error.type, 'UNKNOWN_DATABASE_ALIAS');
            assert.match(refused.structuredContent.error.message, /Valid aliases: default$/);
        } finally {
            await client.close();
            await http.close();
            await new Promise(resolve => listener.close(resolve));
        }
    });
}
