import 'pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css';
import './style.css';
import { applyAppInfo } from './app-info.js';
import { currentUser, onUserChange, loginWithGoogle, logout } from './auth.js';
import { liveApi } from './api.js';
import { previewApi } from './preview.js';
import { renderMarkdown } from './markdown.js';
import { local } from './store.js';

const $ = (id) => document.getElementById(id);
const TZ = 'Asia/Seoul';
const timeFmt = new Intl.DateTimeFormat('ko-KR', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false });
const fullFmt = new Intl.DateTimeFormat('ko-KR', { timeZone: TZ, dateStyle: 'medium', timeStyle: 'short' });
const dayFmt = new Intl.DateTimeFormat('ko-KR', { timeZone: TZ, year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });
const keyFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const PALETTE = ['#ffdc1a', '#0abbee', '#02c245', '#ff614a', '#7e65c1', '#b0e7f8', '#fef1b8', '#a4e9bc'];

const S = {
  mode: null,          // 'live' | 'preview'
  api: null,
  me: null,
  members: [],
  channels: [],
  channelId: null,
  messages: [],
  threadOpen: false,
  threadParent: null,
  threadReplies: [],
  aiPending: false,
  aiPendingWhere: null,
  sending: false,
  starting: false,
  aiKeySet: true,
  hasSession: false,
  unsub: null,
  poll: null,
  reloadTimer: null,
  sig: '',
};

// ---------- 작은 도우미 ----------
const firstChar = (name) => {
  const s = String(name ?? '').trim();
  return s ? [...s][0] : '?';
};
const isSameDay = (a, b) => keyFmt.format(a) === keyFmt.format(b);
const dayKey = (iso) => keyFmt.format(new Date(iso));
const yesterday = () => new Date(Date.now() - 86_400_000);
function dayLabel(iso) {
  const d = new Date(iso);
  if (isSameDay(d, new Date())) return '오늘';
  if (isSameDay(d, yesterday())) return '어제';
  return dayFmt.format(d);
}
function colorOf(m) {
  const u = S.members.find((x) => x.id === m.user_id);
  if (u && u.avatar_color) return u.avatar_color;
  let h = 0;
  const s = String(m.author_name ?? '');
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}
let toastTimer = null;
function toast(msg, kind = '') {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast' + (kind === 'err' ? ' err' : '');
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 4600);
}
function showChatError(msg) {
  const e = $('chat-error');
  e.textContent = msg || '';
  e.hidden = !msg;
}
const currentChannel = () => S.channels.find((c) => c.id === S.channelId) || null;

// ---------- 그리기 ----------
function renderWho() {
  const w = $('who');
  w.textContent = '';
  if (!S.me) return;
  const av = el('span', 'who-av', firstChar(S.me.name));
  av.style.background = S.me.avatar_color || PALETTE[0];
  const nm = el('span', 'who-name', S.me.name);
  w.append(av, nm);
  w.title = S.me.email || '';
  w.hidden = false;
}

function sideItem({ label, hash, avatar, ai, active, onClick, title }) {
  const li = document.createElement('li');
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'side-item' + (active ? ' on' : '');
  if (title) b.title = title;
  if (avatar != null) {
    const a = el('span', 'side-av' + (ai ? ' ai' : ''), avatar);
    if (ai) a.style.background = '#ffdc1a';
    b.appendChild(a);
  } else {
    b.appendChild(el('span', 'hash', hash || '#'));
  }
  b.appendChild(el('span', 'nm', label));
  b.addEventListener('click', onClick);
  li.appendChild(b);
  return li;
}

