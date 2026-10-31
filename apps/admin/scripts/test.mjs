/**
 * 极简测试运行器：用仓库已有的 esbuild 把 *.test.ts 打包成 Node 可执行的 ESM，
 * 再交给 Node 内置的 node:test 跑 —— 不新增任何 npm 依赖。
 *
 * - CSS 导入用 'empty' loader 清空
 * - import.meta.env 由 define 注入（Node 下无 Vite）
 * - react/react-dom 标记 external，由 node_modules 解析
 */
import { build } from 'esbuild';
import { rmSync, readdirSync, statSync } from 'node:fs';
import * as nodeFs from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..'); // scripts/ 的上一级 = apps/admin
const outDir = join(root, '.test-out');

rmSync(outDir, { recursive: true, force: true });

// fs.globSync only exists on Node >= 22. CI runners and developer machines
// differ, so fall back to a plain recursive walk: a test runner that only
// works on one Node version is a trap.
function findTests(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...findTests(full));
    else if (entry.name.endsWith('.test.ts')) out.push(full);
  }
  return out;
}
const entries =
  typeof nodeFs.globSync === 'function'
    ? nodeFs.globSync(join(root, 'src', '**', '*.test.ts'))
    : findTests(join(root, 'src'));
if (entries.length === 0) {
  console.error('未找到任何 *.test.ts');
  process.exit(1);
}

await build({
  entryPoints: entries,
  outdir: outDir,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node18',
  sourcemap: 'inline',
  loader: { '.css': 'empty' },
  define: { 'import.meta.env.VITE_API_BASE': 'undefined', 'import.meta.env': '{}' },
  external: ['react', 'react-dom', 'react-dom/server', 'node:*'],
  jsx: 'automatic',
});

/** node --test 传目录在部分版本下把目录当模块执行，这里显式收集 *.js */
function collectTests(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...collectTests(p));
    else if (name.endsWith('.test.js')) out.push(p);
  }
  return out;
}
const files = collectTests(outDir);

const res = spawnSync(process.execPath, ['--test', '--test-reporter=spec', ...files], {
  cwd: root,
  stdio: 'inherit',
});
if (process.env.KEEP_TEST_OUT !== '1') rmSync(outDir, { recursive: true, force: true });
process.exit(res.status ?? 1);
