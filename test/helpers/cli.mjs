import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const cli = fileURLToPath(new URL('../../dist/cli.js', import.meta.url));

/**
 * Temp dir plus file-backed DB plus CLI runners. `run` spawns synchronously
 * (stdin via `input`); `runAsync` spawns concurrently for multiprocess
 * races. `prefix` marks the temp dir per file. Teardown removes the dir.
 */
export function cliSetup(t, prefix = 'yurai-cli-') {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  const db = join(dir, 'ledger.sqlite');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const base = ['--disable-warning=ExperimentalWarning', cli, '--db', db];
  const run = (args, input) => spawnSync(process.execPath,
    [...base, ...args], { encoding: 'utf8', input });
  const runAsync = args => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...base, ...args]);
    let stdout = '', stderr = '';
    child.stdout.on('data', c => { stdout += c; });
    child.stderr.on('data', c => { stderr += c; });
    child.on('error', reject);
    child.on('close', status => resolve({ status, stdout, stderr }));
  });
  return { dir, db, run, runAsync };
}
