// Herramientas para conectar bases de datos adicionales durante la conversación
import { z } from 'zod';
import { createLogger } from '../utils/logger.js';
import { testConnection, closeDatabasePool } from '../db/index.js';
import type { DatabaseRegistry } from '../db/database-registry.js';
import {
    finalizeTools, toolResult, toolError,
    type ToolAnnotations, type ToolDraft, type ToolDefinition
} from './contracts.js';
import { connectionResultSchemas } from './outputSchemas.js';

const logger = createLogger('tools:connections');

// Strict: host, port and credentials always come from the server configuration.
export const ConnectDatabaseArgsSchema = z.strictObject({
    path: z.string().min(1).describe('Absolute path of the database file on the Firebird server, such as D:\data\app.fdb or /data/app.fdb'),
    alias: z.string().optional().describe('Name to refer to this database in the `database` argument. Generated from the file name when omitted.')
});

export const ListDatabasesArgsSchema = z.strictObject({});

export const DisconnectDatabaseArgsSchema = z.strictObject({
    alias: z.string().min(1).describe('Alias returned by connect-database')
});

const annotations: Record<string, ToolAnnotations> = {
    'connect-database': { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    'list-databases': { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    'disconnect-database': { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false }
};

/**
 * Tools that add and remove databases in the registry of one server instance.
 * Only the stdio transport registers them.
 */
export const setupConnectionTools = (registry: DatabaseRegistry): Map<string, ToolDefinition> => {
    const tools = new Map<string, ToolDraft>();

    tools.set('connect-database', {
        title: 'Connect Database',
        description: 'Connects another database on the configured Firebird server, using the server\'s host, port and credentials, and returns an alias. Pass the alias as the `database` argument of the other tools. Only an absolute file path is accepted.',
        inputSchema: ConnectDatabaseArgsSchema,
        handler: async (args: z.infer<typeof ConnectDatabaseArgsSchema>) => {
            try {
                const prepared = registry.prepare(args.path, args.alias);
                if ('existing' in prepared) {
                    const { alias, path } = prepared.existing;
                    return toolResult({ alias, path, alreadyConnected: true });
                }
                logger.info(`Connecting database ${prepared.path}`);
                try {
                    await testConnection(prepared.config);
                } catch (error) {
                    await closeDatabasePool(prepared.config).catch(() => undefined);
                    throw error;
                }
                const entry = registry.commit(prepared);
                return toolResult({ alias: entry.alias, path: entry.path, alreadyConnected: entry.config !== prepared.config });
            } catch (error) {
                return toolError(error);
            }
        }
    });

    tools.set('list-databases', {
        title: 'List Databases',
        description: 'Lists the default database and the databases connected with connect-database, with their aliases and paths.',
        inputSchema: ListDatabasesArgsSchema,
        handler: async () => {
            try {
                return toolResult({ databases: registry.list() });
            } catch (error) {
                return toolError(error);
            }
        }
    });

    tools.set('disconnect-database', {
        title: 'Disconnect Database',
        description: 'Closes the connections of a database connected with connect-database and removes its alias. The default database cannot be disconnected.',
        inputSchema: DisconnectDatabaseArgsSchema,
        handler: async (args: z.infer<typeof DisconnectDatabaseArgsSchema>) => {
            try {
                const entry = registry.remove(args.alias);
                await closeDatabasePool(entry.config);
                return toolResult({ alias: entry.alias, path: entry.path });
            } catch (error) {
                return toolError(error);
            }
        }
    });

    return finalizeTools(tools, connectionResultSchemas, new Set(), annotations);
};