function renderSidebar() {
  const chans = S.channels.filter((c) => c.kind === 'channel');
  const ais = S.channels.filter((c) => c.kind === 'ai');
  const dms = S.channels.filter((c) => c.kind === 'dm');

  const cl = $('channel-list');
  cl.textContent = '';
  for (const c of chans) {
    cl.appendChild(sideItem({
      label: c.name, hash: '#', active: c.id === S.channelId,
      onClick: () => selectChannel(c.id), title: c.description || '#' + c.name,
    }));
  }

  const al = $('ai-list');
  al.textContent = '';
  for (const c of ais) {
    al.appendChild(sideItem({
      label: 'Alter', avatar: 'AI', ai: true, active: c.id === S.channelId,
      onClick: () => selectChannel(c.id), title: 'Alter 와 1:1 대화',
    }));
  }

  const dl = $('dm-list');
  dl.textContent = '';
  const others = S.members.filter((m) => !S.me || m.id !== S.me.id);
  const used = new Set();
  for (const c of dms) {
    const who = others.find((m) => (c.dm_key || '').includes(m.id));
    if (who) used.add(who.id);
    dl.appendChild(sideItem({
      label: who ? who.name : c.name,
      avatar: firstChar(who ? who.name : c.name),
      active: c.id === S.channelId,
      onClick: () => selectChannel(c.id),
      title: who ? who.email : c.name,
    }));
  }
  for (const m of others) {
    if (used.has(m.id)) continue;
    dl.appendChild(sideItem({
      label: m.name, avatar: firstChar(m.name), active: false,
      onClick: () => openDmWith(m), title: (m.email || '') + ' · DM 열기',
    }));
  }
  if (!others.length) dl.appendChild(el('li', 'side-tip', '아직 함께하는 선생님이 없어요.'));

  $('preview-note').hidden = S.mode !== 'preview';
  $('side-tip').textContent = '';
  if (!S.aiKeySet && S.mode === 'live') {
    $('side-tip').textContent = '⚠️ AI 열쇠가 아직 없어 Alter 가 안내 문구로 답해요.';
  } else {
    const b = document.createElement('b');
    b.textContent = '@AI';
    $('side-tip').append('💡 메시지에서 ', b, ' 를 부르면 Alter 가 바로 답해요.');
  }
}

function renderHeader() {
  const c = currentChannel();
  const name = $('chan-name');
  const desc = $('chan-desc');
  name.textContent = '';
  if (!c) {
    name.textContent = '채널을 고르세요';
    desc.textContent = '';
    $('chan-kind').hidden = true;
    $('chan-count').textContent = '';
    return;
  }
  if (c.kind === 'channel') {
    name.append(el('span', 'hash', '#'), document.createTextNode(' ' + c.name));
    desc.textContent = c.description || '설명이 없는 채널이에요';
    $('chan-count').textContent = `${S.members.length}명`;
    $('chan-kind').hidden = true;
  } else if (c.kind === 'ai') {
    name.textContent = '🤖 Alter (AI)';
    desc.textContent = '나만의 AI 조력자 · 무엇이든 물어보세요';
    $('chan-kind').hidden = false;
    $('chan-kind').textContent = 'AI';
    $('chan-count').textContent = '';
  } else {
    name.textContent = c.name;
    desc.textContent = '1:1 다이렉트 메시지';
    $('chan-kind').hidden = true;
    $('chan-count').textContent = '';
  }
}

function messageEl(m, inThread = false) {
  const art = document.createElement('article');
  art.className = 'msg' + (m.pending ? ' pending' : '') + (S.me && m.user_id === S.me.id ? ' msg-mine' : '');
  art.dataset.id = String(m.id);

  const av = el('div', 'msg-av' + (m.author_kind === 'ai' ? ' ai' : ''), m.author_kind === 'ai' ? 'AI' : firstChar(m.author_name));
  if (m.author_kind !== 'ai') av.style.background = colorOf(m);

  const body = el('div', 'msg-body');
  const head = el('div', 'msg-head');
  head.appendChild(el('span', 'msg-name', m.author_name));
  const t = document.createElement('time');
  t.className = 'msg-time';
  t.dateTime = m.created_at;
  t.textContent = timeFmt.format(new Date(m.created_at));
  t.title = fullFmt.format(new Date(m.created_at));
  head.appendChild(t);
  if (m.author_kind === 'ai') head.appendChild(el('span', 'badge', 'AI'));
  if (m.source === 'preview') head.appendChild(el('span', 'msg-src', '예시 답변'));
  if (m.source === 'fallback') head.appendChild(el('span', 'msg-src', '안내'));
  if (m.pending) head.appendChild(el('span', 'msg-src', '보내는 중…'));
  body.appendChild(head);

  const text = el('div', 'msg-text');
  text.appendChild(renderMarkdown(m.content));
  body.appendChild(text);

  if (!inThread) {
    const n = Number(m.reply_count || 0);
    const btn = el('button', 'thread-btn' + (n > 0 ? ' has' : ''), n > 0 ? `💬 답글 ${n}개` : '↳ 스레드 열기');
    btn.type = 'button';
    btn.addEventListener('click', (e) => { e.stopPropagation(); openThread(m.id); });
    body.appendChild(btn);
  }

  art.append(av, body);
  return art;
}

