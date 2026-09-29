import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

export function getProjectRoot(): string {
  return resolve(import.meta.dirname, '..');
}

export function getDataDir(): string {
  const dir = process.env.PATENT_DATA_DIR
    ? resolve(process.env.PATENT_DATA_DIR)
    : join(getProjectRoot(), 'data');
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function getTmpDir(): string {
  const dir = join(getProjectRoot(), '.tmp');
  mkdirSync(dir, { recursive: true });
  return dir;
}
