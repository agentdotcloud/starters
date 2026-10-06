import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const LEDGER = 'agentcloud_migrations';

export interface MigrationFile {
  stem: string;
  path: string;
  sql: string;
  checksum: string;
  noTransaction: boolean;
}

const NAME = /^(\d+)_([a-z0-9_-]+)$/;

// <digits>_<slug>.sql or <digits>_<slug>/migration.sql, in numeric order of the prefix (spec 3.1).
export function listMigrations(dir: string): MigrationFile[] {
  if (!existsSync(dir)) return [];
  const files: MigrationFile[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const stem = entry.endsWith('.sql') ? entry.slice(0, -4) : entry;
    const path = statSync(full).isDirectory() ? join(full, 'migration.sql') : entry.endsWith('.sql') ? full : '';
    if (!path || !NAME.test(stem) || !existsSync(path)) continue;
    const sql = readFileSync(path, 'utf8');
    files.push({
      stem, path, sql,
      checksum: createHash('sha256').update(sql).digest('hex'),
      noTransaction: /^\s*--\s*agentcloud:\s*no-transaction/i.test(sql),
    });
  }
  const prefix = (s: string) => BigInt(NAME.exec(s)![1]);
  return files.sort((a, b) => (prefix(a.stem) < prefix(b.stem) ? -1 : prefix(a.stem) > prefix(b.stem) ? 1 : a.stem.localeCompare(b.stem)));
}

export function plan(files: MigrationFile[], applied: { name: string; checksum: string }[]) {
  const done = new Map(applied.map((a) => [a.name, a.checksum]));
  return {
    pending: files.filter((f) => !done.has(f.stem)),
    modified: files.filter((f) => done.has(f.stem) && done.get(f.stem) !== f.checksum).map((f) => f.stem),
    missing: [...done.keys()].filter((name) => !files.some((f) => f.stem === name)),
  };
}

export function timestampStem(slug: string, now = new Date()): string {
  const ts = now.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  return `${ts}_${slug.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')}`;
}
