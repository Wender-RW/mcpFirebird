jest.mock('../../db/queries.js', () => ({ executeAuditQuery: jest.fn() }));

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeAuditQuery } from '../../db/queries.js';
import { auditMigrationSql, createAuditTable, logAudit, logQueryExecution } from '../../security/audit.js';
import { DEFAULT_SECURITY_CONFIG, securityConfig } from '../../security/config.js';

const executeAudit = jest.mocked(executeAuditQuery);

function setAudit(audit: Record<string, unknown>) {
    for (const key of Object.keys(securityConfig)) delete (securityConfig as any)[key];
    Object.assign(securityConfig, structuredClone(DEFAULT_SECURITY_CONFIG), { audit: { ...DEFAULT_SECURITY_CONFIG.audit, enabled: true, ...audit } });
}

describe('audit entries identify the database', () => {
    let dir: string;
    beforeEach(() => {
        jest.resetAllMocks();
        dir = mkdtempSync(join(tmpdir(), 'mcp-audit-'));
    });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it('writes database and databasePath to the audit file for a query on a connected alias', async () => {
        const auditFile = join(dir, 'audit.log');
        setAudit({ destination: 'file', auditFile });
        await logQueryExecution('SELECT 1 FROM T', [], '', '', true, '', 5, 1, undefined, { alias: 'erp', path: 'D:\\clients\\erp.fdb' });
        const line = JSON.parse(readFileSync(auditFile, 'utf8').trim());
        expect(line).toMatchObject({ database: 'erp', databasePath: 'D:\\clients\\erp.fdb', operationType: 'SELECT' });
    });

    it('omits both fields when the caller gives no database', async () => {
        const auditFile = join(dir, 'audit.log');
        setAudit({ destination: 'file', auditFile });
        await logQueryExecution('SELECT 1 FROM T');
        const line = JSON.parse(readFileSync(auditFile, 'utf8').trim());
        expect(line).not.toHaveProperty('database');
        expect(line).not.toHaveProperty('databasePath');
    });

    it('inserts DATABASE_ALIAS and DATABASE_PATH into the audit table, sending the insert without a config', async () => {
        setAudit({ destination: 'database', auditTable: 'MCP_AUDIT_LOG' });
        executeAudit.mockResolvedValue([]);
        await logAudit({
            timestamp: new Date().toISOString(), clientInfo: 'c', operationType: 'SELECT', targetObject: '',
            success: true, database: 'erp', databasePath: '/dados/erp.fdb'
        });
        expect(executeAudit).toHaveBeenCalledTimes(1);
        const [sql, params, config] = executeAudit.mock.calls[0];
        expect(sql).toMatch(/DATABASE_ALIAS, DATABASE_PATH\)/);
        expect((sql.match(/\?/g) || []).length).toBe(params.length);
        expect(params.slice(-2)).toEqual(['erp', '/dados/erp.fdb']);
        expect(config).toBeUndefined();
    });

    it('fits the alias and the path in their columns', async () => {
        setAudit({ destination: 'database', auditTable: 'MCP_AUDIT_LOG' });
        executeAudit.mockResolvedValue([]);
        await logAudit({
            timestamp: new Date().toISOString(), clientInfo: 'c', operationType: 'SELECT', targetObject: '',
            success: true, database: 'a'.repeat(100), databasePath: '/' + 'p'.repeat(400)
        });
        const params = executeAudit.mock.calls[0][1] as string[];
        expect(params.at(-2)).toHaveLength(63);
        expect(params.at(-1)).toHaveLength(255);
    });

    it('stores null when the entry has no database', async () => {
        setAudit({ destination: 'database', auditTable: 'MCP_AUDIT_LOG' });
        executeAudit.mockResolvedValue([]);
        await logAudit({ timestamp: new Date().toISOString(), clientInfo: 'c', operationType: 'SELECT', targetObject: '', success: true });
        expect((executeAudit.mock.calls[0][1] as unknown[]).slice(-2)).toEqual([null, null]);
    });
});

describe('createAuditTable', () => {
    beforeEach(() => {
        jest.resetAllMocks();
        setAudit({ destination: 'database', auditTable: 'MCP_AUDIT_LOG' });
    });

    it('creates a new table with the database columns', async () => {
        executeAudit.mockResolvedValueOnce([]).mockResolvedValue([]);
        await createAuditTable();
        const create = executeAudit.mock.calls.find(([sql]) => sql.startsWith('CREATE TABLE'))![0];
        expect(create).toContain('DATABASE_ALIAS VARCHAR(63)');
        expect(create).toContain('DATABASE_PATH VARCHAR(255)');
    });

    it('accepts a table that already has the columns', async () => {
        executeAudit.mockResolvedValue([{ ONE: 1 }]);
        await expect(createAuditTable()).resolves.toBeUndefined();
    });

    it('refuses an old table with an error that contains the migration statement', async () => {
        executeAudit.mockImplementation(async sql => {
            if (sql.includes('DATABASE_ALIAS')) throw new Error('Column unknown DATABASE_ALIAS');
            return [{ ONE: 1 }];
        });
        const failure = await createAuditTable().then(() => undefined, error => error as Error);
        expect(failure).toBeDefined();
        expect(failure!.message).toContain(auditMigrationSql('"MCP_AUDIT_LOG"'));
        expect(failure!.message).toContain('ALTER TABLE "MCP_AUDIT_LOG" ADD DATABASE_ALIAS VARCHAR(63), ADD DATABASE_PATH VARCHAR(255);');
    });

    it('does not mistake a table without the older columns for a table that only lacks the database columns', async () => {
        executeAudit.mockImplementation(async sql => {
            if (sql.includes('PHASE')) throw new Error('Column unknown PHASE');
            return [{ ONE: 1 }];
        });
        await expect(createAuditTable()).rejects.toThrow('Column unknown PHASE');
    });

    it('lists the migration statement in the CHANGELOG exactly as the error message prints it', () => {
        const changelog = readFileSync(join(__dirname, '../../../CHANGELOG.md'), 'utf8');
        expect(changelog).toContain(auditMigrationSql('<audit table>'));
    });
});
