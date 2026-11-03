const CATEGORIES = [
  'Mobs', 'Bosses', 'Items', 'Artifacts', 'Weapons', 'Armor', 'Blocks', 'Biomes',
  'Dimensions', 'Structures', 'Classes', 'Magic', 'Tech', 'Fun', 'QoL', 'Other',
];
const STATUSES = ['', 'planned', 'added', 'rejected'];
const MAX = { title: 80, body: 5000, comment: 2000 };
const IDEA_COLS = 'id, title, body, category, author, created, status, score, comments';
// The wall only needs a preview of each idea.
const LIST_COLS = IDEA_COLS.replace('body', 'substr(body, 1, 300) AS body');

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
      db.prepare(`SELECT ${LIST_COLS} FROM ideas`),
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
    const body = cleanText(b.body, MAX.body);
    if (title.length < 4) throw httpError(400, 'Title is too short');
    if (!CATEGORIES.includes(b.category)) throw httpError(400, 'Pick a category');

    const idea = {
      id: randomHex(4), title, body, category: b.category, author: playerName(b.author),
      created: Date.now(), status: '', score: 1, comments: 0,
    };
    try {
      await db.batch([
        db.prepare(`INSERT INTO ideas (id, title, title_key, body, category, author, created, score)
          VALUES (?, ?, ?, ?, ?, ?, ?, 1)`)
          .bind(idea.id, title, title.toLowerCase(), body, idea.category, idea.author, idea.created),
        db.prepare('INSERT INTO votes (idea_id, voter, v) VALUES (?, ?, 1)').bind(idea.id, vid),
      ]);
    } catch (e) {
      if (/UNIQUE.*title_key/.test(e.message)) throw httpError(409, 'That idea is already posted');
      throw e;
    }
    return [201, { ...idea, my: 1 }];
  }

  const m = pathname.match(/^\/api\/ideas\/([a-f0-9]{8})(?:\/(vote|status|comments))?$/);
  if (m) {
    const id = m[1];
    const select = db.prepare(`SELECT ${IDEA_COLS}, (SELECT v FROM votes WHERE idea_id = ?1 AND voter = ?2) AS my
      FROM ideas WHERE id = ?1`).bind(id, vid);

    if (request.method === 'GET' && !m[2]) {
      const [idea, thread] = await db.batch([
        select,
        db.prepare('SELECT id, body, author, created FROM comments WHERE idea_id = ? ORDER BY created').bind(id),
      ]);
      if (!idea.results[0]) throw httpError(404, 'Idea not found');
      return [200, { ...withMy(idea.results[0]), thread: thread.results }];
    }

    if (!(await db.prepare('SELECT 1 FROM ideas WHERE id = ?').bind(id).first())) {
      throw httpError(404, 'Idea not found');
    }

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

    if (request.method === 'POST' && m[2] === 'comments') {
      if (await limited(db, 'comment:' + ip, 10, 5 * 60_000)) {
        throw httpError(429, 'Too many comments, try again in a few minutes');
      }
      const b = await readJson(request);
      const body = cleanText(b.body, MAX.comment);
      if (body.length < 2) throw httpError(400, 'Comment is empty');
      const c = { id: randomHex(6), body, author: playerName(b.author), created: Date.now() };
      await db.batch([
        db.prepare('INSERT INTO comments (id, idea_id, body, author, created) VALUES (?, ?, ?, ?, ?)')
          .bind(c.id, id, c.body, c.author, c.created),
        db.prepare('UPDATE ideas SET comments = comments + 1 WHERE id = ?').bind(id),
      ]);
      return [201, c];
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
        db.prepare('DELETE FROM comments WHERE idea_id = ?').bind(id),
        db.prepare('DELETE FROM ideas WHERE id = ?').bind(id),
      ]);
      return [200, { ok: true }];
    }
  }

  const cm = pathname.match(/^\/api\/comments\/([a-f0-9]{12})$/);
  if (cm && request.method === 'DELETE') {
    if (!admin) throw httpError(403, 'Not allowed');
    const row = await db.prepare('SELECT idea_id FROM comments WHERE id = ?').bind(cm[1]).first();
    if (!row) throw httpError(404, 'Comment not found');
    await db.batch([
      db.prepare('DELETE FROM comments WHERE id = ?').bind(cm[1]),
      db.prepare('UPDATE ideas SET comments = comments - 1 WHERE id = ?').bind(row.idea_id),
    ]);
    return [200, { ok: true }];
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
  if (text.length > 32_768) throw httpError(413, 'Too large');
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' ? v : {};
  } catch {
    throw httpError(400, 'Bad JSON');
  }
}

function clean(s, max) {
  if (typeof s !== 'string') return '';
  return s.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, '').trim().slice(0, max);
}

function cleanText(s, max) {
  return clean(s, max).replace(/\n{3,}/g, '\n\n');
}

function playerName(s) {
  return typeof s === 'string' && /^[A-Za-z0-9_]{1,16}$/.test(s) ? s : '';
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
