/**
 * Applies numbered SQL migrations under drizzle/ that are not yet recorded.
 * Used because production historically used db:push — drizzle-kit migrate journal
 * may not be baselined. This runner is idempotent (IF NOT EXISTS / ON CONFLICT).
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import pg from 'pg';

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error('DATABASE_URL is required');
    process.exit(1);
  }

  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();

  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS midas_sql_migrations (
        id text PRIMARY KEY,
        applied_at timestamp NOT NULL DEFAULT now()
      );
    `);

    const drizzleDir = path.resolve(__dirname, '../../drizzle');
    const files = (await readdir(drizzleDir))
      .filter((f) => /^\d{4}_.+\.sql$/.test(f))
      .sort();

    for (const file of files) {
      const id = file.replace(/\.sql$/, '');
      const { rows } = await client.query(
        'SELECT 1 FROM midas_sql_migrations WHERE id = $1',
        [id],
      );
      if (rows.length > 0) {
        console.log(`skip ${id} (already applied)`);
        continue;
      }

      const seq = Number(id.slice(0, 4));
      if (seq < 14) {
        const { rows: exp } = await client.query(
          `SELECT 1 FROM information_schema.tables WHERE table_name = 'expenses' LIMIT 1`,
        );
        if (exp.length > 0) {
          await client.query(
            'INSERT INTO midas_sql_migrations (id) VALUES ($1) ON CONFLICT DO NOTHING',
            [id],
          );
          console.log(`baseline skip ${id} (schema already present)`);
          continue;
        }
      }

      const sqlText = await readFile(path.join(drizzleDir, file), 'utf8');
      console.log(`applying ${id}...`);
      await client.query(sqlText);
      await client.query(
        'INSERT INTO midas_sql_migrations (id) VALUES ($1)',
        [id],
      );
      console.log(`applied ${id}`);
    }

    console.log('SQL migrations complete');
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
