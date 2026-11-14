import 'pretendard/dist/web/variable/pretendardvariable-dynamic-subset.css';
import './style.css';
import { applyAppInfo } from './app-info.js';
import { currentUser, onUserChange, loginWithGoogle, logout } from './auth.js';
import { liveApi } from './api.js';
import { previewApi } from './preview.js';
import { FN_URL } from './supabase.js';
import { Huddle } from './huddle.js';
import { renderMarkdown } from './markdown.js';
import { local } from './store.js';
import {
  MAX_FILES, MAX_FILE_BYTES, isImage, formatSize, previewAttachment, uploadAttachment, removeUploaded, fileUrl,
} from './files.js';

const $ = (id) => document.getElementById(id);
const TZ = 'Asia/Seoul';
const timeFmt = new Intl.DateTimeFormat('ko-KR', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false });
const fullFmt = new Intl.DateTimeFormat('ko-KR', { timeZone: TZ, dateStyle: 'medium', timeStyle: 'short' });
const dayFmt = new Intl.DateTimeFormat('ko-KR', { timeZone: TZ, year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });
const keyFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const PALETTE = ['#ffdc1a', '#0abbee', '#02c245', '#ff614a', '#7e65c1', '#b0e7f8', '#fef1b8', '#a4e9bc'];
const BASE_PATH = import.meta.env.BASE_URL;

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
  unread: {},
  pending: { channel: [], thread: [] }, // 아직 보내지 않은 첨부
  uploading: false,
  baseTitle: '별무리 워크스페이스 · BMR APPS',
  unsub: null,
  poll: null,
  reloadTimer: null,
  sig: '',
  tokens: [],
  newToken: '',
  huddle: null,
  huddleChannelId: null,
  huddleBig: false,
  huddleCompact: false,
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

// ---------- 사진·파일 첨부 ----------
const pendingOf = (inThread) => (inThread ? S.pending.thread : S.pending.channel);

/** 텍스트 칸·화면에 고른 파일을 더한다 (한 번에 5개, 한 개 10MB 까지) */
function addFiles(fileList, inThread) {
  const list = pendingOf(inThread);
  let added = 0;
  for (const f of Array.from(fileList || [])) {
    if (!f) continue;
    if (list.length >= MAX_FILES) { toast(`첨부는 한 번에 ${MAX_FILES}개까지예요.`, 'err'); break; }
    if (f.size > MAX_FILE_BYTES) { toast(`«${f.name || '파일'}» 은(는) 10MB를 넘어 첨부할 수 없어요.`, 'err'); continue; }
    if (f.size === 0) { toast(`«${f.name || '파일'}» 이(가) 비어 있어요.`, 'err'); continue; }
    list.push({
      id: 'f-' + Math.random().toString(36).slice(2, 9),
      file: f, name: f.name || '파일', mime: f.type || '', size: f.size,
      preview: isImage(f.type) ? URL.createObjectURL(f) : '',
      state: 'ready', att: null,
    });
    added++;
  }
  if (!added) return;
  renderPending(inThread);
  updateComposer();
}

function dropPending(item, inThread) {
  const list = pendingOf(inThread);
  const i = list.indexOf(item);
  if (i >= 0) list.splice(i, 1);
  if (item.preview) { try { URL.revokeObjectURL(item.preview); } catch { /* 무시 */ } }
  renderPending(inThread);
  updateComposer();
}

function clearPending(inThread) {
  for (const item of pendingOf(inThread)) {
    if (item.preview) { try { URL.revokeObjectURL(item.preview); } catch { /* 무시 */ } }
  }
  S.pending[inThread ? 'thread' : 'channel'] = [];
  renderPending(inThread);
  updateComposer();
}

/** 보내기 전 고른 파일 미리보기 줄 */
function renderPending(inThread) {
  const box = $(inThread ? 'thread-files' : 'composer-files');
  if (!box) return;
  const list = pendingOf(inThread);
  box.textContent = '';
  box.hidden = list.length === 0;
  for (const item of list) {
    const chip = el('div', 'att-chip' + (item.state === 'uploading' ? ' busy' : ''));
    if (item.preview) {
      const im = document.createElement('img');
      im.className = 'att-chip-img';
      im.src = item.preview;
      im.alt = '';
      chip.appendChild(im);
    } else {
      chip.appendChild(el('span', 'att-chip-ico', '📄'));
    }
    const meta = el('div', 'att-chip-meta');
    meta.appendChild(el('b', 'att-chip-name', item.name));
    const state = item.state === 'uploading' ? '올리는 중…' : item.state === 'done' ? '올림' : formatSize(item.size);
    meta.appendChild(el('span', 'att-chip-size', state));
    chip.appendChild(meta);
    const x = el('button', 'att-chip-x', '✕');
    x.type = 'button';
    x.title = '첨부 빼기';
    x.setAttribute('aria-label', `${item.name} 첨부 빼기`);
    x.disabled = item.state === 'uploading';
    x.addEventListener('click', () => dropPending(item, inThread));
    chip.appendChild(x);
    box.appendChild(chip);
  }
}

