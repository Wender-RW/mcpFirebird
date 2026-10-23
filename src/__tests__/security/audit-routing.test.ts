jest.mock('../../db/connection.js', () => ({
    DEFAULT_CONFIG: {}, getGlobalConfig: jest.fn(), getDefaultConfig: jest.fn(), connectToDatabase: jest.fn(),
    queryDatabase: jest.fn(), getPool: jest.fn(() => ({ release: jest.fn(), destroy: jest.fn() }))
}));

import type { ConfigOptions } from '../../db/connection.js';
import { connectToDatabase, queryDatabase, getDefaultConfig } from '../../db/connection.js';
import { DatabaseRegistry } from '../../db/database-registry.js';
import { executeQuery } from '../../db/queries.js';
import { DEFAULT_SECURITY_CONFIG, securityConfig } from '../../security/config.js';
import { resetQueryCount, resetRateLimit } from '../../security/resourceLimits.js';

const defaultConfig: ConfigOptions = { host: '127.0.0.1', port: 3050, user: 'SYSDBA', password: 'x', database: '/dados/padrao.fdb' };

describe('database audit with a connected database', () => {
    let erp: ConfigOptions;
    // Each statement paired with the config of the attachment that ran it.
    let ran: Array<{ sql: string; params: unknown[]; config: ConfigOptions }>;

    beforeEach(() => {
        jest.clearAllMocks(); resetQueryCount(); resetRateLimit();
        for (const key of Object.keys(securityConfig)) delete (securityConfig as any)[key];
        Object.assign(securityConfig, structuredClone(DEFAULT_SECURITY_CONFIG), {
            audit: { ...DEFAULT_SECURITY_CONFIG.audit, enabled: true, destination: 'database', auditTable: 'MCP_AUDIT_LOG' }
        });
        jest.mocked(getDefaultConfig).mockReturnValue(defaultConfig);
        const registry = new DatabaseRegistry(() => defaultConfig);
        const prepared = registry.prepare('/dados/clientes/erp.fdb');
        if ('existing' in prepared) throw new Error('unexpected');
        erp = registry.commit(prepared).config;
        ran = [];
        jest.mocked(connectToDatabase).mockImplementation(async (config?: ConfigOptions) => ({ config }) as any);
        jest.mocked(queryDatabase).mockImplementation(async (db: any, sql: string, params: unknown[] = []) => {
            ran.push({ sql, params, config: db.config });
            return [{ ID: 1 }];
        });
    });

    it('writes the audit insert to the default database while the audited query runs on the alias', async () => {
        await executeQuery('SELECT ID FROM T', [], erp);

        const inserts = ran.filter(entry => entry.sql.includes('INSERT INTO'));
        const selects = ran.filter(entry => entry.sql.startsWith('SELECT ID FROM T'));
        expect(selects).toHaveLength(1);
        expect(selects[0].config).toBe(erp);
        expect(inserts).toHaveLength(2); // before dispatch and after completion
        for (const insert of inserts) {
            expect(insert.config).toBe(defaultConfig);
            expect(insert.sql).toContain('DATABASE_ALIAS, DATABASE_PATH');
            expect(insert.params.slice(-2)).toEqual(['erp', '/dados/clientes/erp.fdb']);
        }
    });

    it('records the default database for a query without alias', async () => {
        await executeQuery('SELECT ID FROM T');
        const inserts = ran.filter(entry => entry.sql.includes('INSERT INTO'));
        expect(inserts).toHaveLength(2);
        for (const insert of inserts) expect(insert.params.slice(-2)).toEqual(['default', '/dados/padrao.fdb']);
    });
});
