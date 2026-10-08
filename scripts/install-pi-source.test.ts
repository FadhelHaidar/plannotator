import { expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const node = spawnSync('node', ['-p', 'process.execPath'], { encoding: 'utf8' }).stdout.trim();

function fixture(run: (root: string, env: NodeJS.ProcessEnv, manifest: string) => void) {
  const root = mkdtempSync(join(tmpdir(), 'plannotator-source-install-test-'));
  try {
    mkdirSync(join(root, 'scripts'));
    mkdirSync(join(root, 'bin'));
    cpSync(join(import.meta.dir, 'install-pi-source.mjs'), join(root, 'scripts/install-pi-source.mjs'));
    const manifest = '{"name":"source-fixture","scripts":{"postinstall":"node scripts/install-pi-source.mjs","build:pi":"existing-sequence"}}\n';
    writeFileSync(join(root, 'package.json'), manifest);
    // Fake tools model the observable install/build boundary, not UI output.
    // The clean-copy smoke uses the real tools to prove the generated assets.
    for (const program of ['bun', 'bash']) {
      const path = join(root, 'bin', program);
      writeFileSync(path, `#!/bin/sh\n[ "$1" = "--version" ] && exit 0
printf '%s\\n' "$*" >> "$FIXTURE_ROOT/commands"
if [ "$1" = "install" ]; then
  /bin/cp "$FIXTURE_ROOT/package.json" "$FIXTURE_ROOT/install-manifest.json"
  printf '%s|%s|%s|%s' "$NODE_ENV" "$npm_config_omit" "$NPM_CONFIG_PRODUCTION" "$npm_config_only" > "$FIXTURE_ROOT/install-env"
  exit "\${INSTALL_EXIT:-0}"
fi
/bin/cp "$FIXTURE_ROOT/package.json" "$FIXTURE_ROOT/build-manifest.json"
exit "\${BUILD_EXIT:-0}"
`);
      chmodSync(path, 0o755);
    }
    run(root, { ...process.env, PATH: join(root, 'bin'), FIXTURE_ROOT: root }, manifest);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function bootstrap(root: string, env: NodeJS.ProcessEnv, args: string[] = []) {
  return spawnSync(node, [join(root, 'scripts/install-pi-source.mjs'), ...args], { env, encoding: 'utf8' });
}

test('production npm lifecycle installs local dev workspaces without recursion, then builds after restoring the manifest', () => {
  fixture((root, env, manifest) => {
    const result = bootstrap(root, { ...env, NODE_ENV: 'production', npm_config_omit: 'dev', NPM_CONFIG_PRODUCTION: 'true', npm_config_only: 'prod' });
    expect(result.status).toBe(0);
    const installing = JSON.parse(readFileSync(join(root, 'install-manifest.json'), 'utf8'));
    expect(installing.workspaces).toEqual(['apps/*', 'packages/*']);
    expect(installing.scripts.postinstall).toBeUndefined();
    expect(installing.scripts['build:pi']).toBe('existing-sequence');
    expect(readFileSync(join(root, 'install-env'), 'utf8')).toBe('development|||');
    expect(readFileSync(join(root, 'commands'), 'utf8').trim().split('\n')).toEqual(['install --no-save', 'run build:pi']);
    expect(readFileSync(join(root, 'build-manifest.json'), 'utf8')).toBe(manifest);
    expect(readFileSync(join(root, 'package.json'), 'utf8')).toBe(manifest);
    expect(existsSync(join(root, '.pi-source-install.lock'))).toBe(false);
  });
});

for (const phase of ['INSTALL', 'BUILD']) {
  test(`${phase.toLowerCase()} failure exits nonzero, restores the manifest and releases the guard`, () => {
    fixture((root, env, manifest) => {
      const result = bootstrap(root, { ...env, [`${phase}_EXIT`]: '17' });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('exit 17');
      expect(readFileSync(join(root, 'package.json'), 'utf8')).toBe(manifest);
      expect(existsSync(join(root, '.pi-source-install.lock'))).toBe(false);
      if (phase === 'INSTALL') expect(existsSync(join(root, 'build-manifest.json'))).toBe(false);
    });
  });
}

test('dev bootstrap links dependencies without triggering a build', () => {
  fixture((root, env, manifest) => {
    expect(bootstrap(root, env, ['--dependencies-only']).status).toBe(0);
    expect(readFileSync(join(root, 'package.json'), 'utf8')).toBe(manifest);
    expect(existsSync(join(root, 'build-manifest.json'))).toBe(false);
  });
});

for (const program of ['bun', 'bash']) {
  test(`missing ${program} fails with an actionable prerequisite message before modifying the manifest`, () => {
    fixture((root, env, manifest) => {
      rmSync(join(root, 'bin', program));
      const result = bootstrap(root, env);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(`require ${program} on PATH`);
      expect(result.stderr).toContain('npm run postinstall');
      expect(readFileSync(join(root, 'package.json'), 'utf8')).toBe(manifest);
      expect(existsSync(join(root, 'commands'))).toBe(false);
    });
  });
}

test('a concurrent or interrupted bootstrap guard is refused without deleting its lock', () => {
  fixture((root, env, manifest) => {
    writeFileSync(join(root, '.pi-source-install.lock'), 'other bootstrap');
    const result = bootstrap(root, env);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('interrupted');
    expect(readFileSync(join(root, 'package.json'), 'utf8')).toBe(manifest);
    expect(readFileSync(join(root, '.pi-source-install.lock'), 'utf8')).toBe('other bootstrap');
    expect(existsSync(join(root, 'commands'))).toBe(false);
  });
});

test.skipIf(process.platform === 'win32')('installed WebTUI works under Node and spawns a native terminal', () => {
  const result = spawnSync(node, ['--input-type=module', '-e', `
    import assert from 'node:assert/strict';
    const { NodePtyBackend } = await import('@plannotator/webtui/server');
    const session = await new NodePtyBackend({ shell: '/bin/sh', startupCommandMode: 'shell-command' })
      .spawn({ command: 'exit 0', cwd: process.cwd() });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { session.kill(); reject(new Error('PTY did not exit')); }, 5000);
      session.onExit(({ exitCode }) => {
        clearTimeout(timer);
        try { assert.equal(exitCode, 0); resolve(); } catch (error) { reject(error); }
      });
    });
  `], { cwd: join(import.meta.dir, '../apps/pi-extension'), encoding: 'utf8', timeout: 10000 });
  expect(result.error).toBeUndefined();
  expect(result.stderr).toBe('');
  expect(result.status).toBe(0);
}, 15000);

test('root Git installation selects the bootstrap while the published extension keeps its existing build lifecycle', () => {
  const root = JSON.parse(readFileSync(join(import.meta.dir, '../package.json'), 'utf8'));
  const extension = JSON.parse(readFileSync(join(import.meta.dir, '../apps/pi-extension/package.json'), 'utf8'));
  expect(root.scripts.postinstall).toBe('node scripts/install-pi-source.mjs');
  expect(root.workspaces).toBeUndefined();
  expect(extension.scripts.postinstall).toBeUndefined();
  expect(root.scripts['build:pi']).toBe('bun run build:review && bun run build:hook && bun run --cwd apps/pi-extension build');
});
