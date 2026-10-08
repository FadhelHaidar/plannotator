#!/usr/bin/env node
// The Git-source manifest must stay npm-safe; Bun needs workspaces to build
// the local UI. Do not run another installer while this bootstrap is active.
import { spawnSync } from 'node:child_process';
import { closeSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const manifestPath = join(root, 'package.json');
const lockPath = join(root, '.pi-source-install.lock');
const dependenciesOnly = process.argv.includes('--dependencies-only');

function run(program, args, env = process.env) {
  const result = spawnSync(program, args, { cwd: root, env, stdio: 'inherit' });
  if (result.error || result.status !== 0) {
    throw new Error(`${program} ${args.join(' ')} failed (${result.error?.message ?? result.signal ?? `exit ${result.status}`}).`);
  }
}

try {
  for (const program of ['bun', 'bash']) {
    const probe = spawnSync(program, ['--version'], { stdio: 'ignore' });
    if (probe.error || probe.status !== 0) {
      throw new Error(`Git-source builds require ${program} on PATH. Install Bun (https://bun.sh) and bash, then rerun npm run postinstall.`);
    }
  }

  let lock;
  try {
    lock = openSync(lockPath, 'wx');
  } catch (error) {
    if (error.code === 'EEXIST') {
      throw new Error(`Another source bootstrap is active, or a previous one was interrupted (${lockPath}). See apps/pi-extension/README.md for recovery.`);
    }
    throw error;
  }

  try {
    const original = readFileSync(manifestPath, 'utf8');
    try {
      const manifest = JSON.parse(original);
      manifest.workspaces = ['apps/*', 'packages/*'];
      // Disable only this bootstrap; trusted native dependencies still need their install scripts.
      delete manifest.scripts.postinstall;
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      // Pi invokes npm with --omit=dev. Those production settings must not leak
      // into the build install, and lifecycle scripts must not recurse here.
      const env = { ...process.env, NODE_ENV: 'development' };
      for (const key of Object.keys(env)) {
        if (/^npm_config_(production|omit|only)$/i.test(key)) delete env[key];
      }
      console.log('[plannotator] Installing local Bun workspace build dependencies…');
      run('bun', ['install', '--no-save'], env);
    } finally {
      writeFileSync(manifestPath, original);
    }

    if (!dependenciesOnly) {
      console.log('[plannotator] Building Pi HTML, generated modules and bundled skill…');
      run('bun', ['run', 'build:pi']);
    }
  } finally {
    closeSync(lock);
    unlinkSync(lockPath);
  }
} catch (error) {
  console.error(`[plannotator] Source bootstrap failed: ${error.message}`);
  process.exitCode = 1;
}
