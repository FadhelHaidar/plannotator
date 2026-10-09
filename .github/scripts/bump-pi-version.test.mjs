import assert from 'node:assert/strict';
import test from 'node:test';
import { bumpVersion, classifyBump } from './bump-pi-version.mjs';

test('Conventional Commit types select the intended bump', () => {
  for (const type of ['feat', 'feat(ui)']) assert.equal(classifyBump(`${type}: add feature`), 'minor');
  for (const type of ['fix', 'perf', 'revert']) assert.equal(classifyBump(`${type}: correct behavior`), 'patch');
  for (const type of ['chore', 'docs', 'test', 'ci', 'build', 'style', 'refactor']) {
    assert.equal(classifyBump(`${type}: maintenance`), null);
  }
});

test('breaking markers take precedence over commit type', () => {
  assert.equal(classifyBump('fix!: change public contract'), 'major');
  assert.equal(classifyBump('refactor: change public contract\n\nBREAKING CHANGE: callers must update'), 'major');
});

test('the highest bump in a commit range wins', () => {
  assert.equal(bumpVersion('0.28.4', 'patch'), '0.28.5');
  assert.equal(bumpVersion('0.28.4', 'minor'), '0.29.0');
  assert.equal(bumpVersion('0.28.4', 'major'), '1.0.0');
  assert.throws(() => bumpVersion('0.28.4-beta.1', 'patch'), /Expected a stable semantic version/);
});
