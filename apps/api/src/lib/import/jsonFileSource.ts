import { readFile } from 'fs/promises';
import type { ImportRecord, ImportSource } from '@midas/import';

/**
 * Generic `ImportSource` that reads a JSON array of `ImportRecord`s from disk.
 * This is the simplest possible source — most embedders will write their own
 * `ImportSource` that talks to their existing database/API instead, but this
 * one is enough to migrate a one-off export or to test the pipeline end to end.
 */
export class JsonFileImportSource implements ImportSource {
  readonly name: string;

  constructor(private readonly filePath: string, name?: string) {
    this.name = name ?? `json-file:${filePath}`;
  }

  async *fetchRecords(): AsyncIterable<ImportRecord> {
    const raw = await readFile(this.filePath, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      throw new Error(`${this.filePath} must contain a JSON array of ImportRecord objects`);
    }
    for (const record of parsed as ImportRecord[]) {
      yield record;
    }
  }
}
