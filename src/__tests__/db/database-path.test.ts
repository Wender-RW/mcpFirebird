import {
    databasePathKey,
    databasePathProblem,
    detectPathStyle,
    normalizeDatabasePathForStyle
} from '../../db/database-path.js';

describe('databasePathProblem', () => {
    test.each([
        ['Windows with backslashes', 'D:\\clients\\c42\\erp.fdb'],
        ['Windows with forward slashes', 'd:/clients/c42/erp.fdb'],
        ['Windows with a space in the name', 'D:\\clients\\Client 42.FDB'],
        ['Unix', '/data/clients/erp.fdb'],
        ['Unix with a space in the name', '/data/my clients/erp.fdb']
    ])('accepts %s', (_name, value) => {
        expect(databasePathProblem(value)).toBeNull();
    });

    test.each([
        ['host prefix with a Windows drive', 'srv2:D:\\clients\\x.fdb'],
        ['host prefix with a Unix path', 'srv2:/data/x.fdb'],
        ['host prefix with a port', 'srv2/3050:/data/x.fdb'],
        ['UNC with backslashes', '\\\\srv\\share\\x.fdb'],
        ['UNC with forward slashes', '//srv/share/x.fdb'],
        ['inet protocol', 'inet://srv/x.fdb'],
        ['xnet protocol', 'xnet://x.fdb'],
        ['wnet protocol', 'wnet://srv/x.fdb'],
        ['protocol inside a Unix path', '/data/inet://srv/x.fdb'],
        ['databases.conf alias', 'employee'],
        ['relative path with backslash', 'data\\x.fdb'],
        ['relative path with forward slash', 'data/x.fdb'],
        ['explicit relative path', './x.fdb'],
        ['drive without separator', 'D:x.fdb'],
        ['colon after the drive', 'D:\\data\\x:y.fdb'],
        ['colon in a Unix path', '/data/x:y.fdb'],
        ['empty', ''],
        ['only spaces', '   '],
        ['leading space', ' /data/x.fdb'],
        ['trailing space', '/data/x.fdb ']
    ])('refuses %s', (_name, value) => {
        expect(databasePathProblem(value)).toEqual(expect.any(String));
    });

    test('the message for a host prefix says what to give instead', () => {
        expect(databasePathProblem('srv2:/data/x.fdb')).toMatch(/host prefixes are not accepted/);
    });
});

describe('normalization by style', () => {
    test('a Windows path uses Windows separators and an uppercase drive letter', () => {
        expect(normalizeDatabasePathForStyle('d:/clients/c42/../erp.fdb')).toBe('D:\\clients\\erp.fdb');
    });

    test('a Unix path uses Unix separators, whatever the system of the MCP server', () => {
        expect(normalizeDatabasePathForStyle('/data//clients/./erp.fdb')).toBe('/data/clients/erp.fdb');
    });

    test('a value that is not an absolute path is returned unchanged', () => {
        expect(normalizeDatabasePathForStyle('employee')).toBe('employee');
    });

    test('detects the style from the text', () => {
        expect(detectPathStyle('C:\\x.fdb')).toBe('windows');
        expect(detectPathStyle('c:/x.fdb')).toBe('windows');
        expect(detectPathStyle('/x.fdb')).toBe('unix');
        expect(detectPathStyle('x.fdb')).toBeNull();
    });
});

describe('databasePathKey', () => {
    test('different spellings of the same Windows path give the same key', () => {
        expect(databasePathKey('d:/clients/ERP.fdb')).toBe(databasePathKey('D:\\clients\\erp.fdb'));
    });

    test('Unix paths that differ only in letter case give different keys', () => {
        expect(databasePathKey('/data/ERP.fdb')).not.toBe(databasePathKey('/data/erp.fdb'));
    });

    test('a missing path gives an empty key', () => {
        expect(databasePathKey(undefined)).toBe('');
    });
});
