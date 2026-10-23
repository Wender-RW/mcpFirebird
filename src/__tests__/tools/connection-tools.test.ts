jest.mock('../../db/index.js', () => ({
    executeQuery: jest.fn(), listTables: jest.fn(), describeTable: jest.fn(),
    getFieldDescriptions: jest.fn(), analyzeQueryPerformance: jest.fn(),
    getExecutionPlan: jest.fn(), analyzeMissingIndexes: jest.fn(),
    executeBatchQueries: jest.fn(), describeBatchTables: jest.fn(),
    getTableIndexes: jest.fn(), getTableConstraints: jest.fn(), getTableTriggers: jest.fn(),
    getDefaultConfig: jest.fn(), testConnection: jest.fn(), closeDatabasePool: jest.fn()
}));

import * as db from '../../db/index.js';
import type { ConfigOptions } from '../../db/connection.js';
import { DatabaseRegistry } from '../../db/database-registry.js';
import { FirebirdError } from '../../utils/errors.js';
import { setupConnectionTools, ConnectDatabaseArgsSchema, DisconnectDatabaseArgsSchema, ListDatabasesArgsSchema } from '../../tools/connections.js';
import { setupDatabaseTools } from '../../tools/database.js';

const defaultConfig: ConfigOptions = {
    host: 'srv-fb', port: 3051, user: 'APP_USER', password: 'S3CRET-PASSWORD', role: 'APP_ROLE',
    wireCrypt: 'Required', database: 'D:\\dados\\padrao.fdb'
};

