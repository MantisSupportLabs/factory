import { build } from 'esbuild';
import { copyFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
const seed = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/seed-browser-demo.mjs'], { stdio: 'inherit' });
if (seed.status !== 0) process.exit(seed.status ?? 1);
const root = process.cwd();
const aliases = {
  express: 'web/demo/router.mjs', 'node:crypto': 'web/demo/crypto.mjs',
  'node:fs': 'web/demo/files.mjs', 'node:path': 'web/demo/path.mjs',
};
await build({
  entryPoints: ['web/demo/engine.mjs'], outfile: 'web/public/demo/engine.js',
  bundle: true, format: 'esm', platform: 'browser', target: 'es2022', minify: true,
  inject: ['web/demo/buffer.mjs'],
  plugins: [{ name: 'browser-demo-adapters', setup(builder) {
    builder.onResolve({ filter: /.*/ }, args => {
      if (aliases[args.path]) return { path: path.join(root, aliases[args.path]) };
      if (args.importer.includes('/server/') && /(?:^|\/)db\/database\.js$/.test(args.path))
        return { path: path.join(root, 'web/demo/database.mjs') };
      if (args.importer.includes('/server/') && /(?:^|\/)config\.js$/.test(args.path))
        return { path: path.join(root, 'web/demo/config.mjs') };
    });
  } }],
});
mkdirSync('web/public/demo', { recursive: true });
copyFileSync('node_modules/sql.js/dist/sql-wasm.wasm', 'web/public/demo/sql-wasm.wasm');
