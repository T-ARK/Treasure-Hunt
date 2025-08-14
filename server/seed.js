import 'dotenv/config';
import bcrypt from 'bcryptjs';
import { query, tx } from './db.js';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function run() {
  const raw = await fs.readFile(path.join(__dirname, 'data.json'), 'utf8');
  const data = JSON.parse(raw);

  // admin
  const email = 'admin@iste.local';
  const password = 'changeme';
  const hash = await bcrypt.hash(password, 10);
  await query(
    `insert into admins(email, password_hash)
     values ($1,$2)
     on conflict (email) do nothing`,
    [email, hash]
  );
  console.log(`Admin seeded: ${email} / ${password}`);

  // locations
  for (const [id, loc] of Object.entries(data.LOCATIONS)) {
    await query(
      `insert into locations(id, title, block, type)
       values ($1,$2,$3,$4)
       on conflict (id) do update set title=$2, block=$3, type=$4`,
      [id, loc.title, loc.block, loc.type]
    );
  }
  console.log('Locations seeded');

  // teams
  for (let i = 1; i <= 10; i++) {
    const id = `TEAM_${String(i).padStart(2, '0')}`;
    await query(
      `insert into teams(id, name)
       values ($1,$2)
       on conflict (id) do update set name = excluded.name`,
      [id, `Team ${String(i).padStart(2, '0')}`]
    );
  }
  console.log('Teams seeded');

  // routes
  for (const [teamId, route] of Object.entries(data.ROUTES)) {
    // Clear and reinsert for idempotent seed
    await tx(async (c) => {
      await c.query(`delete from team_routes where team_id=$1`, [teamId]);
      for (let pos = 0; pos < route.length; pos++) {
        await c.query(
          `insert into team_routes(team_id, position, location_id)
           values ($1,$2,$3)`,
          [teamId, pos, route[pos]]
        );
      }
    });
  }
  console.log('Routes seeded');

  // tasks
  for (const [locId, tasks] of Object.entries(data.TASKS)) {
    for (const t of tasks) {
      await query(
        `insert into tasks(location_id, name, instructions, proof, pin)
         values ($1,$2,$3,$4,$5)
         on conflict (location_id, name) do update
           set instructions=excluded.instructions,
               proof=excluded.proof,
               pin=excluded.pin`,
        [locId, t.name, t.instructions, t.proof, t.pin]
      );
    }
  }
  console.log('Tasks seeded');

  console.log('Seed complete ✅');
  process.exit(0);
}

run().catch((e) => { console.error(e); process.exit(1); });