describe('connection tools', () => {
    let registry: DatabaseRegistry;
    let tools: ReturnType<typeof setupConnectionTools>;
    const call = async (name: string, args: Record<string, unknown>) => (await tools.get(name)!.handler(args)).structuredContent;

    beforeEach(() => {
        jest.resetAllMocks();
        jest.mocked(db.getDefaultConfig).mockReturnValue(defaultConfig);
        jest.mocked(db.testConnection).mockResolvedValue(undefined);
        jest.mocked(db.closeDatabasePool).mockResolvedValue(undefined);
        registry = new DatabaseRegistry(() => defaultConfig);
        tools = setupConnectionTools(registry);
    });

    describe('connect-database', () => {
        test('connects with the server host, port and credentials and returns the alias and normalized path', async () => {
            const out = await call('connect-database', { path: 'd:/clientes/c42/erp.fdb' });
            expect(out).toEqual({ success: true, result: { alias: 'erp', path: 'D:\\clientes\\c42\\erp.fdb', alreadyConnected: false } });
            expect(db.testConnection).toHaveBeenCalledTimes(1);
            expect(db.testConnection).toHaveBeenCalledWith({ ...defaultConfig, database: 'D:\\clientes\\c42\\erp.fdb' });
            expect(registry.aliases()).toEqual(['default', 'erp']);
        });

        test('uses the informed alias', async () => {
            const out = await call('connect-database', { path: '/dados/erp.fdb', alias: 'vendas' });
            expect(out.result).toMatchObject({ alias: 'vendas' });
        });

        test('a connection failure returns the reason, registers no alias and closes the pool it opened', async () => {
            jest.mocked(db.testConnection).mockRejectedValue(new FirebirdError('Database not found: /dados/x.fdb', 'DATABASE_CONNECTION'));
            const out = await call('connect-database', { path: '/dados/x.fdb' });
            expect(out.success).toBe(false);
            expect(out.error).toMatchObject({ type: 'DATABASE_CONNECTION', message: 'Database not found: /dados/x.fdb' });
            expect(registry.aliases()).toEqual(['default']);
            expect(db.closeDatabasePool).toHaveBeenCalledWith({ ...defaultConfig, database: '/dados/x.fdb' });
        });

        test('the failed alias can be used again later', async () => {
            jest.mocked(db.testConnection).mockRejectedValueOnce(new FirebirdError('refused', 'DATABASE_CONNECTION'));
            await call('connect-database', { path: '/dados/erp.fdb', alias: 'erp' });
            const out = await call('connect-database', { path: '/dados/erp.fdb', alias: 'erp' });
            expect(out.success).toBe(true);
        });

        test.each(['srv2:/dados/x.fdb', 'srv2:D:\\x.fdb', '\\\\srv\\share\\x.fdb', 'inet://srv/x.fdb', 'employee', 'dados\\x.fdb'])(
            'invalid path %p returns an error without testing the connection', async path => {
                const out = await call('connect-database', { path });
                expect(out.success).toBe(false);
                expect(out.error.type).toBe('INVALID_DATABASE_PATH');
                expect(db.testConnection).not.toHaveBeenCalled();
                expect(registry.aliases()).toEqual(['default']);
            });

        test('connecting an already connected path returns the existing alias without opening another pool', async () => {
            await call('connect-database', { path: 'D:\\clientes\\erp.fdb' });
            const again = await call('connect-database', { path: 'd:/clientes/erp.fdb' });
            expect(again.result).toEqual({ alias: 'erp', path: 'D:\\clientes\\erp.fdb', alreadyConnected: true });
            expect(db.testConnection).toHaveBeenCalledTimes(1);
        });

        test('an alias already used by another path is an error and the registry does not change', async () => {
            await call('connect-database', { path: '/dados/erp.fdb', alias: 'x' });
            const out = await call('connect-database', { path: '/dados/outro.fdb', alias: 'x' });
            expect(out.error.type).toBe('DATABASE_ALIAS_IN_USE');
            expect(registry.list().map(entry => entry.path)).toEqual(['D:\\dados\\padrao.fdb', '/dados/erp.fdb']);
        });

        test('the reserved alias "default" is an error', async () => {
            const out = await call('connect-database', { path: '/dados/erp.fdb', alias: 'default' });
            expect(out.error.type).toBe('DATABASE_ALIAS_RESERVED');
        });

        test.each([
            { path: '/dados/x.fdb', password: 'x' },
            { path: '/dados/x.fdb', host: 'other' },
            { path: '/dados/x.fdb', port: 3050 },
            { path: '/dados/x.fdb', user: 'SYSDBA' },
            { path: '/dados/x.fdb', role: 'R' }
        ])('the input schema refuses extra fields: %j', args => {
            expect(ConnectDatabaseArgsSchema.safeParse(args).success).toBe(false);
        });

        test('the input schema requires a path and accepts an optional alias', () => {
            expect(ConnectDatabaseArgsSchema.safeParse({}).success).toBe(false);
            expect(ConnectDatabaseArgsSchema.safeParse({ path: '/x.fdb', alias: 'x' }).success).toBe(true);
        });
    });

    describe('list-databases', () => {
        test('lists the default database and the connected ones with alias and path', async () => {
            await call('connect-database', { path: '/dados/erp.fdb' });
            expect(await call('list-databases', {})).toEqual({
                success: true,
                result: { databases: [
                    { alias: 'default', path: 'D:\\dados\\padrao.fdb' },
                    { alias: 'erp', path: '/dados/erp.fdb' }
                ] }
            });
        });

        test('the output has no user, password or role', async () => {
            await call('connect-database', { path: '/dados/erp.fdb' });
            const response = await tools.get('list-databases')!.handler({});
            const text = JSON.stringify(response);
            for (const secret of ['APP_USER', 'S3CRET-PASSWORD', 'APP_ROLE', 'srv-fb', '3051']) expect(text).not.toContain(secret);
        });

        test('takes no arguments', () => {
            expect(ListDatabasesArgsSchema.safeParse({ database: 'x' }).success).toBe(false);
        });
    });

    describe('disconnect-database', () => {
        test('closes the pool of the alias and removes it', async () => {
            await call('connect-database', { path: '/dados/erp.fdb' });
            const out = await call('disconnect-database', { alias: 'erp' });
            expect(out).toEqual({ success: true, result: { alias: 'erp', path: '/dados/erp.fdb' } });
            expect(db.closeDatabasePool).toHaveBeenCalledWith({ ...defaultConfig, database: '/dados/erp.fdb' });
            expect(registry.aliases()).toEqual(['default']);
        });

        test('later calls with the disconnected alias return an unknown alias error', async () => {
            await call('connect-database', { path: '/dados/erp.fdb' });
            await call('disconnect-database', { alias: 'erp' });
            const response = await setupDatabaseTools(registry).get('execute-query')!.handler({ sql: 'SELECT 1 FROM T', database: 'erp' });
            expect(response.isError).toBe(true);
            expect(response.structuredContent.error).toMatchObject({ type: 'UNKNOWN_DATABASE_ALIAS' });
            expect(db.executeQuery).not.toHaveBeenCalled();
        });

        test('refuses the default database, which keeps working', async () => {
            const out = await call('disconnect-database', { alias: 'default' });
            expect(out.success).toBe(false);
            expect(out.error.type).toBe('DATABASE_ALIAS_RESERVED');
            expect(db.closeDatabasePool).not.toHaveBeenCalled();
            expect(registry.aliases()).toEqual(['default']);
        });

        test('an unknown alias is an error', async () => {
            const out = await call('disconnect-database', { alias: 'x' });
            expect(out.error.type).toBe('UNKNOWN_DATABASE_ALIAS');
        });

        test('requires an alias and refuses extra fields', () => {
            expect(DisconnectDatabaseArgsSchema.safeParse({}).success).toBe(false);
            expect(DisconnectDatabaseArgsSchema.safeParse({ alias: 'x', force: true }).success).toBe(false);
        });
    });

    test('annotations: only list-databases is read-only, and none is destructive', () => {
        expect(tools.get('list-databases')!.annotations.readOnlyHint).toBe(true);
        expect(tools.get('connect-database')!.annotations.readOnlyHint).toBe(false);
        expect(tools.get('disconnect-database')!.annotations.readOnlyHint).toBe(false);
        for (const tool of tools.values()) expect(tool.annotations.destructiveHint).toBe(false);
    });
});
