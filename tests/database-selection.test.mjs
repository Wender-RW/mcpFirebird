// Real tools, registry, policy, query boundary and pools; only the driver is replaced.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { installSelectionDriver } from './fixtures/selection-driver.mjs';

process.env.LOG_LEVEL = 'error';
process.env.USE_NATIVE_DRIVER = 'false';

const DEFAULT_PATH = '/dados/padrao.fdb';
const ERP_PATH = '/dados/clientes/erp.fdb';
const attached = [];
const detached = [];
installSelectionDriver({
    defaultDatabase: DEFAULT_PATH,
    onAttach: database => attached.push(database),
    onDetach: database => detached.push(database)
});

const { setupDatabaseTools } = await import('../dist/tools/database.js');
const { setupMetadataTools } = await import('../dist/tools/metadata.js');
const { DatabaseRegistry } = await import('../dist/db/database-registry.js');
const { closePool, closeDatabasePool, getDefaultConfig } = await import('../dist/db/connection.js');
after(closePool);

const registry = new DatabaseRegistry(getDefaultConfig);
const prepared = registry.prepare(ERP_PATH);
const erp = registry.commit(prepared);
const databaseTools = setupDatabaseTools(registry);
const tools = new Map([...databaseTools, ...setupMetadataTools(databaseTools, undefined, registry)]);
const call = async (name, args) => (await tools.get(name).handler(args)).structuredContent;

test('list-tables returns the tables of the database named in each call', async () => {
    assert.deepEqual((await call('list-tables', {})).result.tables, ['T_padrao']);
    assert.deepEqual((await call('list-tables', { database: 'default' })).result.tables, ['T_padrao']);
    assert.deepEqual((await call('list-tables', { database: 'erp' })).result.tables, ['T_erp']);
});

test('metadata tools query the database named in the call', async () => {
    const chosen = await call('list-triggers', { database: 'erp' });
    assert.equal(chosen.result.triggers[0].name, 'TR_erp');
    const fallback = await call('list-triggers', {});
    assert.equal(fallback.result.triggers[0].name, 'TR_padrao');
});

test('concurrent calls on default and on another alias each get rows from their own database', async () => {
    const calls = Array.from({ length: 40 }, (_, i) => {
        const database = i % 2 === 0 ? 'default' : 'erp';
        return call('execute-query', { sql: `SELECT ${i} FROM T`, database }).then(out => ({ database, out }));
    });
    for (const { database, out } of await Promise.all(calls)) {
        assert.equal(out.success, true);
        assert.equal(out.result.rows[0].DB, database === 'erp' ? ERP_PATH : DEFAULT_PATH);
    }
    assert.ok(attached.includes(DEFAULT_PATH) && attached.includes(ERP_PATH));
});

test('an unknown alias fails without opening any connection', async () => {
    const before = attached.length;
    const out = await call('execute-query', { sql: 'SELECT 1 FROM T', database: 'inexistente' });
    assert.equal(out.success, false);
    assert.match(out.error.message, /Unknown database alias "inexistente"\. Valid aliases: default, erp/);
    assert.equal(attached.length, before);
});

test('closing the pool of one database leaves the other serving queries', async () => {
    await call('execute-query', { sql: 'SELECT 1 FROM T', database: 'erp' });
    detached.length = 0;
    await closeDatabasePool(erp.config);
    assert.ok(detached.length > 0);
    assert.ok(detached.every(database => database === ERP_PATH));
    const out = await call('execute-query', { sql: 'SELECT 2 FROM T' });
    assert.equal(out.result.rows[0].DB, DEFAULT_PATH);
});