function thinkingEl() {
  const art = el('article', 'msg-thinking');
  const av = el('div', 'msg-av ai', 'AI');
  const body = el('div', 'msg-body');
  const line = el('div', 'msg-thinking-line');
  const dots = el('span', 'dots');
  dots.append(el('i'), el('i'), el('i'));
  const lbl = el('span', 'lbl', currentChannel() && currentChannel().kind === 'ai' ? 'Alter 가 답을 쓰는 중…' : 'Alter 가 답글을 쓰는 중…');
  line.append(dots, lbl);
  body.appendChild(line);
  art.append(av, body);
  return art;
}

function dateSep(iso) {
  const d = el('div', 'date-sep');
  d.appendChild(el('span', null, dayLabel(iso)));
  return d;
}

function renderMessages(forceBottom = false) {
  const box = $('messages');
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 160;
  box.textContent = '';
  let last = '';
  for (const m of S.messages) {
    const k = dayKey(m.created_at);
    if (k !== last) { box.appendChild(dateSep(m.created_at)); last = k; }
    box.appendChild(messageEl(m));
  }
  if (S.aiPending && S.aiPendingWhere === 'channel') box.appendChild(thinkingEl());
  const empty = S.messages.length === 0 && !S.aiPending;
  $('chat-empty').hidden = !empty;
  if (forceBottom || nearBottom) box.scrollTop = box.scrollHeight;
}

function renderThread() {
  const pane = $('thread');
  const ws = $('workspace');
  pane.hidden = !S.threadOpen;
  ws.classList.toggle('thread-open', S.threadOpen);
  if (!S.threadOpen) return;
  const p = $('thread-parent');
  p.textContent = '';
  if (S.threadParent) p.appendChild(messageEl(S.threadParent, true));
  const n = S.threadReplies.length;
  $('thread-count').textContent = n ? `답글 ${n}개` : '첫 답글을 남겨 보세요';
  const r = $('thread-replies');
  r.textContent = '';
  for (const m of S.threadReplies) r.appendChild(messageEl(m, true));
  if (S.aiPending && S.aiPendingWhere === 'thread') r.appendChild(thinkingEl());
  const body = document.querySelector('.thread-body');
  if (body) body.scrollTop = body.scrollHeight;
}

function renderAll() {
  renderWho();
  renderSidebar();
  renderHeader();
  renderMessages();
  renderThread();
}

// ---------- 데이터 ----------
function mergePending(list) {
  const pending = S.messages.filter((m) => m.pending);
  return pending.some((p) => p.parent_id === null) ? [...list, ...pending.filter((p) => p.parent_id === null)] : list;
}

function currentSig() {
  const a = S.messages.map((m) => m.id + ':' + (m.reply_count || 0) + (m.pending ? 'p' : '')).join(',');
  const t = S.threadOpen && S.threadParent ? S.threadReplies.map((m) => m.id + (m.pending ? 'p' : '')).join(',') : '';
  return a + '|' + t;
}

async function reload({ silent = true } = {}) {
  if (!S.channelId || !S.api) return;
  const id = S.channelId;
  try {
    const res = await S.api.messages(id);
    if (S.channelId !== id) return;
    S.messages = mergePending(res.messages || []);
    let t = null;
    if (S.threadOpen && S.threadParent && typeof S.threadParent.id === 'number') {
      t = await S.api.thread(id, S.threadParent.id);
      if (S.channelId !== id || !S.threadOpen) return;
      S.threadParent = t.parent;
      S.threadReplies = t.messages || [];
    }
    showChatError('');
    const sig = currentSig();
    if (sig !== S.sig) {
      S.sig = sig;
      renderMessages();
      if (t) renderThread();
    }
  } catch (e) {
    if (!silent) showChatError(e.message || '메시지를 불러오지 못했어요.');
  }
}

async function selectChannel(id) {
  if (!S.channels.some((c) => c.id === id)) return;
  S.channelId = id;
  S.threadOpen = false;
  S.threadParent = null;
  S.threadReplies = [];
  S.aiPending = false;
  S.aiPendingWhere = null;
  S.messages = [];
  S.sig = '';
  local.set('last-channel', id);
  closeSidebar();
  renderSidebar();
  renderHeader();
  updateComposer();
  renderThread();
  renderMessages(true);
  showChatError('');
  await reload({ silent: false });
}

