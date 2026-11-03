'use strict';
const $ = s => document.querySelector(s);
const PAGE = 50;

const store = {
  get(k) { try { return localStorage.getItem(k) || ''; } catch { return ''; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};

// Visiting /?admin=TOKEN once remembers the token in this browser.
const params = new URLSearchParams(location.search);
if (params.has('admin')) {
  store.set('admin', params.get('admin'));
  history.replaceState(null, '', location.pathname + location.hash);
}
// Old share links looked like /#i-abc123.
const oldLink = location.hash.match(/^#i-([a-f0-9]{8})$/);
if (oldLink) history.replaceState(null, '', '/i/' + oldLink[1]);

const adminToken = store.get('admin');

const state = {
  name: 'Mod Ideas', ideas: [], categories: [], statuses: [], admin: false,
  sort: store.get('sort') || 'hot', cat: '', q: '', shown: PAGE,
  current: null, listScroll: 0, fromList: false,
};

async function api(method, url, body) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (adminToken) headers['X-Admin'] = adminToken;
  const r = await fetch(url, { method, headers, body: body && JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || 'Something went wrong');
  return data;
}

const esc = s => String(s).replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

function ago(t) {
  const m = (Date.now() - t) / 60000;
  if (m < 1) return 'now';
  if (m < 60) return Math.floor(m) + 'm';
  if (m < 1440) return Math.floor(m / 60) + 'h';
  if (m < 43200) return Math.floor(m / 1440) + 'd';
  if (m < 525600) return Math.floor(m / 43200) + 'mo';
  return Math.floor(m / 525600) + 'y';
}

const hot = i => i.score / Math.pow((Date.now() - i.created) / 36e5 + 2, 1.5);
const SORTS = {
  hot: (a, b) => hot(b) - hot(a),
  top: (a, b) => b.score - a.score || b.created - a.created,
  new: (a, b) => b.created - a.created,
};

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 1800);
}

const findIdea = id => state.ideas.find(i => i.id === id);

// --- navigation ---

function go(path) {
  if (location.pathname === path) return;
  if (!$('#list-view').hidden) {
    state.listScroll = scrollY;
    state.fromList = true;
  }
  history.pushState(null, '', path);
  route();
}

function route() {
  const id = location.pathname.match(/^\/i\/([a-f0-9]{8})$/)?.[1];
  if (id) showIdea(id);
  else showList();
}

function showList() {
  state.current = null;
  $('#idea-view').hidden = true;
  $('#list-view').hidden = false;
  document.title = state.name;
  render();
  scrollTo(0, state.listScroll);
}

async function showIdea(id) {
  $('#list-view').hidden = true;
  $('#form').hidden = true;
  const view = $('#idea-view');
  view.hidden = false;
  scrollTo(0, 0);

  const cached = findIdea(id);
  // Show the preview right away while the full idea loads.
  state.current = cached ? { ...cached, thread: null } : null;
  renderIdea();
  try {
    const idea = await api('GET', `/api/ideas/${id}`);
    if (location.pathname !== '/i/' + id) return;
    state.current = idea;
    document.title = `${idea.title} · ${state.name}`;
  } catch {
    state.current = null;
    state.missing = true;
  }
  renderIdea();
}

// --- wall ---

function visible() {
  const q = state.q.toLowerCase();
  return state.ideas
    .filter(i => (!state.cat || i.category === state.cat)
      && (!q || `${i.title} ${i.body} ${i.author}`.toLowerCase().includes(q)))
    .sort(SORTS[state.sort]);
}

function voteBox(i) {
  return `<div class="vote">
      <button data-v="1" class="${i.my === 1 ? 'on' : ''}" aria-label="Upvote">+</button>
      <b>${i.score}</b>
      <button data-v="-1" class="${i.my === -1 ? 'on' : ''}" aria-label="Downvote">&minus;</button>
    </div>`;
}

function tags(i) {
  return `<div class="meta">
        <button class="tag" data-cat="${esc(i.category)}">${esc(i.category)}</button>
        ${i.status ? `<span class="tag status">${esc(i.status)}</span>` : ''}
      </div>`;
}

function card(i) {
  return `<li class="idea${i.status ? ' s-' + i.status : ''}" data-id="${i.id}">
    ${voteBox(i)}
    <div class="main">
      ${tags(i)}
      <h2><a href="/i/${i.id}" data-nav>${esc(i.title)}</a></h2>
      ${i.body ? `<p class="preview">${esc(i.body)}</p>` : ''}
      <div class="meta muted">
        <span>${esc(i.author || 'anon')}</span>&middot;<span>${ago(i.created)}</span>${i.comments ? `&middot;<span>${plural(i.comments, 'comment')}</span>` : ''}
      </div>
    </div>
  </li>`;
}

function render() {
  const list = visible();
  const total = state.ideas.length;
  $('#count').textContent = list.length === total
    ? plural(total, 'idea')
    : `${list.length} of ${total}`;
  $('#wall').innerHTML = list.length
    ? list.slice(0, state.shown).map(card).join('')
    : `<li class="empty muted">${total ? 'Nothing here.' : 'No ideas yet. Be the first.'}</li>`;
  $('#more').hidden = list.length <= state.shown;

  for (const b of document.querySelectorAll('#sort button')) b.classList.toggle('on', b.dataset.sort === state.sort);
  for (const b of document.querySelectorAll('#cats button')) b.classList.toggle('on', b.dataset.c === state.cat);
}

function setFilter(changes) {
  Object.assign(state, changes, { shown: PAGE });
  render();
}

// --- idea page ---

function comment(c) {
  const del = state.admin ? `&middot;<button class="link danger" data-del-comment="${c.id}">delete</button>` : '';
  return `<li>
    <div class="meta muted"><span class="who">${esc(c.author || 'anon')}</span>&middot;<span>${ago(c.created)}</span>${del}</div>
    <p class="text">${esc(c.body)}</p>
  </li>`;
}

function renderIdea() {
  const view = $('#idea-view');
  const i = state.current;
  if (!i) {
    view.innerHTML = `<button class="link" data-back>Back</button>
      <p class="empty muted">${state.missing ? 'This idea does not exist.' : 'Loading'}</p>`;
    state.missing = false;
    return;
  }
  const admin = state.admin ? `<span class="admin">
      <select data-status>${state.statuses.map(s =>
        `<option value="${s}"${s === i.status ? ' selected' : ''}>${s || 'status'}</option>`).join('')}</select>
      <button class="link danger" data-del>delete</button></span>` : '';
  const thread = i.thread
    ? (i.thread.length ? `<ol class="comments">${i.thread.map(comment).join('')}</ol>` : '')
    : '<p class="muted">Loading</p>';

  view.innerHTML = `<button class="link" data-back>Back</button>
    <article class="idea full${i.status ? ' s-' + i.status : ''}" data-id="${i.id}">
      ${voteBox(i)}
      <div class="main">
        ${tags(i)}
        <h1>${esc(i.title)}</h1>
        <div class="meta muted">
          <span class="who">${esc(i.author || 'anon')}</span>&middot;<span>${ago(i.created)}</span>&middot;<button class="link" data-copy>copy link</button>${admin}
        </div>
        ${i.body ? `<p class="text">${esc(i.body)}</p>` : ''}
      </div>
    </article>
    <h3>${plural(i.comments, 'comment')}</h3>
    ${thread}
    <form id="c-form">
      <textarea maxlength="2000" rows="3" placeholder="Add a comment" required></textarea>
      <div class="row">
        <input class="f-author" maxlength="16" pattern="[A-Za-z0-9_]{1,16}" placeholder="Minecraft name (optional)">
        <button class="primary">Comment</button>
      </div>
      <p class="err"></p>
    </form>`;
  view.querySelector('.f-author').value = store.get('author');
}

function updateIdea(id, data) {
  for (const i of [findIdea(id), state.current?.id === id && state.current]) {
    if (i) Object.assign(i, data);
  }
}

// --- loading ---

async function load() {
  const data = await api('GET', '/api/ideas');
  Object.assign(state, {
    name: data.name, ideas: data.ideas, categories: data.categories,
    statuses: data.statuses, admin: data.admin,
  });
}

async function init() {
  try {
    await load();
  } catch {
    $('#count').textContent = 'Could not load ideas. Refresh to try again.';
    return;
  }
  $('#name').textContent = state.name;
  $('#f-cat').insertAdjacentHTML('beforeend',
    state.categories.map(c => `<option>${esc(c)}</option>`).join(''));
  $('#cats').innerHTML = `<button data-c="">All</button>` +
    state.categories.map(c => `<button data-c="${esc(c)}">${esc(c)}</button>`).join('');
  $('#form .f-author').value = store.get('author');
  route();
}

// --- events ---

async function submit(form, send) {
  const btn = form.querySelector('button.primary');
  const err = form.querySelector('.err');
  const author = form.querySelector('.f-author').value.trim();
  btn.disabled = true;
  err.textContent = '';
  try {
    await send(author);
    store.set('author', author);
  } catch (e) {
    err.textContent = e.message;
  } finally {
    btn.disabled = false;
  }
}

$('#new').onclick = () => {
  if ($('#list-view').hidden) go('/');
  const f = $('#form');
  f.hidden = !f.hidden;
  if (!f.hidden) $('#f-cat').focus();
};

$('#form').onsubmit = e => {
  e.preventDefault();
  submit(e.target, async author => {
    const idea = await api('POST', '/api/ideas', {
      category: $('#f-cat').value,
      title: $('#f-title').value,
      body: $('#f-body').value,
      author,
    });
    state.ideas.push(idea);
    e.target.reset();
    e.target.hidden = true;
    go('/i/' + idea.id);
    toast('Posted');
  });
};

$('#sort').onclick = e => {
  const s = e.target.dataset.sort;
  if (!s) return;
  store.set('sort', s);
  setFilter({ sort: s });
};
$('#cats').onclick = e => {
  if (e.target.dataset.c !== undefined) setFilter({ cat: e.target.dataset.c });
};
$('#q').oninput = e => setFilter({ q: e.target.value.trim() });
$('#more').onclick = () => { state.shown += PAGE; render(); };

document.addEventListener('click', async e => {
  const t = e.target;
  const box = t.closest('[data-id]');
  const id = box?.dataset.id;

  // In-page links; ctrl/middle click still opens a new tab.
  const link = t.closest('a[data-nav]');
  if (link) {
    if (e.button || e.ctrlKey || e.metaKey || e.shiftKey) return;
    e.preventDefault();
    go(link.getAttribute('href'));
    return;
  }

  if (t.dataset.v && id) {
    const idea = findIdea(id) || state.current;
    const prev = { score: idea.score, my: idea.my };
    let v = Number(t.dataset.v);
    if (idea.my === v) v = 0;
    updateIdea(id, { score: idea.score + v - idea.my, my: v });
    box.querySelector('.vote').outerHTML = voteBox(idea);
    try {
      const res = await api('POST', `/api/ideas/${id}/vote`, { v });
      updateIdea(id, { score: res.score, my: res.my });
    } catch (err) {
      updateIdea(id, prev);
      toast(err.message);
    }
    box.querySelector('.vote').outerHTML = voteBox(idea);
  } else if (t.dataset.cat !== undefined) {
    state.listScroll = 0;
    Object.assign(state, { cat: t.dataset.cat, shown: PAGE });
    if ($('#list-view').hidden) go('/');
    else { render(); scrollTo(0, 0); }
  } else if (t.matches('[data-back]')) {
    if (state.fromList) history.back();
    else go('/');
  } else if (t.matches('[data-copy]')) {
    try {
      await navigator.clipboard.writeText(location.href);
      toast('Link copied');
    } catch {
      toast(location.href);
    }
  } else if (t.matches('[data-del]')) {
    if (!confirm('Delete this idea?')) return;
    try {
      await api('DELETE', `/api/ideas/${id}`);
      state.ideas = state.ideas.filter(i => i.id !== id);
      go('/');
    } catch (err) {
      toast(err.message);
    }
  } else if (t.dataset.delComment) {
    if (!confirm('Delete this comment?')) return;
    try {
      await api('DELETE', `/api/comments/${t.dataset.delComment}`);
      const c = state.current;
      c.thread = c.thread.filter(x => x.id !== t.dataset.delComment);
      updateIdea(c.id, { comments: c.comments - 1 });
      renderIdea();
    } catch (err) {
      toast(err.message);
    }
  } else if (box?.matches('#wall .idea') && !t.closest('button, a, select, .vote')) {
    // Clicking anywhere on a card opens it.
    go('/i/' + id);
  }
});

$('#idea-view').addEventListener('submit', e => {
  e.preventDefault();
  const c = state.current;
  submit(e.target, async author => {
    const body = e.target.querySelector('textarea').value;
    const added = await api('POST', `/api/ideas/${c.id}/comments`, { body, author });
    c.thread.push(added);
    updateIdea(c.id, { comments: c.comments + 1 });
    renderIdea();
  });
});

$('#idea-view').addEventListener('change', async e => {
  if (!e.target.matches('[data-status]')) return;
  const c = state.current;
  try {
    const res = await api('POST', `/api/ideas/${c.id}/status`, { status: e.target.value });
    updateIdea(c.id, { status: res.status });
  } catch (err) {
    toast(err.message);
  }
  renderIdea();
});

window.addEventListener('popstate', () => {
  state.fromList = false;
  route();
});

// Pick up new ideas and votes when coming back to the tab.
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState !== 'visible' || !state.categories.length || $('#list-view').hidden) return;
  try {
    await load();
    render();
  } catch {}
});

init();
