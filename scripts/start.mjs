import { spawn } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync, mkdirSync, createWriteStream } from 'node:fs';
import { join, resolve } from 'node:path';
import { isProjectProcess } from './process-guard.mjs';

const projectRoot = resolve(import.meta.dirname, '..');
const dataDir = process.env.PATENT_DATA_DIR ? resolve(process.env.PATENT_DATA_DIR) : join(projectRoot, 'data');
const tmpDir = join(projectRoot, '.tmp');
mkdirSync(tmpDir, { recursive: true });
mkdirSync(dataDir, { recursive: true });

const pidFile = join(dataDir, 'server.pid');
const portFile = join(dataDir, 'server.port');
const logFile = join(tmpDir, 'server.log');

if (existsSync(pidFile)) {
  const pid = Number(readFileSync(pidFile, 'utf8').trim());
  if (isProjectProcess(pid, projectRoot)) {
    const port = existsSync(portFile) ? readFileSync(portFile, 'utf8').trim() : '?';
    console.log(`server already running for this project (pid ${pid}, port ${port})`);
    process.exit(0);
  }
  rmSync(pidFile, { force: true });
}

rmSync(portFile, { force: true });
const child = spawn(
  process.execPath,
  [join(projectRoot, 'src', 'cli.ts'), 'serve', '--host', '127.0.0.1', '--port', '0'],
  {
    cwd: projectRoot,
    env: { ...process.env, PATENT_DATA_DIR: dataDir },
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);

writeFileSync(pidFile, String(child.pid), 'utf8');
const log = createWriteStream(logFile, { flags: 'w' });
child.stdout.pipe(log);
child.stderr.pipe(log);
child.unref();

const deadline = Date.now() + 15000;
while (Date.now() < deadline) {
  if (existsSync(portFile)) {
    const port = readFileSync(portFile, 'utf8').trim();
    console.log(`server started: http://127.0.0.1:${port} (pid ${child.pid})`);
    console.log(`data dir: ${dataDir}`);
    console.log(`log: ${logFile}`);
    process.exit(0);
  }
  await new Promise((r) => setTimeout(r, 100));
}

console.error('server did not open a port within 15s; see .tmp/server.log');
process.exit(1);
