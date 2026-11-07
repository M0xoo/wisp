// The hub's crypto, from node:crypto (the kit is pure and takes it as functions).

import { createHash, createHmac, randomBytes, randomInt } from 'node:crypto';
import type { HubCrypto } from '@wisp-plugin/channels-api/kit';

export const nodeCrypto: HubCrypto = {
  hmac: (key, data) => createHmac('sha256', key).update(data).digest('base64url'),
  sha256: (s) => createHash('sha256').update(s).digest('hex'),
  randomInt: (min, max) => randomInt(min, max),
  randomHex: (n) => randomBytes(n).toString('hex'),
};
