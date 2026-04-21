import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { build } from 'esbuild';

const workspaceRoot = process.cwd();
const tempDir = await mkdtemp(path.join(os.tmpdir(), 'weixin-regression-'));
const bundledTestFile = path.join(tempDir, 'weixin-regression.test.mjs');

try {
  await build({
    entryPoints: [path.join(workspaceRoot, 'tests/weixin-regression.test.ts')],
    bundle: true,
    format: 'esm',
    outfile: bundledTestFile,
    platform: 'node',
    sourcemap: 'inline',
    target: ['node20'],
    logLevel: 'silent',
  });

  const result = spawnSync(process.execPath, ['--test', bundledTestFile], {
    cwd: workspaceRoot,
    stdio: 'inherit',
  });

  process.exit(result.status ?? 1);
} finally {
  await rm(tempDir, { force: true, recursive: true });
}
