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
const adminToken = store.get('admin');

const state = {
  ideas: [], categories: [], statuses: [], admin: false,
  sort: store.get('sort') || 'hot', cat: '', q: '', shown: PAGE,
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

// --- rendering ---

function visible() {
  const q = state.q.toLowerCase();
  return state.ideas
    .filter(i => (!state.cat || i.category === state.cat)
      && (!q || `${i.title} ${i.body} ${i.author}`.toLowerCase().includes(q)))
    .sort(SORTS[state.sort]);
}

function card(i) {
  const admin = state.admin ? `<span class="admin">
      <select data-status>${state.statuses.map(s =>
        `<option value="${s}"${s === i.status ? ' selected' : ''}>${s || 'status'}</option>`).join('')}</select>
      <button data-del>delete</button></span>` : '';
  return `<li id="i-${i.id}" class="idea${i.status ? ' s-' + i.status : ''}" data-id="${i.id}">
    <div class="vote">
      <button data-v="1" class="${i.my === 1 ? 'on' : ''}" aria-label="Upvote">+</button>
      <b>${i.score}</b>
      <button data-v="-1" class="${i.my === -1 ? 'on' : ''}" aria-label="Downvote">&minus;</button>
    </div>
    <div class="main">
      <div class="meta">
        <button class="tag" data-cat="${esc(i.category)}">${esc(i.category)}</button>
        ${i.status ? `<span class="tag status">${esc(i.status)}</span>` : ''}
      </div>
      <h2>${esc(i.title)}</h2>
      ${i.body ? `<p class="body">${esc(i.body)}</p>` : ''}
      <div class="meta muted">
        <span>${esc(i.author || 'anon')}</span>&middot;<span>${ago(i.created)}</span>&middot;<a href="#i-${i.id}" data-link>link</a>${admin}
      </div>
    </div>
  </li>`;
}

function render() {
  const list = visible();
  const total = state.ideas.length;
  $('#count').textContent = list.length === total
    ? `${total} idea${total === 1 ? '' : 's'}`
    : `${list.length} of ${total}`;
  $('#wall').innerHTML = list.length
    ? list.slice(0, state.shown).map(card).join('')
    : `<li class="empty muted">${total ? 'Nothing here.' : 'No ideas yet. Be the first.'}</li>`;
  $('#more').hidden = list.length <= state.shown;

  for (const b of document.querySelectorAll('#sort button')) b.classList.toggle('on', b.dataset.sort === state.sort);
  for (const b of document.querySelectorAll('#cats button')) b.classList.toggle('on', b.dataset.c === state.cat);
}

function rerenderCard(i) {
  const el = document.getElementById('i-' + i.id);
  if (!el) return;
  const open = el.querySelector('.body.open');
  el.outerHTML = card(i);
  if (open) document.querySelector(`#i-${i.id} .body`).classList.add('open');
}

function setFilter(changes) {
  Object.assign(state, changes, { shown: PAGE });
  render();
}

// --- loading ---

async function load() {
  const data = await api('GET', '/api/ideas');
  Object.assign(state, {
    ideas: data.ideas, categories: data.categories, statuses: data.statuses, admin: data.admin,
  });
  return data;
}

async function init() {
  let data;
  try {
    data = await load();
  } catch (e) {
    $('#count').textContent = 'Could not load ideas. Refresh to try again.';
    return;
  }
  document.title = data.name;
  $('#name').textContent = data.name;
  $('#f-cat').insertAdjacentHTML('beforeend',
    data.categories.map(c => `<option>${esc(c)}</option>`).join(''));
  $('#cats').innerHTML = `<button data-c="">All</button>` +
    data.categories.map(c => `<button data-c="${esc(c)}">${esc(c)}</button>`).join('');
  $('#f-author').value = store.get('author');
  render();
  jumpToHash();
}

function jumpToHash() {
  const id = location.hash.match(/^#i-([a-f0-9]{8})$/)?.[1];
  if (!id || !state.ideas.some(i => i.id === id)) return;
  if (!document.getElementById('i-' + id)) setFilter({ cat: '', q: '', shown: Infinity });
  const el = document.getElementById('i-' + id);
  document.querySelectorAll('.hl').forEach(e => e.classList.remove('hl'));
  el.classList.add('hl');
  el.scrollIntoView({ block: 'center' });
}

// --- events ---

$('#new').onclick = () => {
  const f = $('#form');
  f.hidden = !f.hidden;
  if (!f.hidden) $('#f-cat').focus();
};

$('#form').onsubmit = async e => {
  e.preventDefault();
  const btn = e.target.querySelector('button');
  const author = $('#f-author').value.trim();
  btn.disabled = true;
  $('#f-err').textContent = '';
  try {
    const idea = await api('POST', '/api/ideas', {
      category: $('#f-cat').value,
      title: $('#f-title').value,
      body: $('#f-body').value,
      author,
    });
    store.set('author', author);
    state.ideas.push(idea);
    e.target.reset();
    $('#f-author').value = author;
    e.target.hidden = true;
    setFilter({ sort: 'new', cat: '', q: '' });
    $('#q').value = '';
    history.replaceState(null, '', '#i-' + idea.id);
    jumpToHash();
    toast('Posted');
  } catch (err) {
    $('#f-err').textContent = err.message;
  } finally {
    btn.disabled = false;
  }
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

$('#wall').onclick = async e => {
  const t = e.target;
  const li = t.closest('.idea');
  if (!li) return;
  const idea = state.ideas.find(i => i.id === li.dataset.id);

  if (t.dataset.v) {
    const prev = { score: idea.score, my: idea.my };
    let v = Number(t.dataset.v);
    if (idea.my === v) v = 0;
    idea.score += v - idea.my;
    idea.my = v;
    rerenderCard(idea);
    try {
      Object.assign(idea, await api('POST', `/api/ideas/${idea.id}/vote`, { v }));
    } catch (err) {
      Object.assign(idea, prev);
      toast(err.message);
    }
    rerenderCard(idea);
  } else if (t.dataset.cat !== undefined) {
    setFilter({ cat: t.dataset.cat });
    window.scrollTo({ top: 0 });
  } else if (t.matches('[data-link]')) {
    e.preventDefault();
    const url = location.origin + location.pathname + '#i-' + idea.id;
    history.replaceState(null, '', '#i-' + idea.id);
    try {
      await navigator.clipboard.writeText(url);
      toast('Link copied');
    } catch {
      toast(url);
    }
  } else if (t.classList.contains('body')) {
    t.classList.toggle('open');
  } else if (t.matches('[data-del]')) {
    if (!confirm('Delete this idea?')) return;
    try {
      await api('DELETE', `/api/ideas/${idea.id}`);
      state.ideas = state.ideas.filter(i => i !== idea);
      render();
    } catch (err) {
      toast(err.message);
    }
  }
};

$('#wall').onchange = async e => {
  if (!e.target.matches('[data-status]')) return;
  const li = e.target.closest('.idea');
  const idea = state.ideas.find(i => i.id === li.dataset.id);
  try {
    Object.assign(idea, await api('POST', `/api/ideas/${idea.id}/status`, { status: e.target.value }));
  } catch (err) {
    toast(err.message);
  }
  rerenderCard(idea);
};

window.addEventListener('hashchange', jumpToHash);

// Pick up new ideas and votes when coming back to the tab.
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState !== 'visible' || !state.categories.length) return;
  try {
    await load();
    render();
  } catch {}
});

init();
