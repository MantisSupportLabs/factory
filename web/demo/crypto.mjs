import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
export const randomUUID = () => crypto.randomUUID();
export function createHash(algorithm) {
  if (algorithm !== 'sha256') throw new Error('Unsupported demo digest');
  const parts = [];
  return {
    update(value) { parts.push(typeof value === 'string' ? new TextEncoder().encode(value) : new Uint8Array(value)); return this; },
    digest(encoding) {
      const input = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
      let offset = 0; for (const part of parts) { input.set(part, offset); offset += part.length; }
      const result = sha256(input);
      return encoding === 'hex' ? bytesToHex(result) : result;
    },
  };
}
