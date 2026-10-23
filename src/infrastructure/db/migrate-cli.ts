import { loadConfig } from '../../config/env.js';
import { createLogger } from '../../shared/logger.js';
import { SqliteDatabase } from './database.js';
import { migrate } from './migrator.js';

const config = loadConfig();
const logger = createLogger(config.log);
const db = new SqliteDatabase(config.db.path);
try {
  const applied = migrate(db, logger);
  logger.info({ applied, path: config.db.path }, 'migrations complete');
} finally {
  db.close();
}
