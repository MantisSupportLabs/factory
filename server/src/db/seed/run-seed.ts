/** Standalone seed runner: `npm run seed -w server`. */
import { getDb } from '../database.js';
import { registerAllConnectors } from '../../telematics/connectors/index.js';
import { seedIfNeeded } from './seed.js';

getDb();
registerAllConnectors();
seedIfNeeded();
console.log('[seed] done');
