/**
 * Database paths given by the user.
 *
 * Firebird may run on another operating system than the MCP server, so the path style
 * (Windows or Unix) comes from the text itself, not from `process.platform`.
 */

import * as path from 'path';

export type DatabasePathStyle = 'windows' | 'unix';

const WINDOWS_ABSOLUTE = /^[A-Za-z]:[\\/]/;

/** Style of an absolute path, or `null` if the text does not start like an absolute path. */
export function detectPathStyle(value: string): DatabasePathStyle | null {
    if (WINDOWS_ABSOLUTE.test(value)) return 'windows';
    if (value.startsWith('/')) return 'unix';
    return null;
}

/** Reason the path is refused, or `null` if it is an absolute file path. */
export function databasePathProblem(value: string): string | null {
    if (value.trim() === '') return 'the path is empty';
    if (value !== value.trim()) return 'the path cannot start or end with a space';
    if (value.includes('://')) return 'protocols such as inet:// are not accepted';
    if (value.startsWith('\\\\') || value.startsWith('//')) return 'UNC paths are not accepted';
    const style = detectPathStyle(value);
    if (style === null) {
        return /^[^\\/:]+:/.test(value)
            ? 'host prefixes are not accepted; give only the file path on the configured server'
            : 'give an absolute path (such as D:\\data\\app.fdb or /data/app.fdb); relative paths and databases.conf aliases are not accepted';
    }
    if (style === 'windows' && value.indexOf(':', 2) !== -1) return 'the path contains ":" after the drive letter';
    if (style === 'unix' && value.includes(':')) return 'the path contains ":"; host prefixes are not accepted';
    return null;
}

/**
 * Display form: separators and `..` resolved for the style, drive letter in uppercase.
 * A value that is not an absolute path is returned unchanged.
 */
export function normalizeDatabasePathForStyle(value: string): string {
    const style = detectPathStyle(value);
    if (style === 'windows') {
        const normalized = path.win32.normalize(value);
        return normalized.charAt(0).toUpperCase() + normalized.slice(1);
    }
    if (style === 'unix') return path.posix.normalize(value);
    return value;
}

/**
 * Comparison key between paths. Windows paths ignore letter case; Unix paths keep it.
 */
export function databasePathKey(value: string | undefined): string {
    if (!value) return '';
    const normalized = normalizeDatabasePathForStyle(value);
    return detectPathStyle(normalized) === 'windows' ? normalized.toLowerCase() : normalized;
}