async function openDmWith(member) {
  const existing = S.channels.find((c) => c.kind === 'dm' && (c.dm_key || '').includes(member.id));
  if (existing) { await selectChannel(existing.id); return; }
  try {
    const res = await S.api.openDm(member.id);
    if (!S.channels.some((c) => c.id === res.channel.id)) S.channels.push(res.channel);
    await selectChannel(res.channel.id);
    toast(`${member.name} 님과의 DM 을 열었어요.`);
  } catch (e) {
    toast(e.message || 'DM 을 열지 못했어요.', 'err');
  }
}

async function openThread(parentId) {
  if (typeof parentId !== 'number') return;
  const cached = S.messages.find((m) => m.id === parentId) || null;
  S.threadOpen = true;
  S.threadParent = cached;
  S.threadReplies = [];
  renderThread();
  try {
    const res = await S.api.thread(S.channelId, parentId);
    if (!S.threadOpen || !S.threadParent || S.threadParent.id !== parentId) return;
    S.threadParent = res.parent;
    S.threadReplies = res.messages || [];
    renderThread();
  } catch (e) {
    toast(e.message || '스레드를 불러오지 못했어요.', 'err');
  }
}

function closeThread() {
  if (!S.threadOpen) return;
  S.threadOpen = false;
  S.threadParent = null;
  S.threadReplies = [];
  renderThread();
}

// ---------- 보내기 ----------
function autoGrow(ta) {
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, 200) + 'px';
}
function updateComposer() {
  const ch = $('composer-input');
  const th = $('thread-input');
  $('send').disabled = S.sending || !ch.value.trim() || !S.channelId;
  $('thread-send').disabled = S.sending || !th.value.trim() || !S.threadParent;
  $('composer-input').placeholder = currentChannel()
    ? (currentChannel().kind === 'channel' ? `#${currentChannel().name} 에 메시지 보내기` : `${currentChannel().name} 에 메시지 보내기`)
    : '메시지 보내기';
}

async function send(inThread) {
  const ta = $(inThread ? 'thread-input' : 'composer-input');
  const text = ta.value.trim();
  if (!text || S.sending || !S.channelId) return;
  if (inThread && !S.threadParent) return;
  const channelId = S.channelId;
  const parentId = inThread ? S.threadParent.id : null;
  const ch = currentChannel();
  const aiExpected = (ch && ch.kind === 'ai') || /@\s?(ai|alter)\b/i.test(text);

  S.sending = true;
  updateComposer();
  ta.value = '';
  autoGrow(ta);

  const tmp = {
    id: 'tmp-' + Date.now(), channel_id: channelId, parent_id: parentId, user_id: S.me.id,
    author_name: S.me.name, author_kind: 'user', content: text, created_at: new Date().toISOString(),
    reply_count: 0, pending: true,
  };
  if (inThread) { S.threadReplies.push(tmp); renderThread(); }
  else { S.messages.push(tmp); renderMessages(true); }
  if (aiExpected) {
    S.aiPending = true;
    S.aiPendingWhere = inThread ? 'thread' : 'channel';
    if (inThread) renderThread(); else renderMessages();
  }
  S.sig = currentSig();

  try {
    const res = await S.api.post({ channelId, content: text, parentId });
    S.aiPending = false;
    S.aiPendingWhere = null;
    if (inThread) S.threadReplies = S.threadReplies.filter((m) => m !== tmp);
    else S.messages = S.messages.filter((m) => m !== tmp);
    if (res.ai_error) toast(res.ai_error, 'err');
    if (res.ai && res.ai.source === 'fallback') toast('AI 열쇠가 아직 없어서 안내 문구로 답했어요.', 'err');
    await reload();
    if (inThread) renderThread();
  } catch (e) {
    S.aiPending = false;
    S.aiPendingWhere = null;
    if (inThread) S.threadReplies = S.threadReplies.filter((m) => m !== tmp);
    else S.messages = S.messages.filter((m) => m !== tmp);
    renderMessages();
    renderThread();
    ta.value = text;
    autoGrow(ta);
    toast(e.message || '보내지 못했어요. 잠시 뒤 다시 시도해 주세요.', 'err');
    if (e.status === 401) showLogin('로그인이 만료되었습니다. 다시 로그인해 주세요.', true);
  } finally {
    S.sending = false;
    updateComposer();
    ta.focus();
  }
}

