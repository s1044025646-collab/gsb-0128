import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { isProjectProcess } from './process-guard.mjs';

const projectRoot = resolve(import.meta.dirname, '..');
const dataDir = process.env.PATENT_DATA_DIR ? resolve(process.env.PATENT_DATA_DIR) : join(projectRoot, 'data');
const pidFile = join(dataDir, 'server.pid');
const portFile = join(dataDir, 'server.port');

function cleanup() {
  rmSync(pidFile, { force: true });
  rmSync(portFile, { force: true });
  rmSync(join(dataDir, 'server.host'), { force: true });
}

if (!existsSync(pidFile)) {
  console.log('no server.pid found; nothing to stop for this project');
  process.exit(0);
}

const pid = Number(readFileSync(pidFile, 'utf8').trim());
if (!isProjectProcess(pid, projectRoot)) {
  console.log(`pid ${pid} is not a server process of this project; leaving it alone`);
  cleanup();
  process.exit(0);
}

console.log(`stopping project server (pid ${pid})...`);
try {
  process.kill(pid, 'SIGTERM');
} catch (err) {
  if (err.code !== 'ESRCH') throw err;
}

const deadline = Date.now() + 8000;
while (Date.now() < deadline) {
  try {
    process.kill(pid, 0);
  } catch {
    cleanup();
    console.log('server stopped');
    process.exit(0);
  }
  await new Promise((r) => setTimeout(r, 100));
}

try {
  process.kill(pid, 'SIGKILL');
} catch {
  /* already gone */
}
cleanup();
console.log('server stopped (forced)');
