jest.mock('../../db/index.js', () => ({
    executeQuery: jest.fn(), listTables: jest.fn(), describeTable: jest.fn(),
    getFieldDescriptions: jest.fn(), analyzeQueryPerformance: jest.fn(),
    getExecutionPlan: jest.fn(), analyzeMissingIndexes: jest.fn(),
    executeBatchQueries: jest.fn(), describeBatchTables: jest.fn(),
    getTableIndexes: jest.fn(), getTableConstraints: jest.fn(), getTableTriggers: jest.fn(),
    getDefaultConfig: jest.fn()
}));

import * as db from '../../db/index.js';
import type { ConfigOptions } from '../../db/connection.js';
import { DatabaseRegistry } from '../../db/database-registry.js';
import { setupDatabaseTools } from '../../tools/database.js';
import { DEFAULT_SECURITY_CONFIG, securityConfig } from '../../security/config.js';

const defaultConfig: ConfigOptions = {
    host: '127.0.0.1', port: 3050, user: 'SYSDBA', password: 'masterkey', database: '/dados/padrao.fdb'
};
const sql = 'SELECT * FROM TEST';

// Arguments that satisfy each tool's schema, apart from `database`.
const toolArgs: Record<string, Record<string, unknown>> = {
    'execute-query': { sql },
    'list-tables': {},
    'describe-table': { tableName: 'TEST' },
    'get-field-descriptions': { tableName: 'TEST' },
    'get-table-indexes': { tableName: 'TEST' },
    'get-table-constraints': { tableName: 'TEST' },
    'get-table-triggers': { tableName: 'TEST' },
    'analyze-query-performance': { sql },
    'get-execution-plan': { sql },
    'analyze-missing-indexes': { sql },
    'execute-batch-queries': { queries: [{ sql }] },
    'describe-batch-tables': { tableNames: ['TEST'] },
    'get-table-data': { tableName: 'TEST', first: 10, skip: 0 },
    'analyze-table-statistics': { tableName: 'TEST' },
    'get-database-info': {}
};

const dbMocks = [
    db.executeQuery, db.listTables, db.describeTable, db.getFieldDescriptions, db.analyzeQueryPerformance,
    db.getExecutionPlan, db.analyzeMissingIndexes, db.executeBatchQueries, db.describeBatchTables,
    db.getTableIndexes, db.getTableConstraints, db.getTableTriggers
].map(fn => fn as jest.Mock);

describe('database argument on database tools', () => {
    let registry: DatabaseRegistry;
    let erp: ConfigOptions;
    let tools: ReturnType<typeof setupDatabaseTools>;

    beforeEach(() => {
        jest.resetAllMocks();
        for (const key of Object.keys(securityConfig)) delete (securityConfig as any)[key];
        Object.assign(securityConfig, structuredClone(DEFAULT_SECURITY_CONFIG));
        jest.mocked(db.getDefaultConfig).mockReturnValue(defaultConfig);
        registry = new DatabaseRegistry(() => defaultConfig);
        const prepared = registry.prepare('/dados/clientes/erp.fdb');
        if ('existing' in prepared) throw new Error('unexpected');
        erp = registry.commit(prepared).config;
        (db.executeQuery as jest.Mock).mockResolvedValue([{ ID: 1 }]);
        (db.listTables as jest.Mock).mockResolvedValue(['CUSTOMERS']);
        (db.describeTable as jest.Mock).mockResolvedValue([]);
        (db.executeBatchQueries as jest.Mock).mockResolvedValue([{ success: true, data: [] }]);
        (db.describeBatchTables as jest.Mock).mockResolvedValue([{ tableName: 'TEST', schema: [] }]);
        tools = setupDatabaseTools(registry);
    });

    test('every tool that queries a database accepts the optional `database` argument', () => {
        for (const [name, tool] of tools) {
            const shape = tool.inputSchema.shape as Record<string, unknown>;
            if (name === 'verify-wire-encryption') expect(shape).not.toHaveProperty('database');
            else expect(shape).toHaveProperty('database');
        }
    });

    test('execute-query without `database` runs on the configured default database', async () => {
        const response = await tools.get('execute-query')!.handler({ sql });
        expect(response.isError).not.toBe(true);
        expect(db.executeQuery).toHaveBeenCalledWith(sql, [], undefined);
    });

    test('`default` selects the configured default database too', async () => {
        await tools.get('execute-query')!.handler({ sql, database: 'default' });
        expect(db.executeQuery).toHaveBeenCalledWith(sql, [], undefined);
    });

    test('execute-query with a registered alias runs on that database', async () => {
        await tools.get('execute-query')!.handler({ sql, database: 'erp' });
        expect(db.executeQuery).toHaveBeenCalledWith(sql, [], erp);
    });

    test('describe-table with a registered alias queries the config of that alias', async () => {
        await tools.get('describe-table')!.handler({ tableName: 'TEST', database: 'erp' });
        expect(db.describeTable).toHaveBeenCalledWith('TEST', erp);
    });

    test('every tool passes the alias config to the database layer', async () => {
        for (const [name, args] of Object.entries(toolArgs)) {
            dbMocks.forEach(mock => mock.mockClear());
            await tools.get(name)!.handler({ ...args, database: 'erp' });
            const calls = dbMocks.flatMap(mock => mock.mock.calls);
            expect(calls.length).toBeGreaterThan(0);
            for (const call of calls) expect(call).toContain(erp);
        }
    });

    test('an unknown alias returns an error listing the valid aliases, and nothing runs in any database', async () => {
        for (const [name, args] of Object.entries(toolArgs)) {
            const response = await tools.get(name)!.handler({ ...args, database: 'inexistente' });
            expect(response.isError).toBe(true);
            expect(response.structuredContent.error).toMatchObject({
                type: 'UNKNOWN_DATABASE_ALIAS',
                message: 'Unknown database alias "inexistente". Valid aliases: default, erp'
            });
            dbMocks.forEach(mock => expect(mock).not.toHaveBeenCalled());
        }
    });

    test('get-database-info describes the chosen database', async () => {
        const chosen = await tools.get('get-database-info')!.handler({ database: 'erp' });
        expect(chosen.structuredContent.result).toEqual({
            database: 'erp', path: '/dados/clientes/erp.fdb', totalTables: 1, tables: ['CUSTOMERS']
        });
        expect(db.listTables).toHaveBeenCalledWith(erp);

        const fallback = await tools.get('get-database-info')!.handler({});
        expect(fallback.structuredContent.result).toMatchObject({ database: 'default', path: '/dados/padrao.fdb' });
        expect(db.listTables).toHaveBeenLastCalledWith(undefined);
    });

    test('the security policy applies to a connected database like to the default one', async () => {
        securityConfig.forbiddenOperations = ['DELETE'];
        const response = await tools.get('execute-query')!.handler({ sql: 'DELETE FROM TEST', database: 'erp' });
        expect(response.isError).toBe(true);
        expect(db.executeQuery).not.toHaveBeenCalled();
    });
});
