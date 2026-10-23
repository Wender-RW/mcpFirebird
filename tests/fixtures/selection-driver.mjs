// Driver whose rows say which database the attachment was opened for, so tests can
// tell which database answered. Only the driver boundary is replaced.
import { DriverFactory } from '../../dist/db/driver-factory.js';

export const tagOf = database => database.split(/[\/]/).pop().replace(/\.fdb$/i, '');
const pause = () => new Promise(resolve => setTimeout(resolve, Math.random() * 5));

function rowsFor(sql, database) {
    const text = sql.replace(/\s+/g, ' ').toUpperCase();
    if (text === 'SELECT 1 FROM RDB$DATABASE') return [{ ONE: 1 }];
    if (text.includes('FROM RDB$RELATIONS')) return [{ 'RDB$RELATION_NAME': `T_${tagOf(database)}   ` }];
    if (text.includes('FROM RDB$TRIGGERS')) return [{
        NAME: `TR_${tagOf(database)}`, TABLE_NAME: 'CUSTOMERS', TRIGGER_TYPE: 1, SEQUENCE: 0, INACTIVE: 0, DESCRIPTION: null
    }];
    return [{ DB: database }];
}

export function installSelectionDriver({ defaultDatabase, onAttach = () => {}, onDetach = () => {}, failFor = () => false }) {
    globalThis.MCP_FIREBIRD_CONFIG = { host: '127.0.0.1', port: 3050, database: defaultDatabase, user: 'test', password: 'test' };
    DriverFactory.getDriverInfo = async () => ({ current: 'pure-js', nativeAvailable: false });
    DriverFactory.getDriver = async () => ({
        attach: async config => {
            await pause();
            if (failFor(config.database)) throw new Error(`I/O error during "open" operation for file "${config.database}"`);
            onAttach(config.database);
            return {
                query: async (sql, _params, callback) => {
                    await pause();
                    callback(null, rowsFor(sql, config.database));
                },
                detach: callback => { onDetach(config.database); callback(null); }
            };
        }
    });
}
