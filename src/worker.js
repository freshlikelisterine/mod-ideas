const CATEGORIES = [
  'Mobs', 'Bosses', 'Items', 'Artifacts', 'Weapons', 'Armor', 'Blocks', 'Biomes',
  'Dimensions', 'Structures', 'Classes', 'Magic', 'Tech', 'Fun', 'QoL', 'Other',
];
const STATUSES = ['', 'planned', 'added', 'rejected'];
const MAX = { title: 80, body: 1000 };
const IDEA_COLS = 'id, title, body, category, author, created, status, score';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (!url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);

    // Anonymous voter id, kept in a cookie. One vote per idea per voter.
    const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
    let vid = (request.headers.get('Cookie') || '').match(/(?:^|;\s*)vid=([a-f0-9]{32})/)?.[1];
    if (!vid) {
      vid = randomHex(16);
      const secure = url.protocol === 'https:' ? '; Secure' : '';
      headers['Set-Cookie'] = `vid=${vid}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax${secure}`;
    }

    let status = 200, data;
    try {
      [status, data] = await api(request, env, ctx, url.pathname, vid);
    } catch (e) {
      if (!e.status) console.error(e);
      status = e.status || 500;
      data = { error: e.status ? e.message : 'Server error' };
    }
    return new Response(JSON.stringify(data), { status, headers });
  },
};

async function api(request, env, ctx, pathname, vid) {
  const db = env.DB;
  const ip = await sha256(request.headers.get('CF-Connecting-IP') || '');
  const admin = !!env.ADMIN_TOKEN && safeEqual(request.headers.get('X-Admin'), env.ADMIN_TOKEN);

  // Occasionally clear expired rate limit rows.
  if (Math.random() < 0.01) {
    ctx.waitUntil(db.prepare('DELETE FROM hits WHERE reset < ?').bind(Date.now()).run());
  }

  if (request.method === 'GET' && pathname === '/api/ideas') {
    const [ideas, mine] = await db.batch([
      db.prepare(`SELECT ${IDEA_COLS} FROM ideas`),
      db.prepare('SELECT idea_id, v FROM votes WHERE voter = ?').bind(vid),
    ]);
    const my = new Map(mine.results.map(r => [r.idea_id, r.v]));
    return [200, {
      name: env.SITE_NAME || 'Mod Ideas', categories: CATEGORIES, statuses: STATUSES, admin,
      ideas: ideas.results.map(i => ({ ...i, my: my.get(i.id) || 0 })),
    }];
  }

  if (request.method === 'POST' && pathname === '/api/ideas') {
    if (await limited(db, 'post:' + ip, 5, 10 * 60_000)) {
      throw httpError(429, 'Too many ideas, try again in a few minutes');
    }
    const b = await readJson(request);
    const title = clean(b.title, MAX.title).replace(/\s+/g, ' ');
    const body = clean(b.body, MAX.body).replace(/\n{3,}/g, '\n\n');
    if (title.length < 4) throw httpError(400, 'Title is too short');
    if (!CATEGORIES.includes(b.category)) throw httpError(400, 'Pick a category');
    const author = typeof b.author === 'string' && /^[A-Za-z0-9_]{1,16}$/.test(b.author) ? b.author : '';

    const idea = {
      id: randomHex(4), title, body, category: b.category, author,
      created: Date.now(), status: '', score: 1,
    };
    try {
      await db.batch([
        db.prepare(`INSERT INTO ideas (${IDEA_COLS}, title_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .bind(idea.id, title, body, idea.category, author, idea.created, '', 1, title.toLowerCase()),
        db.prepare('INSERT INTO votes (idea_id, voter, v) VALUES (?, ?, 1)').bind(idea.id, vid),
      ]);
    } catch (e) {
      if (/UNIQUE.*title_key/.test(e.message)) throw httpError(409, 'That idea is already posted');
      throw e;
    }
    return [201, { ...idea, my: 1 }];
  }

  const m = pathname.match(/^\/api\/ideas\/([a-f0-9]{8})(?:\/(vote|status))?$/);
  if (m) {
    const id = m[1];
    if (!(await db.prepare('SELECT 1 FROM ideas WHERE id = ?').bind(id).first())) {
      throw httpError(404, 'Idea not found');
    }
    const select = db.prepare(`SELECT ${IDEA_COLS}, (SELECT v FROM votes WHERE idea_id = ?1 AND voter = ?2) AS my
      FROM ideas WHERE id = ?1`).bind(id, vid);

    if (request.method === 'POST' && m[2] === 'vote') {
      if (await limited(db, 'vote:' + ip, 120, 60_000)) throw httpError(429, 'Slow down');
      const { v } = await readJson(request);
      if (![1, -1, 0].includes(v)) throw httpError(400, 'Bad vote');
      const res = await db.batch([
        v
          ? db.prepare('INSERT INTO votes (idea_id, voter, v) VALUES (?1, ?2, ?3) ON CONFLICT DO UPDATE SET v = ?3').bind(id, vid, v)
          : db.prepare('DELETE FROM votes WHERE idea_id = ? AND voter = ?').bind(id, vid),
        db.prepare('UPDATE ideas SET score = (SELECT COALESCE(SUM(v), 0) FROM votes WHERE idea_id = ?1) WHERE id = ?1').bind(id),
        select,
      ]);
      return [200, withMy(res[2].results[0])];
    }

    if (!admin) throw httpError(403, 'Not allowed');

    if (request.method === 'POST' && m[2] === 'status') {
      const { status } = await readJson(request);
      if (!STATUSES.includes(status)) throw httpError(400, 'Bad status');
      const res = await db.batch([
        db.prepare('UPDATE ideas SET status = ? WHERE id = ?').bind(status, id),
        select,
      ]);
      return [200, withMy(res[1].results[0])];
    }

    if (request.method === 'DELETE' && !m[2]) {
      await db.batch([
        db.prepare('DELETE FROM votes WHERE idea_id = ?').bind(id),
        db.prepare('DELETE FROM ideas WHERE id = ?').bind(id),
      ]);
      return [200, { ok: true }];
    }
  }

  throw httpError(404, 'Not found');
}

// --- helpers ---

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function withMy(row) {
  return { ...row, my: row.my || 0 };
}

async function readJson(request) {
  if (!(request.headers.get('Content-Type') || '').startsWith('application/json')) {
    throw httpError(415, 'Expected JSON');
  }
  const text = await request.text();
  if (text.length > 16_384) throw httpError(413, 'Too large');
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' ? v : {};
  } catch {
    throw httpError(400, 'Bad JSON');
  }
}

function clean(s, max) {
  if (typeof s !== 'string') return '';
  return s.replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, '').trim().slice(0, max);
}

async function limited(db, key, max, windowMs) {
  const now = Date.now();
  const row = await db.prepare(`INSERT INTO hits (key, n, reset) VALUES (?1, 1, ?2)
    ON CONFLICT(key) DO UPDATE SET
      n = CASE WHEN reset < ?3 THEN 1 ELSE n + 1 END,
      reset = CASE WHEN reset < ?3 THEN ?2 ELSE reset END
    RETURNING n`).bind(key, now + windowMs, now).first();
  return row.n > max;
}

function randomHex(bytes) {
  return [...crypto.getRandomValues(new Uint8Array(bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function sha256(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].slice(0, 12).map(b => b.toString(16).padStart(2, '0')).join('');
}

function safeEqual(a, b) {
  if (typeof a !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