// ---------- 화면 전환 ----------
function showBoot() {
  $('boot').hidden = false;
  $('login').hidden = true;
  $('workspace').hidden = true;
}
function showLogin(msg = '', isErr = false) {
  $('boot').hidden = true;
  $('workspace').hidden = true;
  $('login').hidden = false;
  const m = $('login-msg');
  if (msg) {
    m.textContent = msg;
    m.hidden = false;
    m.classList.toggle('err', !!isErr);
  } else {
    m.hidden = true;
    m.textContent = '';
  }
  $('who').hidden = true;
  $('logout').hidden = true;
  $('conn').hidden = true;
  $('login-logout').hidden = !S.hasSession;
}

function teardown() {
  if (S.unsub) { try { S.unsub(); } catch { /* 무시 */ } S.unsub = null; }
  if (S.poll) { clearInterval(S.poll); S.poll = null; }
  if (S.reloadTimer) { clearTimeout(S.reloadTimer); S.reloadTimer = null; }
  S.mode = null;
  S.api = null;
  S.me = null;
  S.members = [];
  S.channels = [];
  S.channelId = null;
  S.messages = [];
  S.threadOpen = false;
  S.threadParent = null;
  S.threadReplies = [];
  S.aiPending = false;
  S.aiPendingWhere = null;
  S.sending = false;
  S.aiKeySet = true;
  S.starting = false;
  S.sig = '';
  S.hasSession = false;
}

function enter(data, mode) {
  S.mode = mode;
  S.me = data.me;
  S.members = data.members || [];
  S.channels = data.channels || [];
  S.aiKeySet = data.gemini_key_set !== false;
  S.hasSession = mode === 'live';
  S.sig = '';
  $('boot').hidden = true;
  $('login').hidden = true;
  $('workspace').hidden = false;
  $('logout').hidden = false;
  $('logout').textContent = mode === 'preview' ? '미리보기 끝내기' : '로그아웃';
  $('conn').hidden = false;
  $('conn').classList.toggle('preview', mode === 'preview');
  $('conn-text').textContent = mode === 'preview' ? '미리보기' : '연결됨';
  renderWho();
  renderSidebar();
  updateComposer();

  const saved = Number(local.get('last-channel', 0));
  const first = S.channels.find((c) => c.kind === 'channel') || S.channels[0];
  const pick = S.channels.find((c) => c.id === saved) || first;
  if (pick) selectChannel(pick.id);
  else renderHeader();

  if (mode === 'live') {
    S.unsub = S.api.subscribe(() => {
      clearTimeout(S.reloadTimer);
      S.reloadTimer = setTimeout(() => { reload(); }, 350);
    });
    S.poll = setInterval(() => {
      if (document.visibilityState === 'visible') reload();
    }, 5000);
  }
}

async function startLive() {
  if (S.starting || S.mode === 'live') return;
  S.starting = true;
  showBoot();
  S.api = liveApi;
  S.hasSession = true;
  try {
    const data = await liveApi.bootstrap();
    S.mode = 'live';
    enter(data, 'live');
  } catch (e) {
    S.api = null;
    let msg = e.message || '워크스페이스를 열지 못했어요.';
    if (e.status === 404 || e.status === 500 || e.status === 503 || e.status === 0) {
      msg = `서버 함수가 아직 준비되지 않았어요. (${msg}) 아래 '미리보기로 둘러보기' 로 화면을 먼저 확인하실 수 있어요.`;
    }
    showLogin(msg, true);
  } finally {
    S.starting = false;
  }
}

async function startPreview() {
  if (S.starting) return;
  S.starting = true;
  showBoot();
  S.api = previewApi;
  try {
    const data = await previewApi.bootstrap();
    enter(data, 'preview');
  } catch (e) {
    showLogin(e.message || '미리보기를 열지 못했어요.', true);
  } finally {
    S.starting = false;
  }
}

function exitPreview() {
  previewApi.reset();
  teardown();
  showLogin();
}

// ---------- 사이드바(모바일) ----------
function openSidebar() {
  $('sidebar').classList.add('open');
  $('backdrop').hidden = false;
  $('open-sidebar').setAttribute('aria-expanded', 'true');
}
function closeSidebar() {
  $('sidebar').classList.remove('open');
  $('backdrop').hidden = true;
  $('open-sidebar').setAttribute('aria-expanded', 'false');
}

