import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { env } from '../config/env';
import * as schema from './schema';

const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: 10,
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle client', err);
  process.exit(1);
});

export const db = drizzle(pool, { schema });
export { pool };
