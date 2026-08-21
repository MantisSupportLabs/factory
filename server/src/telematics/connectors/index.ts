/**
 * Connector registration hub. Adding an OEM = add a file in this directory
 * and register it here. Nothing in the core application changes.
 */

import { registerConnector } from '../connector.js';
import { caterpillarConnector } from './caterpillar.js';
import { johnDeereConnector } from './john-deere.js';
import { komatsuConnector } from './komatsu.js';
import { volvoConnector } from './volvo.js';
import { hitachiConnector } from './hitachi.js';
import { develonConnector } from './develon.js';

export function registerAllConnectors(): void {
  registerConnector(caterpillarConnector);
  registerConnector(johnDeereConnector);
  registerConnector(komatsuConnector);
  registerConnector(volvoConnector);
  registerConnector(hitachiConnector);
  registerConnector(develonConnector);
}