// ---------- 이벤트 ----------
function bind() {
  $('google-login').addEventListener('click', async () => {
    try {
      const { error } = await loginWithGoogle();
      if (error) toast(error.message || '구글 로그인을 열지 못했어요.', 'err');
    } catch (e) {
      toast(e.message || '구글 로그인을 열지 못했어요.', 'err');
    }
  });
  $('preview-login').addEventListener('click', () => startPreview());

  $('login-logout').addEventListener('click', async () => {
    try { await logout(); } catch { /* 무시 */ }
    teardown();
    showLogin();
  });

  $('logout').addEventListener('click', async () => {
    if (S.mode === 'preview') { exitPreview(); return; }
    try {
      await logout();
    } catch (e) {
      toast(e.message || '로그아웃하지 못했어요.', 'err');
    }
    teardown();
    showLogin();
  });

  $('open-sidebar').addEventListener('click', openSidebar);
  $('backdrop').addEventListener('click', closeSidebar);
  $('close-thread').addEventListener('click', closeThread);

  $('new-channel').addEventListener('click', () => {
    const form = $('new-channel-form');
    form.hidden = false;
    $('new-channel-name').focus();
  });
  $('new-channel-cancel').addEventListener('click', () => {
    $('new-channel-form').hidden = true;
    $('new-channel-form').reset();
  });
  $('new-channel-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = $('new-channel-name').value.trim();
    const description = $('new-channel-desc').value.trim();
    if (!name) return;
    const btn = e.target.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      const res = await S.api.createChannel({ name, description });
      if (!S.channels.some((c) => c.id === res.channel.id)) S.channels.push(res.channel);
      $('new-channel-form').hidden = true;
      $('new-channel-form').reset();
      renderSidebar();
      await selectChannel(res.channel.id);
      toast(`#${res.channel.name} 채널을 만들었어요.`);
    } catch (err) {
      toast(err.message || '채널을 만들지 못했어요.', 'err');
    } finally {
      btn.disabled = false;
    }
  });

  $('composer').addEventListener('submit', (e) => { e.preventDefault(); send(false); });
  $('thread-composer').addEventListener('submit', (e) => { e.preventDefault(); send(true); });

  for (const [id, isThread] of [['composer-input', false], ['thread-input', true]]) {
    const ta = $(id);
    ta.addEventListener('input', () => { autoGrow(ta); updateComposer(); });
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        send(isThread);
      }
    });
  }

  const insertMention = (ta) => {
    const at = ta.selectionStart ?? ta.value.length;
    const before = ta.value.slice(0, at);
    const need = before && !/\s$/.test(before) ? ' ' : '';
    ta.value = before + need + '@AI ' + ta.value.slice(ta.selectionEnd ?? at);
    ta.focus();
    ta.selectionStart = ta.selectionEnd = ta.value.length;
    autoGrow(ta);
    updateComposer();
  };
  $('insert-ai').addEventListener('click', () => insertMention($('composer-input')));
  $('thread-insert-ai').addEventListener('click', () => insertMention($('thread-input')));

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (S.threadOpen) closeThread();
    else if ($('sidebar').classList.contains('open')) closeSidebar();
  });
  window.addEventListener('online', () => { $('conn').classList.remove('off'); reload(); });
  window.addEventListener('offline', () => { $('conn').classList.add('off'); });
}

function authRedirectError() {
  const h = new URLSearchParams(location.hash.replace(/^#/, ''));
  const d = h.get('error_description') || h.get('error');
  if (!d) return '';
  history.replaceState(null, '', location.pathname + location.search);
  return `로그인에 실패했어요: ${d}`;
}

// ---------- 시작 ----------
async function boot() {
  applyAppInfo(' · BMR APPS');
  bind();
  const err = authRedirectError();
  if (err) showLogin(err, true);
  let user = null;
  try { user = await currentUser(); } catch { user = null; }
  if (user) await startLive();
  else if (!err) showLogin();

  onUserChange((u) => {
    if (S.mode === 'preview') return;
    if (u) {
      if (S.mode !== 'live' || !S.me) startLive();
    } else if (S.mode === 'live') {
      teardown();
      showLogin('로그아웃되었습니다.');
    }
  });
}

boot();
