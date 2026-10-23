/**
 * Database module index
 *
 * Este módulo exporta todas las funciones de base de datos,
 * utilizando las versiones wrapped que garantizan el uso de la configuración correcta.
 */

// Exportar las versiones wrapped de las funciones de consulta
export * from './wrapped-queries.js';

// Exportar otras funciones y tipos
export {
    DEFAULT_CONFIG,
    getGlobalConfig,
    getDefaultConfig,
    connectToDatabase,
    queryDatabase,
    testConnection,
    closeDatabasePool
} from './connection.js';

export type { ConfigOptions } from './connection.js';

export {
    getViews,
    getProcedures,
    executeBatchQueries,
    describeBatchTables
} from './queries.js';

export type {
    TableInfo,
    FieldInfo,
    ColumnInfo,
    QueryPerformanceResult,
    ExecutionPlanResult
} from './queries.js';

// Exportar funciones de esquema
export * from './schema.js';

// Exportar funciones de metadata (triggers, procedures, functions, packages)
export * from './metadata.js';

// Export table-scoped relational metadata used by tools and resources.
export * from './table-metadata.js';
