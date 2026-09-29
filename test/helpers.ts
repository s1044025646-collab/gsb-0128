import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { openDb, closeDb, migrate } from '../src/db.ts';
import { migration001 } from '../src/migrations/001_init.ts';
import { createDictionary } from '../src/domain/dictionary.ts';
import { createApplication } from '../src/domain/applications.ts';
import { createReference } from '../src/domain/references.ts';
import {
  fixtureApplication,
  fixtureBrokenApplication,
  fixtureDictionaryV1,
  fixtureReferences,
} from '../src/fixtures.ts';
import type { ApplicationBundle, DictionaryBundle, ReferenceBundle } from '../src/domain/types.ts';

export interface Seeded {
  dir: string;
  dict: { record: DictionaryBundle; duplicate: boolean };
  app: { record: ApplicationBundle; duplicate: boolean };
  broken: { record: ApplicationBundle; duplicate: boolean };
  refs: ReferenceBundle[];
}

export function setupTestDb(name: string): string {
  const dir = join(process.cwd(), '.tmp', `test-${name}`);
  rmSync(dir, { recursive: true, force: true });
  process.env.PATENT_DATA_DIR = dir;
  const db = openDb(join(dir, 'patent.db'));
  migrate(db, [migration001]);
  return dir;
}

export function seedFixtures(): Seeded {
  const dict = createDictionary(fixtureDictionaryV1());
  const app = createApplication(fixtureApplication());
  const broken = createApplication(fixtureBrokenApplication());
  const refs: ReferenceBundle[] = [];
  for (const r of fixtureReferences()) refs.push(createReference(r).record);
  return { dir: process.env.PATENT_DATA_DIR!, dict, app, broken, refs };
}

export function teardownTestDb(): void {
  closeDb();
}
