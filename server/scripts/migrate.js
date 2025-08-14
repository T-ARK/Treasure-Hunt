import 'dotenv/config';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { query } from '../db.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function run() {
  const sql = await fs.readFile(path.join(__dirname, '..', 'schema.sql'), 'utf8');
  await query(sql);
  console.log('Migration complete ✅');
  process.exit(0);
}

run().catch((e) => { console.error(e); process.exit(1); });