// ---------- 사진 크게 보기 ----------
function openLightbox(url, att) {
  if (!url) return;
  const img = $('lightbox-img');
  img.src = url;
  img.alt = (att && att.name) || '사진';
  $('lightbox-name').textContent = (att && att.name) || '';
  $('lightbox-open').href = url;
  const dl = $('lightbox-download');
  dl.href = url;
  if (att && att.url) dl.download = att.name || '사진';
  else dl.removeAttribute('download');
  if (att && !att.url) {
    dl.href = '#';
    fileUrl(att, { download: true }).then((u) => { dl.href = u; }).catch(() => { dl.removeAttribute('href'); });
  }
  $('lightbox').hidden = false;
}
function closeLightbox() {
  const box = $('lightbox');
  if (!box || box.hidden) return;
  box.hidden = true;
  $('lightbox-img').src = '';
}

/** 메시지 안의 사진·파일 — 사진은 바로 보이고, 파일은 내려받는 카드 */
function attachmentsEl(atts) {
  const wrap = el('div', 'msg-atts');
  for (const att of atts) {
    if (!att || !att.path) continue;
    if (isImage(att.mime)) {
      const btn = el('button', 'att-img');
      btn.type = 'button';
      btn.setAttribute('aria-label', `${att.name || '사진'} — 크게 보기`);
      const ph = el('span', 'att-img-ph', '🖼️');
      const img = document.createElement('img');
      img.alt = att.name || '사진';
      img.loading = 'lazy';
      img.decoding = 'async';
      img.hidden = true;
      btn.append(ph, img);
      const cap = el('span', 'att-img-cap', att.name || '');
      btn.appendChild(cap);
      btn.addEventListener('click', () => {
        if (img.src) { openLightbox(img.src, att); return; }
        toast('사진을 불러오는 중이에요. 잠시 뒤 다시 눌러 주세요.');
      });
      fileUrl(att).then((u) => { img.src = u; img.hidden = false; ph.hidden = true; })
        .catch(() => { ph.textContent = '🖼️ 사진을 불러오지 못했어요'; btn.disabled = true; });
      wrap.appendChild(btn);
    } else {
      const a = el('a', 'att-file');
      a.target = '_blank';
      a.rel = 'noreferrer noopener';
      if (att.url) a.download = att.name || '파일'; // 미리보기(blob 주소)는 새 탭을 못 열어 내려받기로 처리
      a.setAttribute('aria-label', `${att.name || '파일'} 내려받기 (${formatSize(att.size)})`);
      a.append(el('span', 'att-file-ico', '📄'));
      const meta = el('span', 'att-file-meta');
      meta.appendChild(el('b', 'att-file-name', att.name || '파일'));
      meta.appendChild(el('span', 'att-file-size', formatSize(att.size)));
      a.appendChild(meta);
      a.addEventListener('click', (e) => {
        if (a.href && a.getAttribute('href') !== '#') return;
        e.preventDefault();
        if (a.dataset.busy) return;
        a.dataset.busy = '1';
        fileUrl(att, { download: true }).then((u) => { a.href = u; a.dataset.busy = ''; a.click(); })
          .catch(() => { a.dataset.busy = ''; toast('첨부 파일을 열지 못했어요.', 'err'); });
      });
      fileUrl(att, { download: true }).then((u) => { a.href = u; }).catch(() => { /* 누를 때 다시 시도 */ });
      wrap.appendChild(a);
    }
  }
  return wrap;
}

// ---------- 안 읽은 배지(채널·DM·제목·메뉴) ----------
function totalUnread() {
  return Object.values(S.unread || {}).reduce((a, b) => a + (Number(b) || 0), 0);
}
function updateUnreadUi() {
  const total = totalUnread();
  document.title = total > 0 ? `(${total > 99 ? '99+' : total}) 별무리 워크스페이스` : S.baseTitle;
  const mb = $('menu-badge');
  if (mb) {
    mb.hidden = total === 0;
    mb.textContent = total > 99 ? '99+' : String(total);
  }
}
function setUnreadMap(list) {
  const map = {};
  for (const u of list || []) {
    if (!u || u.channel_id == null) continue;
    map[Number(u.channel_id)] = Number(u.unread || 0);
  }
  // 지금 보고 있는 채널은 안 읽은 것이 없다
  if (S.channelId && document.visibilityState === 'visible') map[S.channelId] = 0;
  const changed = JSON.stringify(map) !== JSON.stringify(S.unread);
  S.unread = map;
  if (changed) renderSidebar();
  updateUnreadUi();
}
function bumpUnread(channelId) {
  if (!channelId) return;
  S.unread[channelId] = (S.unread[channelId] || 0) + 1;
  renderSidebar();
  updateUnreadUi();
}
function incoming(msg) {
  if (!msg || (S.me && msg.user_id === S.me.id)) return;
  const cid = Number(msg.channel_id);
  if (!cid) return;
  if (document.visibilityState === 'visible' && cid === S.channelId) { scheduleMarkRead(); return; }
  bumpUnread(cid);
}

