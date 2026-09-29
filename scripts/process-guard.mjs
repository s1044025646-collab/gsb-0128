import { execFileSync } from 'node:child_process';

/**
 * Verify that a PID belongs to a process started by THIS project.
 * Used by start/stop scripts so they never touch unrelated processes.
 */
export function isProjectProcess(pid, projectRoot) {
  if (!pid || !Number.isInteger(pid)) return false;
  try {
    const out = execFileSync(
      'powershell',
      ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").CommandLine`],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const cmd = out.trim();
    if (!cmd) return false;
    const normalizedRoot = projectRoot.replace(/\//g, '\\').toLowerCase();
    return cmd.toLowerCase().includes(normalizedRoot) && cmd.includes('cli.ts');
  } catch {
    return false;
  }
}
