import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function classifyBump(message) {
  const [header = '', ...body] = message.trim().split(/\r?\n/);
  const match = header.match(/^([a-z][a-z0-9-]*)(?:\([^()\r\n]+\))?(!)?: .+$/);
  if (!match) return null;
  if (match[2] || /^BREAKING[- ]CHANGE:/m.test(body.join('\n'))) return 'major';
  if (match[1] === 'feat') return 'minor';
  if (['fix', 'perf', 'revert'].includes(match[1])) return 'patch';
  return null;
}

export function bumpVersion(version, bump) {
  const match = version.match(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/);
  if (!match) throw new Error(`Expected a stable semantic version, got: ${version}`);
  const [major, minor, patch] = match.slice(1).map(Number);
  if (bump === 'major') return `${major + 1}.0.0`;
  if (bump === 'minor') return `${major}.${minor + 1}.0`;
  if (bump === 'patch') return `${major}.${minor}.${patch + 1}`;
  throw new Error(`Unknown version bump: ${bump}`);
}

function main() {
  const tags = execFileSync('git', ['tag', '--list', 'pi-v*'], { encoding: 'utf8' })
    .trim().split('\n').filter(Boolean)
    .map((tag) => ({ tag, version: tag.match(/^pi-v(\d+\.\d+\.\d+)$/)?.[1] }))
    .filter(({ version }) => version)
    .sort((a, b) => a.version.localeCompare(b.version, undefined, { numeric: true }));
  if (!tags.length) throw new Error('No pi-vX.Y.Z baseline tag; create the initial version tag first.');

  const previous = tags.at(-1);
  const messages = execFileSync('git', ['log', '--no-merges', '-z', '--format=%B', `${previous.tag}..HEAD`], { encoding: 'utf8' })
    .split('\0').filter((message) => message.trim());
  const bumps = messages.map(classifyBump);
  const bump = bumps.includes('major') ? 'major' : bumps.includes('minor') ? 'minor' : bumps.includes('patch') ? 'patch' : null;
  const version = bump ? bumpVersion(previous.version, bump) : '';
  const output = process.env.GITHUB_OUTPUT;
  if (output) appendFileSync(output, `version=${version}\n`);
  console.log(version ? `${previous.version} -> ${version} (${bump})` : `No release-worthy commits since ${previous.tag}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
