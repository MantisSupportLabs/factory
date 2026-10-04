import { Buffer } from 'buffer';
export const files = new Map();
export default {
  mkdirSync() {},
  existsSync(path) { return files.has(path); },
  writeFileSync(path, data, options) {
    if (options?.flag === 'wx' && files.has(path)) throw new Error('File exists');
    files.set(path, new Uint8Array(data));
  },
  readFileSync(path) {
    if (!files.has(path)) throw new Error('Demo attachment not found');
    return Buffer.from(files.get(path));
  },
  unlinkSync(path) { files.delete(path); },
};
