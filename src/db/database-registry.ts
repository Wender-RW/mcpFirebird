/**
 * Registry of the databases connected during the conversation.
 *
 * Each MCP server instance has its own. The alias `default` is reserved and points to the
 * database configured at startup; the other aliases come from `connect-database`.
 */

import * as path from 'path';
import { FirebirdError } from '../utils/errors.js';
import type { ConfigOptions } from './connection.js';
import {
    databasePathKey,
    databasePathProblem,
    detectPathStyle,
    normalizeDatabasePathForStyle
} from './database-path.js';

export const DEFAULT_DATABASE_ALIAS = 'default';

const ALIAS_PATTERN = /^[a-z0-9_-]{1,63}$/;
const MAX_ALIAS_LENGTH = 63;

export interface RegisteredDatabase {
    alias: string;
    path: string;
    config: ConfigOptions;
}

/** An accepted database that is not registered yet: the alias only holds after `commit`. */
export interface DatabaseCandidate extends RegisteredDatabase {
    aliasInformed: boolean;
}

/** Alias under which each config was registered, so the audit can name the database. */
const aliasByConfig = new WeakMap<ConfigOptions, string>();

/** Alias of the database of a config; a config that did not come from the registry is the default database. */
export function getConfigAlias(config: ConfigOptions | undefined): string {
    return (config && aliasByConfig.get(config)) || DEFAULT_DATABASE_ALIAS;
}

export class DatabaseRegistry {
    private readonly entries = new Map<string, RegisteredDatabase>();

    /** `getDefault` returns the config of the default database, which also supplies the server and the credentials. */
    constructor(private readonly getDefault: () => ConfigOptions) {}

    /** Validates the path and chooses the alias, without registering anything. */
    prepare(databasePath: string, alias?: string): DatabaseCandidate | { existing: RegisteredDatabase } {
        const problem = databasePathProblem(databasePath);
        if (problem) {
            throw new FirebirdError(`Invalid database path "${databasePath}": ${problem}`, 'INVALID_DATABASE_PATH');
        }
        const normalized = normalizeDatabasePathForStyle(databasePath);
        const existing = this.findByPath(normalized);
        if (existing) return { existing };

        if (alias !== undefined) this.assertAliasAvailable(alias);
        const chosen = alias ?? this.generateAlias(normalized);
        const config: ConfigOptions = { ...this.getDefault(), database: normalized };
        return { alias: chosen, path: normalized, config, aliasInformed: alias !== undefined };
    }

    /**
     * Registers the candidate. If another call registered the same path while this one tested the
     * connection, returns that registration. A generated alias taken in the meantime is generated again.
     */
    commit(candidate: DatabaseCandidate): RegisteredDatabase {
        const existing = this.findByPath(candidate.path);
        if (existing) return existing;
        let alias = candidate.alias;
        if (this.isTaken(alias)) {
            if (candidate.aliasInformed) this.assertAliasAvailable(alias);
            alias = this.generateAlias(candidate.path);
        }
        const entry: RegisteredDatabase = { alias, path: candidate.path, config: candidate.config };
        aliasByConfig.set(entry.config, alias);
        this.entries.set(alias, entry);
        return entry;
    }

    /**
     * Config of the database of the alias. Without an alias, or with `default`, returns `undefined`:
     * the query functions use the configured database when they receive no config.
     */
    resolve(alias?: string): ConfigOptions | undefined {
        if (alias === undefined || alias === DEFAULT_DATABASE_ALIAS) return undefined;
        const entry = this.entries.get(alias);
        if (!entry) throw this.unknownAlias(alias);
        return entry.config;
    }

    /** Alias and path of the database that `resolve` picks for the alias. */
    describe(alias?: string): { alias: string; path: string } {
        const config = this.resolve(alias);
        return config
            ? { alias: alias as string, path: config.database }
            : { alias: DEFAULT_DATABASE_ALIAS, path: this.getDefault().database };
    }

    /** The default database first, then the connected ones in registration order. */
    list(): Array<{ alias: string; path: string }> {
        return [
            { alias: DEFAULT_DATABASE_ALIAS, path: this.getDefault().database },
            ...[...this.entries.values()].map(({ alias, path: databasePath }) => ({ alias, path: databasePath }))
        ];
    }

    aliases(): string[] {
        return [DEFAULT_DATABASE_ALIAS, ...this.entries.keys()];
    }

    /** Removes the alias and returns what was registered; the caller closes the pool. */
    remove(alias: string): RegisteredDatabase {
        if (alias === DEFAULT_DATABASE_ALIAS) {
            throw new FirebirdError('The "default" database cannot be disconnected', 'DATABASE_ALIAS_RESERVED');
        }
        const entry = this.entries.get(alias);
        if (!entry) throw this.unknownAlias(alias);
        this.entries.delete(alias);
        return entry;
    }

    private unknownAlias(alias: string): FirebirdError {
        return new FirebirdError(
            `Unknown database alias "${alias}". Valid aliases: ${this.aliases().join(', ')}`,
            'UNKNOWN_DATABASE_ALIAS'
        );
    }

    /** The database already registered for the path, including the default database. */
    private findByPath(normalized: string): RegisteredDatabase | undefined {
        const key = databasePathKey(normalized);
        const defaultConfig = this.getDefault();
        if (databasePathKey(defaultConfig.database) === key) {
            return { alias: DEFAULT_DATABASE_ALIAS, path: defaultConfig.database, config: defaultConfig };
        }
        for (const entry of this.entries.values()) {
            if (databasePathKey(entry.path) === key) return entry;
        }
        return undefined;
    }

    private isTaken(alias: string): boolean {
        return alias === DEFAULT_DATABASE_ALIAS || this.entries.has(alias);
    }

    private assertAliasAvailable(alias: string): void {
        if (alias === DEFAULT_DATABASE_ALIAS) {
            throw new FirebirdError('The alias "default" is reserved for the configured database', 'DATABASE_ALIAS_RESERVED');
        }
        if (!ALIAS_PATTERN.test(alias)) {
            throw new FirebirdError(
                `Invalid database alias "${alias}": use 1 to ${MAX_ALIAS_LENGTH} lowercase letters, digits, "_" or "-"`,
                'INVALID_DATABASE_ALIAS'
            );
        }
        if (this.entries.has(alias)) {
            throw new FirebirdError(
                `The alias "${alias}" is already used for ${this.entries.get(alias)!.path}`,
                'DATABASE_ALIAS_IN_USE'
            );
        }
    }

    private generateAlias(normalizedPath: string): string {
        const file = detectPathStyle(normalizedPath) === 'windows'
            ? path.win32.basename(normalizedPath)
            : path.posix.basename(normalizedPath);
        const stem = file.includes('.') ? file.slice(0, file.lastIndexOf('.')) : file;
        const base = (stem.toLowerCase().replace(/[^a-z0-9_-]/g, '_') || 'db').slice(0, MAX_ALIAS_LENGTH - 4);
        if (!this.isTaken(base)) return base;
        for (let n = 2; ; n++) {
            const candidate = `${base}-${n}`;
            if (!this.isTaken(candidate)) return candidate;
        }
    }
}