// ---------- 읽음 처리 ----------
let markTimer = null;
function scheduleMarkRead() {
  clearTimeout(markTimer);
  markTimer = setTimeout(() => { if (S.channelId) markRead(S.channelId); }, 400);
}
async function markRead(channelId) {
  if (!channelId) return;
  if (S.unread[channelId]) {
    S.unread[channelId] = 0;
    renderSidebar();
    updateUnreadUi();
  }
  if (S.mode !== 'live' || !S.api) return;
  try { await S.api.markRead(channelId); } catch { /* 다음 폴링에서 다시 맞춘다 */ }
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

function sideItem({ label, hash, avatar, ai, active, onClick, title, unread }) {
  const li = document.createElement('li');
  const b = document.createElement('button');
  b.type = 'button';
  const n = Number(unread || 0);
  b.className = 'side-item' + (active ? ' on' : '') + (n > 0 ? ' has-unread' : '');
  if (title) b.title = title + (n > 0 ? ` · 안 읽은 메시지 ${n}개` : '');
  if (avatar != null) {
    const a = el('span', 'side-av' + (ai ? ' ai' : ''), avatar);
    if (ai) a.style.background = '#ffdc1a';
    b.appendChild(a);
  } else {
    b.appendChild(el('span', 'hash', hash || '#'));
  }
  b.appendChild(el('span', 'nm', label));
  if (n > 0) b.appendChild(el('span', 'badge-n', n > 99 ? '99+' : String(n)));
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
      label: c.name, hash: '#', active: c.id === S.channelId, unread: S.unread[c.id] || 0,
      onClick: () => selectChannel(c.id), title: c.description || '#' + c.name,
    }));
  }

  const al = $('ai-list');
  al.textContent = '';
  for (const c of ais) {
    al.appendChild(sideItem({
      label: 'Alter', avatar: 'AI', ai: true, active: c.id === S.channelId, unread: S.unread[c.id] || 0,
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
      unread: S.unread[c.id] || 0,
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
  if (m.content) text.appendChild(renderMarkdown(m.content));
  if (m.attachments && m.attachments.length) text.appendChild(attachmentsEl(m.attachments));
  if (m.content || (m.attachments && m.attachments.length)) body.appendChild(text);

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
    if (Array.isArray(res.unread)) setUnreadMap(res.unread);
  } catch (e) {
    if (!silent) showChatError(e.message || '메시지를 불러오지 못했어요.');
  }
}

async function selectChannel(id) {
  if (!S.channels.some((c) => c.id === id)) return;
  if (S.huddle && S.huddleChannelId !== id) leaveHuddle('다른 채널로 옮겨서 회의에서 나왔어요.');
  if (S.channelId !== id) { clearPending(false); clearPending(true); }
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
  // 지금 채널을 보고 있으니 안 읽음 배지를 지우고 서버에도 기록
  S.unread[id] = 0;
  renderSidebar();
  updateUnreadUi();
  updateHuddleButtons();
  await reload({ silent: false });
  markRead(id);
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
  const chFiles = S.pending.channel.length;
  const thFiles = S.pending.thread.length;
  $('send').disabled = S.sending || S.uploading || (!ch.value.trim() && !chFiles) || !S.channelId;
  $('thread-send').disabled = S.sending || S.uploading || (!th.value.trim() && !thFiles) || !S.threadParent;
  $('send').textContent = S.uploading ? '올리는 중…' : '보내기';
  $('thread-send').textContent = S.uploading ? '올리는 중…' : '답글';
  $('composer-input').placeholder = currentChannel()
    ? (currentChannel().kind === 'channel' ? `#${currentChannel().name} 에 메시지 보내기` : `${currentChannel().name} 에 메시지 보내기`)
    : '메시지 보내기';
}

async function send(inThread) {
  const ta = $(inThread ? 'thread-input' : 'composer-input');
  const text = ta.value.trim();
  const pending = pendingOf(inThread);
  if (S.sending || S.uploading || !S.channelId) return;
  if (!text && !pending.length) return;
  if (inThread && !S.threadParent) return;
  const channelId = S.channelId;
  const parentId = inThread ? S.threadParent.id : null;
  const ch = currentChannel();
  const aiExpected = (ch && ch.kind === 'ai') || /@\s?(ai|alter)\b/i.test(text);

  // 1) 고른 사진·파일을 먼저 올린다 (미리보기 모드는 이 브라우저 안에서만)
  const attachments = [];
  if (pending.length) {
    S.uploading = true;
    updateComposer();
    try {
      for (const item of [...pending]) {
        if (item.state === 'done' && item.att) { attachments.push(item.att); continue; }
        item.state = 'uploading';
        renderPending(inThread);
        item.att = S.mode === 'preview' ? previewAttachment(item.file) : await uploadAttachment(item.file);
        item.state = 'done';
        attachments.push(item.att);
        renderPending(inThread);
      }
    } catch (e) {
      S.uploading = false;
      updateComposer();
      renderPending(inThread);
      toast(e.message || '파일을 올리지 못했어요.', 'err');
      return;
    }
    S.uploading = false;
  }

  S.sending = true;
  updateComposer();
  ta.value = '';
  autoGrow(ta);

  const tmp = {
    id: 'tmp-' + Date.now(), channel_id: channelId, parent_id: parentId, user_id: S.me.id,
    author_name: S.me.name, author_kind: 'user', content: text, attachments: attachments.slice(),
    created_at: new Date().toISOString(), reply_count: 0, pending: true,
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
    const res = await S.api.post({ channelId, content: text, parentId, attachments });
    S.aiPending = false;
    S.aiPendingWhere = null;
    if (inThread) S.threadReplies = S.threadReplies.filter((m) => m !== tmp);
    else S.messages = S.messages.filter((m) => m !== tmp);
    clearPending(inThread);
    if (res.ai_error) toast(res.ai_error, 'err');
    if (res.ai && res.ai.source === 'fallback') toast('AI 열쇠가 아직 없어서 안내 문구로 답했어요.', 'err');
    await reload();
    if (inThread) renderThread();
  } catch (e) {
    S.aiPending = false;
    S.aiPendingWhere = null;
    if (inThread) S.threadReplies = S.threadReplies.filter((m) => m !== tmp);
    else S.messages = S.messages.filter((m) => m !== tmp);
    // 올린 파일은 지우고, 고른 목록은 그대로 둔어 다시 보낼 수 있게 한다
    if (attachments.length) {
      const keepPaths = new Set(attachments.map((a) => a.path));
      await removeUploaded(attachments);
      for (const item of pendingOf(inThread)) if (item.att && keepPaths.has(item.att.path)) { item.state = 'ready'; item.att = null; }
    }
    renderMessages();
    renderThread();
    renderPending(inThread);
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

// ---------- 연동 열쇠 · MCP (관리자) ----------
const MCP_URL = FN_URL + '/mcp';
const tokenFmt = new Intl.DateTimeFormat('ko-KR', { timeZone: TZ, dateStyle: 'short', timeStyle: 'short' });
const fmtWhen = (v) => (v ? tokenFmt.format(new Date(v)) : '');

/** Cursor · Claude Desktop 에 붙여 넣을 설정 — 새로 발급한 열쇠가 있으면 그 값을 바로 쓴다 */
function mcpJson(token) {
  return JSON.stringify({
    mcpServers: {
      'byeolmuri-workspace': {
        url: MCP_URL,
        headers: { Authorization: `Bearer ${token || '<발급받은 열쇠>'}` },
      },
    },
  }, null, 2);
}

async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; }
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

async function copyAndTell(text, label) {
  const ok = await copyText(text);
  toast(ok ? `${label} 복사했어요.` : '복사하지 못했어요. 직접 선택해 복사해 주세요.', ok ? '' : 'err');
}

function setLinkNote(msg, err = false) {
  const n = $('link-note');
  n.textContent = msg || '';
  n.hidden = !msg;
  n.classList.toggle('err', Boolean(err));
}

function renderTokens() {
  const box = $('token-list');
  box.textContent = '';
  const list = S.tokens || [];
  if (!list.length) {
    box.appendChild(el('p', 'token-empty', '아직 발급한 열쇠가 없어요. 위에서 하나 발급해 주세요.'));
    return;
  }
  for (const t of list) {
    const row = el('div', 'token-row' + (t.revoked_at ? ' off' : ''));
    const main = el('div', 'token-main');
    main.appendChild(el('b', 'token-name', t.name));
    main.appendChild(el('code', 'token-prefix', `${t.token_prefix}…`));
    const meta = el('span', 'token-meta');
    meta.textContent = [
      t.created_at ? `발급 ${fmtWhen(t.created_at)}` : '',
      t.last_used_at ? `마지막 사용 ${fmtWhen(t.last_used_at)}` : '아직 안 씀',
      t.revoked_at ? `폐기 ${fmtWhen(t.revoked_at)}` : '',
    ].filter(Boolean).join(' · ');
    main.appendChild(meta);
    row.appendChild(main);
    if (!t.revoked_at) {
      const b = el('button', 'btn ghost small', '폐기');
      b.type = 'button';
      b.addEventListener('click', () => revokeToken(t, b));
      row.appendChild(b);
    } else {
      row.appendChild(el('span', 'token-tag', '폐기됨'));
    }
    box.appendChild(row);
  }
}

async function loadTokens() {
  if (!S.api || !S.api.botTokens) return;
  try {
    const res = await S.api.botTokens();
    S.tokens = res.tokens || [];
    renderTokens();
    if (res.env_token) setLinkNote('서버 비밀값(WORKSPACE_BOT_TOKEN)으로 넣은 열쇠도 함께 쓰이고 있어요.');
    else if (S.mode === 'preview') setLinkNote('미리보기예요 — 진짜 열쇠는 만들어지지 않고 어디에도 저장되지 않습니다.');
    else setLinkNote('');
  } catch (e) {
    setLinkNote(e.message || '열쇠 목록을 불러오지 못했어요.', true);
  }
}

async function issueToken(e) {
  e.preventDefault();
  const input = $('token-name');
  const name = input.value.trim();
  if (!name) { input.focus(); return; }
  const btn = $('token-issue');
  btn.disabled = true;
  try {
    const res = await S.api.issueBotToken(name);
    S.newToken = res.token || '';
    $('token-value').textContent = S.newToken;
    $('token-new').hidden = false;
    $('mcp-json').textContent = mcpJson(S.newToken);
    input.value = '';
    await loadTokens();
    if (S.mode === 'preview') setLinkNote('미리보기예요 — 진짜 열쇠는 만들어지지 않고 어디에도 저장되지 않습니다.');
    else setLinkNote("열쇠를 발급했어요. 아래 '복사'로 지금 바로 옮겨 두세요.");
  } catch (err) {
    setLinkNote(err.message || '열쇠를 발급하지 못했어요.', true);
  } finally {
    btn.disabled = false;
  }
}

async function revokeToken(t, btn) {
  if (!window.confirm(`«${t.name}» 열쇠를 폐기할까요? 이 열쇠로는 더 이상 읽거나 쓸 수 없습니다.`)) return;
  btn.disabled = true;
  try {
    await S.api.revokeBotToken(t.id);
    await loadTokens();
    setLinkNote(`«${t.name}» 열쇠를 폐기했어요.`);
  } catch (e) {
    btn.disabled = false;
    setLinkNote(e.message || '폐기하지 못했어요.', true);
  }
}

function openLinkModal() {
  const box = $('link-modal');
  if (!box) return;
  S.newToken = '';
  $('token-new').hidden = true;
  $('token-value').textContent = '';
  $('mcp-url').textContent = MCP_URL;
  $('mcp-json').textContent = mcpJson('');
  setLinkNote(S.mode === 'preview' ? '미리보기예요 — 여기서 만든 열쇠는 연습용이고 실제로는 동작하지 않습니다.' : '');
  box.hidden = false;
  $('token-name').focus();
  loadTokens();
}

function closeLinkModal() {
  const box = $('link-modal');
  if (box) box.hidden = true;
}

// ---------- 음성·화상 회의(허들) ----------
const huddleTiles = new Map(); // 참가자 id → { el, video, audio }

function huddleAllowed(ch) {
  return Boolean(ch && (ch.kind === 'channel' || ch.kind === 'dm'));
}

function updateHuddleButtons() {
  const ch = currentChannel();
  const can = huddleAllowed(ch);
  const inHere = Boolean(S.huddle && S.huddleChannelId === (ch && ch.id));
  for (const [id, verb] of [['huddle-audio', '음성'], ['huddle-video', '화상']]) {
    const b = $(id);
    if (!b) continue;
    b.hidden = !can;
    b.classList.toggle('on', inHere);
    b.setAttribute('aria-pressed', inHere ? 'true' : 'false');
    b.title = inHere ? `${verb} 회의 중 — 누르면 회의 창을 펼침` : `${verb} 회의 시작`;
  }
}

function tileColor(id) {
  let h = 0;
  const s = String(id || '');
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

function buildTile(p) {
  const el2 = el('div', 'hd-tile' + (p.local ? ' me' : ''));
  el2.setAttribute('role', 'listitem');
  const video = document.createElement('video');
  video.autoplay = true;
  video.playsInline = true;
  // 영상은 늘 소리 없이 — 남의 소리는 아래 audio 가 낸다 (화상이 꺼져 있어도 소리가 나야 하므로)
  video.muted = true;
  video.setAttribute('playsinline', '');
  const av = el('div', 'hd-av', firstChar(p.name));
  av.style.background = tileColor(p.id);
  const bar = el('div', 'hd-bar');
  const nm = el('span', 'hd-name', p.local ? `${p.name} (나)` : p.name);
  const mic = el('span', 'hd-mic');
  const scr = el('span', 'hd-scr', '🖥️');
  bar.append(nm, mic, scr);
  el2.append(video, av, bar);
  // 남의 소리 전용 <audio> — 음성 회의(영상 없음)에서도 이 요소로 들린다.
  // 화면에서 숨기려고 display:none 을 주지 않는다(controls 가 없으면 원래 자리를 차지하지 않는다).
  let audio = null;
  if (!p.local) {
    audio = document.createElement('audio');
    audio.autoplay = true;
    audio.setAttribute('playsinline', '');
    el2.appendChild(audio);
  }
  return { el: el2, video, audio, av, mic, scr };
}

// 자동재생이 막힌 소리 — 다음 손짓(누르기·키)에 다시 틀어 본다 (나중에 들어온 참가자의 소리)
const pendingAudio = new Set();

/** 타일을 화면에서 거둘 때 — 붙여 둔 스트림을 놓아 소리·영상이 남지 않게 */
function disposeTile(tile) {
  pendingAudio.delete(tile);
  try { tile.video.srcObject = null; } catch { /* 무시 */ }
  if (tile.audio) {
    try { tile.audio.pause(); tile.audio.srcObject = null; } catch { /* 무시 */ }
  }
  tile.el.remove();
}

const playQuietly = (node, tile = null) => {
  const pr = node.play();
  if (!pr || !pr.catch) return;
  pr.catch(() => { if (tile) pendingAudio.add(tile); });
};
function retryPendingAudio() {
  for (const tile of [...pendingAudio]) {
    const a = tile.audio;
    if (!a || !a.srcObject) { pendingAudio.delete(tile); continue; }
    const pr = a.play();
    if (pr && pr.then) pr.then(() => pendingAudio.delete(tile)).catch(() => { /* 다음 손짓에 또 */ });
  }
}
document.addEventListener('pointerdown', retryPendingAudio, true);
document.addEventListener('keydown', retryPendingAudio, true);

function updateTile(tile, p) {
  // 남의 소리는 영상 유무·compact 모드와 상관없이 늘 audio 로 붙인다 (음성 회의가 들리게)
  if (tile.audio) {
    const sound = p.stream || null;
    if (tile.audio.srcObject !== sound) {
      tile.audio.srcObject = sound;
      if (!sound) pendingAudio.delete(tile);
      else if (tile.audio.paused) playQuietly(tile.audio, tile);
    }
  }
  const stream = p.video && p.stream ? p.stream : null;
  if (tile.video.srcObject !== stream) {
    tile.video.srcObject = stream;
    if (stream) playQuietly(tile.video);
  }
  tile.el.classList.toggle('video-off', !stream);
  tile.el.classList.toggle('speaking', Boolean(p.speaking));
  tile.el.classList.toggle('mic-off', !p.micOn);
  tile.mic.textContent = p.micOn ? '🎙️' : '🔇';
  tile.scr.hidden = !p.screen;
}

function renderHuddle() {
  const box = $('huddle');
  if (!box) return;
  const h = S.huddle;
  if (!h) {
    box.hidden = true;
    for (const [, t] of huddleTiles) disposeTile(t);
    huddleTiles.clear();
    updateHuddleButtons();
    return;
  }
  box.hidden = false;
  box.classList.toggle('compact', S.huddleCompact);
  box.classList.toggle('big', S.huddleBig);

  const ch = S.channels.find((c) => c.id === S.huddleChannelId) || null;
  $('huddle-title').textContent = ch ? (ch.kind === 'channel' ? '#' + ch.name : ch.name) : '';
  const people = h.view();
  $('huddle-count').textContent = `${people.length}명`;

  const wrap = $('huddle-tiles');
  const seen = new Set();
  for (const p of people) {
    const key = String(p.id);
    seen.add(key);
    let tile = huddleTiles.get(key);
    if (!tile) { tile = buildTile(p); huddleTiles.set(key, tile); wrap.appendChild(tile.el); }
    updateTile(tile, p);
  }
  for (const [id, t] of [...huddleTiles]) if (!seen.has(id)) { disposeTile(t); huddleTiles.delete(id); }

  const l = h.local;
  const micBtn = $('huddle-mic');
  micBtn.classList.toggle('off', !l.micOn);
  micBtn.setAttribute('aria-pressed', l.micOn ? 'true' : 'false');
  micBtn.querySelector('span').textContent = l.micOn ? '마이크' : '마이크 꺼짐';
  const camBtn = $('huddle-cam');
  camBtn.classList.toggle('off', !l.camOn);
  camBtn.setAttribute('aria-pressed', l.camOn ? 'true' : 'false');
  camBtn.querySelector('span').textContent = l.camOn ? '카메라' : '카메라 꺼짐';
  const scrBtn = $('huddle-screen');
  scrBtn.classList.toggle('on', l.screenOn);
  scrBtn.setAttribute('aria-pressed', l.screenOn ? 'true' : 'false');
  scrBtn.querySelector('span').textContent = l.screenOn ? '공유 중' : '화면';
  $('huddle-collapse').querySelector('span').textContent = S.huddleCompact ? '펼치기' : '접기';
  $('huddle-big').textContent = S.huddleBig ? '작게 보기' : '크게 보기';
  $('huddle-big').setAttribute('aria-pressed', S.huddleBig ? 'true' : 'false');
  const note = $('huddle-note');
  if (note) {
    const text = S.mode === 'preview' ? '미리보기예요 — 실제 마이크·카메라 없이 화면만 연습합니다.' : '';
    note.textContent = text;
    note.hidden = !text;
  }
  updateHuddleButtons();
}

async function startHuddle(video) {
  const ch = currentChannel();
  if (!huddleAllowed(ch)) return;
  if (S.huddle) { S.huddleBig = false; S.huddleCompact = false; renderHuddle(); return; }
  S.huddleChannelId = ch.id;
  S.huddleBig = false;
  S.huddleCompact = false;
  const h = new Huddle({
    channelId: ch.id,
    me: { id: S.me.id, name: S.me.name },
    preview: S.mode === 'preview',
    onChange: () => renderHuddle(),
    onNotice: (m) => toast(m),
  });
  S.huddle = h;
  renderHuddle();
  try {
    await h.join({ video });
  } catch (e) {
    toast(e.message || '회의에 들어가지 못했어요.', 'err');
    leaveHuddle();
  }
}

function leaveHuddle(msg = '') {
  const h = S.huddle;
  S.huddle = null;
  S.huddleChannelId = null;
  S.huddleBig = false;
  S.huddleCompact = false;
  renderHuddle();
  if (h) h.leave().catch(() => { /* 나가기는 실패해도 그만 */ });
  if (msg) toast(msg);
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
  $('open-sidebar').hidden = true;
  $('bell').hidden = true;
  $('link-admin').hidden = true;
  closeLinkModal();
  $('login-logout').hidden = !S.hasSession;
}

function teardown() {
  leaveHuddle();
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
  S.uploading = false;
  clearPending(false);
  clearPending(true);
  closeLightbox();
  S.aiKeySet = true;
  S.starting = false;
  S.sig = '';
  S.hasSession = false;
  S.unread = {};
  S.tokens = [];
  S.newToken = '';
  closeLinkModal();
  updateUnreadUi();
}

function enter(data, mode) {
  S.mode = mode;
  S.me = data.me;
  S.members = data.members || [];
  S.channels = data.channels || [];
  S.aiKeySet = data.gemini_key_set !== false;
  S.hasSession = mode === 'live';
  S.sig = '';
  S.unread = {};
  for (const c of S.channels) if (c.unread) S.unread[c.id] = Number(c.unread);
  $('boot').hidden = true;
  $('login').hidden = true;
  $('workspace').hidden = false;
  $('logout').hidden = false;
  $('open-sidebar').hidden = false;
  $('bell').hidden = mode !== 'live';
  $('link-admin').hidden = !(S.me && S.me.role === 'admin');
  if (mode === 'live') refreshBell();
  $('logout').textContent = mode === 'preview' && !narrowScreen() ? '미리보기 끝내기' : (mode === 'preview' ? '나가기' : '로그아웃');
  $('conn').hidden = false;
  $('conn').classList.toggle('preview', mode === 'preview');
  $('conn-text').textContent = mode === 'preview' ? '미리보기' : '연결됨';
  renderWho();
  renderSidebar();
  updateComposer();
  updateUnreadUi();

  const saved = Number(local.get('last-channel', 0));
  const first = S.channels.find((c) => c.kind === 'channel') || S.channels[0];
  const pick = S.channels.find((c) => c.id === saved) || first;
  if (pick) selectChannel(pick.id);
  else renderHeader();

  if (mode === 'live') {
    S.unsub = S.api.subscribe((msg) => {
      incoming(msg);
      clearTimeout(S.reloadTimer);
      S.reloadTimer = setTimeout(() => { reload(); }, 350);
    });
    S.poll = setInterval(() => {
      if (document.visibilityState === 'visible') reload();
    }, 5000);
  }
  updateUnreadUi();
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

// ---------- 서비스 워커 · 알림 ----------
let swReg = null;
async function registerSw() {
  if (!('serviceWorker' in navigator)) return null;
  try {
    swReg = await navigator.serviceWorker.register(BASE_PATH + 'sw.js', { scope: '/workspace/' });
    return swReg;
  } catch (e) {
    console.warn('서비스 워커를 등록하지 못했습니다.', e);
    return null;
  }
}

function urlB64ToUint8Array(base64) {
  const padded = (base64 + '='.repeat((4 - (base64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(padded);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function pushSupported() {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

const narrowScreen = () => window.matchMedia('(max-width: 860px)').matches;

async function currentPushSub() {
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    return reg ? await reg.pushManager.getSubscription() : null;
  } catch {
    return null;
  }
}

async function refreshBell() {
  const b = $('bell');
  if (!b) return;
  if (S.mode !== 'live' || !pushSupported()) { b.hidden = true; return; }
  b.hidden = false;
  const perm = Notification.permission;
  const sub = await currentPushSub();
  b.classList.toggle('on', Boolean(sub));
  b.setAttribute('aria-pressed', sub ? 'true' : 'false');
  if (perm === 'denied') {
    b.textContent = '🔕 알림 차단됨';
    b.title = '브라우저 설정에서 이 사이트의 알림을 허용해 주세요';
  } else if (sub) {
    b.textContent = '🔔 알림 켬';
    b.title = '새 메시지가 오면 알려 드려요. 누르면 끕니다.';
  } else {
    b.textContent = '🔔 알림';
    b.title = '앱을 닫아도 새 메시지를 알려 드려요. 눌러서 켜세요.';
  }
}

async function toggleBell() {
  if (S.mode !== 'live') { toast('미리보기에서는 실제 알림을 켤 수 없어요.'); return; }
  if (!pushSupported()) { toast('이 브라우저는 알림을 지원하지 않아요.', 'err'); return; }
  const b = $('bell');
  b.disabled = true;
  try {
    const reg = (await navigator.serviceWorker.getRegistration()) || (await registerSw());
    if (!reg) throw new Error('서비스 워커를 준비하지 못했어요. 페이지를 새로 고쳐 보세요.');
    const existing = await reg.pushManager.getSubscription();
    if (existing) {
      try { await S.api.pushUnsubscribe(existing.endpoint); } catch { /* 서버에 없어도 아래에서 끈다 */ }
      await existing.unsubscribe();
      toast('알림을 껐어요.');
    } else {
      const perm = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
      if (perm !== 'granted') {
        toast(perm === 'denied' ? '브라우저 설정에서 알림을 허용해 주세요.' : '알림을 켜려면 권한이 필요해요.', 'err');
        return;
      }
      const { publicKey } = await S.api.pushKey();
      if (!publicKey) throw new Error('서버에 알림 열쇠가 아직 없어요. 잠시 뒤 다시 시도해 주세요.');
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlB64ToUint8Array(publicKey) });
      await S.api.pushSubscribe(sub.toJSON());
      toast('알림을 켰어요. 앱을 닫아도 새 메시지를 알려 드려요.');
    }
  } catch (e) {
    toast(e.message || '알림 설정에 실패했어요.', 'err');
  } finally {
    b.disabled = false;
    refreshBell();
  }
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
  $('bell').addEventListener('click', toggleBell);

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    if (S.mode === 'live') { reload(); refreshBell(); }
    if (S.channelId) markRead(S.channelId);
  });

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

  // ---------- 연동 열쇠 · MCP 창 ----------
  $('link-admin').addEventListener('click', openLinkModal);
  $('link-close').addEventListener('click', closeLinkModal);
  $('link-modal').addEventListener('click', (e) => { if (e.target === $('link-modal')) closeLinkModal(); });
  $('token-form').addEventListener('submit', issueToken);
  $('token-copy').addEventListener('click', () => copyAndTell(S.newToken, '열쇠를'));
  $('mcp-url-copy').addEventListener('click', () => copyAndTell(MCP_URL, 'MCP 서버 주소를'));
  $('mcp-json-copy').addEventListener('click', () => copyAndTell(mcpJson(S.newToken), 'MCP 설정을'));

  // ---------- 음성·화상 회의(허들) ----------
  $('huddle-audio').addEventListener('click', () => startHuddle(false));
  $('huddle-video').addEventListener('click', () => startHuddle(true));
  $('huddle-leave').addEventListener('click', () => leaveHuddle('회의에서 나왔어요.'));
  $('huddle-leave2').addEventListener('click', () => leaveHuddle('회의에서 나왔어요.'));
  $('huddle-mic').addEventListener('click', () => { if (S.huddle) S.huddle.toggleMic(); });
  $('huddle-cam').addEventListener('click', () => { if (S.huddle) S.huddle.toggleCam(); });
  $('huddle-screen').addEventListener('click', () => { if (S.huddle) S.huddle.toggleScreen(); });
  $('huddle-collapse').addEventListener('click', () => {
    S.huddleCompact = !S.huddleCompact;
    if (S.huddleCompact) S.huddleBig = false;
    renderHuddle();
  });
  $('huddle-big').addEventListener('click', () => {
    S.huddleBig = !S.huddleBig;
    if (S.huddleBig) S.huddleCompact = false;
    renderHuddle();
  });
  window.addEventListener('beforeunload', () => { if (S.huddle) S.huddle.leave(); });

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
    ta.addEventListener('paste', (e) => {
      const files = Array.from((e.clipboardData && e.clipboardData.files) || []);
      if (!files.length) return;
      e.preventDefault();
      addFiles(files, isThread);
    });
  }

  // ---------- 사진·파일 버튼·끌어다 놓기 ----------
  for (const [btnId, inputId, isThread] of [['attach', 'composer-file', false], ['thread-attach', 'thread-file', true]]) {
    const b = $(btnId);
    const inp = $(inputId);
    if (!b || !inp) continue;
    b.addEventListener('click', () => inp.click());
    inp.addEventListener('change', () => {
      addFiles(inp.files, isThread);
      inp.value = '';
    });
  }
  const hasFiles = (e) => Array.from((e.dataTransfer && e.dataTransfer.types) || []).includes('Files');
  const bindDrop = (zone, inThread) => {
    if (!zone) return;
    let depth = 0;
    zone.addEventListener('dragenter', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth++;
      zone.classList.add('drop-on');
    });
    zone.addEventListener('dragover', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    });
    zone.addEventListener('dragleave', () => {
      depth = Math.max(0, depth - 1);
      if (!depth) zone.classList.remove('drop-on');
    });
    zone.addEventListener('drop', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      zone.classList.remove('drop-on');
      addFiles(e.dataTransfer.files, inThread);
      const ta = $(inThread ? 'thread-input' : 'composer-input');
      if (ta) ta.focus();
    });
  };
  bindDrop($('chat-body'), false);
  bindDrop(document.querySelector('.thread-body'), true);

  // 사진 크게 보기 닫기
  $('lightbox-close').addEventListener('click', closeLightbox);
  $('lightbox').addEventListener('click', (e) => { if (e.target === $('lightbox')) closeLightbox(); });

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
    if (!$('link-modal').hidden) closeLinkModal();
    else if (!$('lightbox').hidden) closeLightbox();
    else if (S.threadOpen) closeThread();
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
  applyAppInfo(' · BMR APPS').then(() => {
    S.baseTitle = document.title || S.baseTitle;
    updateUnreadUi();
  }).catch(() => { /* 허브 이름을 못 읽어도 그대로 */ });
  bind();
  registerSw();
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
