import { appendFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { securityConfig } from './config.js';
import { currentSecurityContext } from './context.js';
import { executeAuditQuery } from '../db/queries.js';
import { quoteIdentifier } from '../utils/security.js';
import { FirebirdError } from '../utils/errors.js';

export interface AuditLogEntry {
    timestamp: string; clientInfo: string; operationType: string; targetObject: string;
    queryText?: string; parameters?: string; affectedRows?: number; executionTime?: number;
    userIdentifier?: string; success: boolean; errorMessage?: string; response?: unknown; phase?: 'started' | 'completed';
    /** Alias and path of the database the audited operation ran on. */
    database?: string; databasePath?: string;
}

/** Statement that adds the database columns to an audit table created before they existed. */
export const auditMigrationSql = (quotedTable: string): string =>
    `ALTER TABLE ${quotedTable} ADD DATABASE_ALIAS VARCHAR(63), ADD DATABASE_PATH VARCHAR(255);`;
export async function logAudit(entry: AuditLogEntry): Promise<void> {
    const audit = securityConfig.audit;
    if (!audit?.enabled) return;
    if (audit.destination !== 'database') {
        if (!audit.auditFile) throw new Error('Audit file not configured');
        await appendFile(audit.auditFile, JSON.stringify(entry) + '\n', 'utf8');
    }
    if (audit.destination !== 'file') {
        if (!audit.auditTable) throw new Error('Audit table not configured');
        await executeAuditQuery(`INSERT INTO ${quoteIdentifier(audit.auditTable)}
            (LOG_ID, "TIMESTAMP", CLIENT_INFO, OPERATION_TYPE, TARGET_OBJECT, QUERY_TEXT, PARAMETERS,
             AFFECTED_ROWS, EXECUTION_TIME, USER_IDENTIFIER, SUCCESS, ERROR_MESSAGE, RESPONSE_TEXT, PHASE,
             DATABASE_ALIAS, DATABASE_PATH)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [randomUUID(), new Date(entry.timestamp), entry.clientInfo, entry.operationType, entry.targetObject,
            entry.queryText || null, entry.parameters || null, entry.affectedRows || 0, entry.executionTime || 0,
            entry.userIdentifier || '', entry.success ? 1 : 0, entry.errorMessage || null,
            entry.response === undefined ? null : JSON.stringify(entry.response), entry.phase || 'completed',
            entry.database?.slice(0, 63) || null, entry.databasePath?.slice(0, 255) || null]);
    }
}
export async function createAuditTable(): Promise<void> {
    const audit = securityConfig.audit;
    if (!audit?.enabled || audit.destination === 'file') return;
    if (!audit.auditTable) throw new Error('Audit table not configured');
    const table = quoteIdentifier(audit.auditTable);
    const result = await executeAuditQuery('SELECT 1 FROM RDB$RELATIONS WHERE RDB$RELATION_NAME = ?', [audit.auditTable]);
    if (!result.length) await executeAuditQuery(`CREATE TABLE ${table} (
        LOG_ID VARCHAR(36) NOT NULL PRIMARY KEY, "TIMESTAMP" TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        CLIENT_INFO VARCHAR(255), OPERATION_TYPE VARCHAR(50), TARGET_OBJECT VARCHAR(100),
        QUERY_TEXT BLOB SUB_TYPE TEXT, PARAMETERS BLOB SUB_TYPE TEXT, AFFECTED_ROWS INTEGER,
        EXECUTION_TIME INTEGER, USER_IDENTIFIER VARCHAR(100), SUCCESS SMALLINT,
        ERROR_MESSAGE BLOB SUB_TYPE TEXT, RESPONSE_TEXT BLOB SUB_TYPE TEXT, PHASE VARCHAR(12),
        DATABASE_ALIAS VARCHAR(63), DATABASE_PATH VARCHAR(255))`);
    // Do not silently accept an incompatible legacy audit table.
    await executeAuditQuery(`SELECT FIRST 0 LOG_ID, RESPONSE_TEXT, PHASE FROM ${table}`);
    try {
        await executeAuditQuery(`SELECT FIRST 0 DATABASE_ALIAS, DATABASE_PATH FROM ${table}`);
    } catch (error) {
        throw new FirebirdError(`Audit table ${audit.auditTable} has no DATABASE_ALIAS and DATABASE_PATH columns. ` +
            `Run this statement on the audit database and restart the server: ${auditMigrationSql(table)}`,
        'AUDIT_TABLE_OUTDATED', error);
    }
}
export async function logQueryExecution(sql: string, params: any[] = [], clientInfo = '', userIdentifier = '',
    success = true, errorMessage = '', executionTime = 0, affectedRows = 0, response?: unknown,
    target?: { alias: string; path: string }): Promise<void> {
    const audit = securityConfig.audit;
    if (!audit?.enabled) return;
    const context = currentSecurityContext();
    await logAudit({
        timestamp: new Date().toISOString(), clientInfo: clientInfo || context.sessionId,
        operationType: sql.trim().match(/^[a-z]+/i)?.[0].toUpperCase() || 'UNKNOWN', targetObject: '',
        phase: response === undefined && success ? 'started' : 'completed',
        userIdentifier: userIdentifier || context.user?.id, success, executionTime, affectedRows,
        queryText: audit.logQueries && audit.detailLevel !== 'basic' ? sql : undefined,
        parameters: audit.logParameters && audit.detailLevel === 'full' ? JSON.stringify(params) : undefined,
        errorMessage: success ? undefined : errorMessage,
        response: audit.logResponses && audit.detailLevel === 'full' ? response : undefined,
        database: target?.alias, databasePath: target?.path
    });
}
