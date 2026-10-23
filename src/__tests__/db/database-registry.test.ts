import { DatabaseRegistry, DEFAULT_DATABASE_ALIAS, getConfigAlias, type DatabaseCandidate } from '../../db/database-registry.js';
import type { ConfigOptions } from '../../db/connection.js';

const defaultConfig: ConfigOptions = {
    host: 'srv-fb',
    port: 3051,
    database: 'C:\\data\\main.fdb',
    user: 'APP',
    password: 'secret',
    role: 'READER',
    wireCrypt: 'Required'
};

function connect(registry: DatabaseRegistry, databasePath: string, alias?: string) {
    const prepared = registry.prepare(databasePath, alias);
    if ('existing' in prepared) return prepared.existing;
    return registry.commit(prepared);
}

describe('DatabaseRegistry', () => {
    let registry: DatabaseRegistry;
    beforeEach(() => { registry = new DatabaseRegistry(() => defaultConfig); });

    describe('alias generation and uniqueness', () => {
        test('generates the alias from the file name without extension, in lowercase', () => {
            expect(connect(registry, 'D:\\clients\\c42\\erp.fdb').alias).toBe('erp');
        });

        test('replaces characters outside [a-z0-9_-] with "_"', () => {
            expect(connect(registry, 'D:\\clients\\Client 42.FDB').alias).toBe('client_42');
        });

        test('reads the file name of a Unix path', () => {
            expect(connect(registry, '/data/Sales.2024.fdb').alias).toBe('sales_2024');
        });

        test('appends -2 and -3 when the generated alias exists', () => {
            expect(connect(registry, 'D:\\a\\erp.fdb').alias).toBe('erp');
            expect(connect(registry, 'E:\\other\\erp.fdb').alias).toBe('erp-2');
            expect(connect(registry, '/data/erp.fdb').alias).toBe('erp-3');
        });

        test('the reserved alias "default" counts as used during generation', () => {
            expect(connect(registry, '/data/default.fdb').alias).toBe('default-2');
        });

        test('a file name with nothing usable becomes "db"', () => {
            expect(connect(registry, '/data/.fdb').alias).toBe('db');
        });

        test('uses the informed alias', () => {
            expect(connect(registry, '/data/erp.fdb', 'sales').alias).toBe('sales');
        });

        test('refuses an informed alias already used by another path and leaves the registry unchanged', () => {
            connect(registry, '/data/erp.fdb', 'sales');
            expect(() => registry.prepare('/data/other.fdb', 'sales')).toThrow(/already used/);
            expect(registry.aliases()).toEqual(['default', 'sales']);
        });

        test('refuses the reserved alias "default" and leaves the registry unchanged', () => {
            expect(() => registry.prepare('/data/erp.fdb', 'default')).toThrow(/reserved/);
            expect(registry.aliases()).toEqual(['default']);
        });

        test.each(['ERP', 'my database', '', 'a'.repeat(64), 'x/y'])('refuses the invalid informed alias %p', alias => {
            expect(() => registry.prepare('/data/erp.fdb', alias)).toThrow(/Invalid database alias/);
        });
    });

    describe('reconnecting to the same database', () => {
        test('the same path written another way returns the existing alias', () => {
            const first = connect(registry, 'D:\\clients\\erp.fdb');
            const again = connect(registry, 'd:/clients/erp.fdb');
            expect(again.alias).toBe('erp');
            expect(again).toBe(first);
            expect(registry.aliases()).toEqual(['default', 'erp']);
        });

        test('an alias given on a reconnection does not create another registration', () => {
            connect(registry, '/data/erp.fdb');
            expect(connect(registry, '/data/erp.fdb', 'other').alias).toBe('erp');
            expect(registry.aliases()).toEqual(['default', 'erp']);
        });

        test('the path of the default database returns "default"', () => {
            expect(connect(registry, 'c:/data/MAIN.fdb').alias).toBe(DEFAULT_DATABASE_ALIAS);
            expect(registry.aliases()).toEqual(['default']);
        });

        test('two calls that test the same path at the same time register one alias', () => {
            const a = registry.prepare('/data/erp.fdb') as DatabaseCandidate;
            const b = registry.prepare('/data/erp.fdb') as DatabaseCandidate;
            const first = registry.commit(a);
            expect(registry.commit(b)).toBe(first);
            expect(registry.aliases()).toEqual(['default', 'erp']);
        });

        test('a generated alias taken during the connection test is generated again', () => {
            const a = registry.prepare('D:\\a\\erp.fdb') as DatabaseCandidate;
            const b = registry.prepare('E:\\b\\erp.fdb') as DatabaseCandidate;
            expect(registry.commit(a).alias).toBe('erp');
            expect(registry.commit(b).alias).toBe('erp-2');
        });

        test('an informed alias taken during the connection test is refused', () => {
            const a = registry.prepare('/data/a.fdb', 'x') as DatabaseCandidate;
            const b = registry.prepare('/data/b.fdb', 'x') as DatabaseCandidate;
            registry.commit(a);
            expect(() => registry.commit(b)).toThrow(/already used/);
        });
    });

    describe('path', () => {
        test('refuses an invalid path before any registration', () => {
            expect(() => registry.prepare('srv2:/data/x.fdb')).toThrow(/Invalid database path/);
            expect(() => registry.prepare('employee')).toThrow(/Invalid database path/);
            expect(registry.aliases()).toEqual(['default']);
        });

        test('keeps the normalized path', () => {
            expect(connect(registry, 'd:/clients/c42/../erp.fdb').path).toBe('D:\\clients\\erp.fdb');
        });
    });

    describe('resolving an alias to a config', () => {
        test('without an alias, or with "default", returns no config, so queries use the configured database', () => {
            expect(registry.resolve()).toBeUndefined();
            expect(registry.resolve('default')).toBeUndefined();
        });

        test('describes the alias and path of the chosen database', () => {
            connect(registry, '/data/erp.fdb');
            expect(registry.describe()).toEqual({ alias: 'default', path: 'C:\\data\\main.fdb' });
            expect(registry.describe('erp')).toEqual({ alias: 'erp', path: '/data/erp.fdb' });
            expect(() => registry.describe('x')).toThrow(/Unknown database alias/);
        });

        test('a registered alias returns the config of that database, with the server and credentials of the default one', () => {
            connect(registry, '/data/erp.fdb');
            expect(registry.resolve('erp')).toEqual({ ...defaultConfig, database: '/data/erp.fdb' });
        });

        test('an unknown alias is an error that lists the valid aliases', () => {
            connect(registry, '/data/erp.fdb');
            expect(() => registry.resolve('unknown')).toThrow('Unknown database alias "unknown". Valid aliases: default, erp');
        });

        test('the registered config carries its alias for the audit', () => {
            connect(registry, '/data/erp.fdb');
            expect(getConfigAlias(registry.resolve('erp'))).toBe('erp');
            expect(getConfigAlias(defaultConfig)).toBe('default');
            expect(getConfigAlias(undefined)).toBe('default');
        });
    });

    describe('listing and removal', () => {
        test('lists the default database first, with only alias and path', () => {
            connect(registry, '/data/erp.fdb');
            expect(registry.list()).toEqual([
                { alias: 'default', path: 'C:\\data\\main.fdb' },
                { alias: 'erp', path: '/data/erp.fdb' }
            ]);
        });

        test('removes the alias and returns the registration so the pool can be closed', () => {
            const entry = connect(registry, '/data/erp.fdb');
            expect(registry.remove('erp')).toBe(entry);
            expect(() => registry.resolve('erp')).toThrow(/Unknown database alias/);
        });

        test('removing an unknown alias is an error', () => {
            expect(() => registry.remove('erp')).toThrow(/Unknown database alias/);
        });

        test('does not remove the default database', () => {
            expect(() => registry.remove('default')).toThrow(/cannot be disconnected/);
            expect(registry.resolve('default')).toBeUndefined();
        });

        test('after removal, the generated alias is free again', () => {
            connect(registry, '/data/erp.fdb');
            registry.remove('erp');
            expect(connect(registry, '/other/erp.fdb').alias).toBe('erp');
        });
    });
});
