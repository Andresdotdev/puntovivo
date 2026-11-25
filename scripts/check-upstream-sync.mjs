#!/usr/bin/env node
/**
 * How far each local branch is from the owner's repository.
 *
 * A fork does not update itself, and `origin/main` in this clone is a stale
 * copy of the fork, so comparing against it reports numbers that mean nothing.
 * The authority is `upstream/main`.
 *
 * Usage:
 *   node scripts/check-upstream-sync.mjs            report only
 *   node scripts/check-upstream-sync.mjs --no-fetch report with what is local
 *   node scripts/check-upstream-sync.mjs --strict   exit 1 when a branch is behind
 *
 * Nothing here writes: it never merges, rebases or pushes. Integrating is a
 * human decision because a branch with an open pull request must keep the
 * history the maintainer is already reviewing.
 */
import { execFileSync } from 'node:child_process';

const UPSTREAM_URL = 'https://github.com/johnny4young/puntovivo.git';
const args = new Set(process.argv.slice(2));
const shouldFetch = !args.has('--no-fetch');
const strict = args.has('--strict');

function git(...params) {
  return execFileSync('git', params, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function gitQuiet(...params) {
  try {
    return git(...params);
  } catch {
    return null;
  }
}

function ensureUpstreamRemote() {
  const remotes = git('remote');
  if (!remotes.split('\n').includes('upstream')) {
    console.log(`adding upstream remote: ${UPSTREAM_URL}`);
    git('remote', 'add', 'upstream', UPSTREAM_URL);
  }
}

function main() {
  ensureUpstreamRemote();

  if (shouldFetch) {
    console.log('fetching upstream…');
    git('fetch', 'upstream', '--prune', '--quiet');
  }

  const upstreamHead = gitQuiet('rev-parse', '--short', 'upstream/main');
  if (!upstreamHead) {
    console.error('upstream/main is not available. Run: git fetch upstream');
    process.exit(2);
  }
  const subject = git('log', '-1', '--format=%cs %s', 'upstream/main');
  console.log(`\nupstream/main = ${upstreamHead}  (${subject})\n`);

  const branches = git('for-each-ref', '--format=%(refname:short)', 'refs/heads')
    .split('\n')
    .filter(branch => branch && branch !== 'main');

  const rows = [];
  for (const branch of branches) {
    const behind = Number(gitQuiet('rev-list', '--count', `${branch}..upstream/main`) ?? 0);
    const ahead = Number(gitQuiet('rev-list', '--count', `upstream/main..${branch}`) ?? 0);
    const hasUpstream = gitQuiet('rev-parse', '--abbrev-ref', `${branch}@{upstream}`) !== null;
    rows.push({ branch, behind, ahead, hasUpstream });
  }

  rows.sort((a, b) => b.behind - a.behind);
  const width = Math.max(...rows.map(row => row.branch.length), 6);

  console.log('branch'.padEnd(width), 'behind', 'ahead', ' pushed');
  for (const row of rows) {
    const flag = row.behind === 0 ? 'OK' : 'STALE';
    console.log(
      row.branch.padEnd(width),
      String(row.behind).padStart(6),
      String(row.ahead).padStart(5),
      row.hasUpstream ? 'yes' : 'NO',
      ' ',
      flag
    );
  }

  const stale = rows.filter(row => row.behind > 0);
  console.log('');
  if (stale.length === 0) {
    console.log('Every branch already contains upstream/main.');
    return 0;
  }

  console.log(`${stale.length} branch(es) do not contain upstream/main yet:`);
  for (const row of stale) {
    console.log(`  git switch ${row.branch} && git merge upstream/main`);
  }
  console.log('\nIntegrate with merge, never rebase: a branch with an open pull request');
  console.log('must keep the commits the maintainer is already reviewing.');
  return strict ? 1 : 0;
}

process.exitCode = main();
