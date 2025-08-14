import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import rateLimit from 'express-rate-limit';
import path from 'path';
import { fileURLToPath } from 'url';
import { pool, query, tx } from './db.js';

const app = express();
const httpServer = createServer(app);
const io = new SocketIOServer(httpServer, {
  cors: { origin: (process.env.CORS_ORIGIN || '*').split(',').map(s => s.trim()) }
});

app.use(helmet());
app.use(express.json());
app.use(cors({ origin: (origin, cb) => cb(null, true) }));

const __dirname = path.dirname(fileURLToPath(import.meta.url));
app.use(express.static(path.join(__dirname, '..', 'public')));

function signToken(payload) {
  return jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '12h' });
}
function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'No token' });
  try { req.user = jwt.verify(token, process.env.JWT_SECRET); next(); }
  catch { return res.status(401).json({ error: 'Invalid token' }); }
}

const formatTime = (ms) => {
  if (!ms || ms < 0) return '00:00:00';
  const sec = Math.floor(ms / 1000);
  const h = String(Math.floor(sec / 3600)).padStart(2, '0');
  const m = String(Math.floor((sec % 3600) / 60)).padStart(2, '0');
  const s = String(sec % 60).padStart(2, '0');
  return `${h}:${m}:${s}`;
};

/* ---------- Public APIs ---------- */
app.get('/api/scoreboard', async (req, res) => {
  const { rows: teams } = await query(`
    select t.id, t.name, t.current_index, t.started_at, t.finished_at,
      (select count(*) from team_routes r where r.team_id=t.id) as total
    from teams t order by t.id asc
  `);
  const now = Date.now();
  const out = teams.map(t => {
    const total = Number(t.total || 0);
    const completed = Math.min(t.current_index, total);
    const start = t.started_at ? new Date(t.started_at).getTime() : null;
    const end = t.finished_at ? new Date(t.finished_at).getTime() : null;
    const ms = start ? (end || now) - start : 0;
    const status = end ? 'Finished' : 'In Progress';
    return { teamId: t.id, name: t.name, progress: `${completed}/${total}`, time: formatTime(ms), status };
  });
  res.json(out);
});

app.get('/api/team/:teamId/state', async (req, res) => {
  const teamId = req.params.teamId;
  const { rows: trows } = await query('select * from teams where id=$1', [teamId]);
  if (!trows.length) return res.status(404).json({ error: 'Team not found' });

  const team = trows[0];
  const { rows: route } = await query(`
    select r.position, l.id as location_id, l.title, l.block, l.type
    from team_routes r
    join locations l on l.id=r.location_id
    where r.team_id=$1
    order by r.position asc
  `, [teamId]);

  const total = route.length;
  const idx = Math.min(team.current_index, total);
  const current = idx < total ? route[idx] : null;

  res.json({
    teamId,
    currentIndex: idx,
    total,
    currentLocation: current,
    startedAt: team.started_at,
    finishedAt: team.finished_at
  });
});

const pinLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 8,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `${req.params.teamId}:${req.ip}`
});

app.post('/api/team/:teamId/verify', pinLimiter, async (req, res) => {
  const teamId = req.params.teamId;
  const { pin } = req.body || {};
  if (!/^\d{4}$/.test(String(pin || ''))) {
    return res.status(400).json({ ok: false, message: 'Invalid PIN format' });
  }

  try {
    const result = await tx(async (c) => {
      const { rows: trows } = await c.query('select * from teams where id=$1 for update', [teamId]);
      if (!trows.length) return { code: 404, message: 'Team not found' };
      const team = trows[0];

      const { rows: route } = await c.query(`
        select r.position, r.location_id, l.title, l.block, l.type
        from team_routes r
        join locations l on l.id=r.location_id
        where r.team_id=$1
        order by r.position asc
      `, [teamId]);

      const total = route.length;
      const idx = team.current_index;
      if (idx >= total) return { code: 409, message: 'Route already complete' };

      const currentLoc = route[idx];

      const { rows: taskMatch } = await c.query(
        'select 1 from tasks where location_id=$1 and pin=$2 limit 1',
        [currentLoc.location_id, String(pin)]
      );
      if (!taskMatch.length) return { code: 401, message: 'Incorrect PIN' };

      await c.query(
        `insert into progress(team_id, position, location_id, pin_last4)
         values ($1,$2,$3,$4)`,
        [teamId, idx, currentLoc.location_id, String(pin)]
      );

      if (!team.started_at) {
        await c.query('update teams set started_at=now() where id=$1', [teamId]);
      }

      let finished = false;
      if (idx + 1 >= total) {
        await c.query('update teams set current_index=$1, finished_at=now() where id=$2', [idx + 1, teamId]);
        finished = true;
      } else {
        await c.query('update teams set current_index=$1 where id=$2', [idx + 1, teamId]);
      }

      const nextLoc = finished ? null : route[idx + 1];
      return { code: 200, finished, nextLocation: nextLoc };
    });

    if (result.code !== 200) {
      return res.status(result.code).json({ ok: false, message: result.message });
    }

    io.emit('scoreboard:update', { teamId });
    res.json({ ok: true, finished: result.finished, nextLocation: result.nextLocation });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, message: 'Server error' });
  }
});

/* ---------- Admin APIs ---------- */
app.post('/api/admin/login', async (req, res) => {
  const { email, password } = req.body || {};
  const { rows } = await query('select * from admins where email=$1', [email]);
  if (!rows.length) return res.status(401).json({ error: 'Invalid credentials' });
  const admin = rows[0];
  const ok = await bcrypt.compare(password || '', admin.password_hash);
  if (!ok) return res.status(401).json({ error: 'Invalid credentials' });
  res.json({ token: signToken({ sub: admin.id, email }) });
});

app.get('/api/admin/overview', auth, async (req, res) => {
  const [teams, routes, locations, tasks] = await Promise.all([
    query('select * from teams order by id asc'),
    query('select * from team_routes order by team_id asc, position asc'),
    query('select * from locations order by id asc'),
    query('select * from tasks order by id asc')
  ]);
  res.json({
    teams: teams.rows,
    routes: routes.rows,
    locations: locations.rows,
    tasks: tasks.rows
  });
});

app.put('/api/admin/tasks/:id', auth, async (req, res) => {
  const id = Number(req.params.id);
  const { name, instructions, proof, pin } = req.body || {};
  const { rows } = await query(
    `update tasks set
        name = coalesce($1, name),
        instructions = coalesce($2, instructions),
        proof = coalesce($3, proof),
        pin = coalesce($4, pin)
     where id=$5 returning *`,
    [name, instructions, proof, pin, id]
  );
  if (!rows.length) return res.status(404).json({ error: 'Task not found' });
  io.emit('admin:tasks:update', { id, task: rows[0] });
  res.json(rows[0]);
});

app.post('/api/admin/reset', auth, async (req, res) => {
  const { teamId } = req.body || {};
  try {
    await tx(async (c) => {
      if (teamId) {
        await c.query('delete from progress where team_id=$1', [teamId]);
        await c.query('update teams set current_index=0, started_at=null, finished_at=null where id=$1', [teamId]);
        io.emit('scoreboard:update', { teamId });
      } else {
        await c.query('delete from progress', []);
        await c.query('update teams set current_index=0, started_at=null, finished_at=null', []);
        io.emit('scoreboard:reset', {});
      }
    });
    res.json({ ok: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false });
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));

// Serve index.html for root
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

const PORT = process.env.PORT || 8080;
httpServer.listen(PORT, () => console.log(`API + UI listening on http://localhost:${PORT}`));
