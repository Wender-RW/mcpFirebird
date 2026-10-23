import { installSelectionDriver } from './selection-driver.mjs';
installSelectionDriver({
    defaultDatabase: '/dados/padrao.fdb',
    failFor: database => database.endsWith('/nao-abre.fdb')
});
const { main } = await import('../../dist/server/index.js');
await main();
