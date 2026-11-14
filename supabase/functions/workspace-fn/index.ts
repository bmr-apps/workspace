// workspace-fn — 별무리 워크스페이스 서버 함수
//
// 주소: https://psupfmarnyxontorftio.supabase.co/functions/v1/workspace-fn/<경로>
//   GET  /health                                  DB·표 연결 확인
//   GET  /hello                                   부른 사람, AI 열쇠 설정 여부
//   GET  /bootstrap                               나·멤버·채널 목록 (기본 채널과 내 AI 방을 만들어 줌)
//   POST /channels      {kind:'channel', name, description} | {kind:'dm', target_user_id}
//   GET  /messages?channel_id=…[&parent_id=…]     채널 메시지 / 스레드 답글 (attachments 포함)
//   POST /messages      {channel_id, content, parent_id?, attachments?}  메시지 쓰기 (+ @AI 면 Alter 답글)
//
// 사진·파일: 브라우저가 Storage 버킷 'workspace' 의 <내 아이디>/… 에 직접 올리고,
// 이 함수에는 [{path,name,mime,size}] 만 받아 messages.attachments 에 적습니다.
// 볼 때는 브라우저가 createSignedUrl 로 1시간짜리 주소를 만들어 씁니다(로그인한 사람은 이 버킷을 읽을 수 있음).
//
// 함수는 이 앱 전용 DB 계정(workspace_fn, 개발자 계정 권한을 물려받음)으로 접속해 RLS 를 거치지 않습니다.
// 그래서 누가 무엇을 볼 수 있는지는 이 파일에서 직접 확인합니다 (memberFor / channelFor).
// 비밀값: WORKSPACE_DB_URL, WORKSPACE_GEMINI_API_KEY, WORKSPACE_GEMINI_MODEL(선택)
import postgres from 'npm:postgres@3.4.5';
import { DDL, SEED_CHANNELS, CHECK_TABLES } from './schema.ts';
import { ask, hasKey as aiHasKey, currentModel, lastAiResult, type Turn } from './ai.ts';
import { getVapid, pushAvailable, sendPush } from './push.ts';

const FN = 'workspace-fn';
const SCHEMA = 'workspace';
const PREFIX = 'WORKSPACE_';
const ORIGINS = ['https://apps.bmrschool.net', 'http://localhost:5173', 'http://127.0.0.1:5173', 'http://localhost:4173', 'http://127.0.0.1:4173'];

const secret = (name: string) => Deno.env.get(PREFIX + name) ?? '';
const DB_URL = secret('DB_URL');
// 서버리스라 연결을 적게: 최대 2개, 20초 쉬면 닫음. 트랜잭션 풀러(6543)라 prepare 끔
const db = DB_URL ? postgres(DB_URL, { prepare: false, max: 2, idle_timeout: 20, connect_timeout: 10, onnotice: () => {} }) : null;
type Sql = ReturnType<typeof postgres>;

function cors(req: Request): Record<string, string> {
  const o = req.headers.get('Origin') ?? '';
  return {
    'Access-Control-Allow-Origin': ORIGINS.includes(o) ? o : ORIGINS[0],
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Max-Age': '600', Vary: 'Origin',
  };
}
const json = (req: Request, status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors(req), 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
  });

class HttpError extends Error {
  status: number; code: string;
  constructor(status: number, message: string, code = '') { super(message); this.status = status; this.code = code || String(status); }
}

// ---------- 로그인한 사람 ----------
type User = { id: string; email: string; name: string; confirmed: boolean };
/** Authorization: Bearer <사용자 토큰> 을 Supabase Auth 에 물어 확인. 공개 키·잘못된 토큰이면 null */
async function getUser(req: Request): Promise<User | null> {
  const m = /^Bearer\s+(.+)$/i.exec(req.headers.get('Authorization') ?? '');
  const token = m?.[1] ?? '';
  if (!token || token.startsWith('sb_') || token.split('.').length !== 3) return null;
  const r = await fetch(`${Deno.env.get('SUPABASE_URL')}/auth/v1/user`, {
    headers: { apikey: Deno.env.get('SUPABASE_ANON_KEY') ?? '', Authorization: `Bearer ${token}` },
  });
  if (!r.ok) return null;
  const u = await r.json() as {
    id?: string; email?: string; email_confirmed_at?: string;
    app_metadata?: { provider?: string; providers?: string[] };
    user_metadata?: { full_name?: string; name?: string };
  };
  if (!u?.id) return null;
  const meta = u.user_metadata ?? {};
  const providers = u.app_metadata?.providers ?? (u.app_metadata?.provider ? [u.app_metadata.provider] : []);
  const name = String(meta.full_name ?? meta.name ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 40);
  return {
    id: u.id,
    email: String(u.email ?? '').toLowerCase(),
    name,
    confirmed: Boolean(u.email_confirmed_at) || providers.includes('google'),
  };
}

// ---------- 표가 없으면 만들기 (콜드 스타트 1회) ----------
let schemaReady: Promise<void> | null = null;
function ensureSchema(sql: Sql): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      const t0 = Date.now();
      let fresh = false;
      try {
        const rows = await sql.unsafe(CHECK_TABLES) as unknown as { members?: boolean; channels?: boolean; messages?: boolean; push?: boolean; push_config?: boolean; reads?: boolean }[];
        const t = rows?.[0] ?? {};
        fresh = !(t.members && t.channels && t.messages && t.push && t.push_config && t.reads);
      } catch (e) {
        fresh = true;
        console.error(FN, 'check tables', (e as Error)?.message ?? e);
      }
      if (fresh) {
        for (const st of DDL) {
          try { await sql.unsafe(st); } catch (e) {
            console.error(FN, 'ddl', (e as Error)?.message ?? e, '|', st.replace(/\s+/g, ' ').slice(0, 80));
          }
        }
      }
      try { await sql.unsafe(SEED_CHANNELS); } catch (e) { console.error(FN, 'seed', (e as Error)?.message ?? e); }
      // 마지막 확인: 핵심 표가 정말 있는지 (하나라도 없으면 이번 요청은 실패로 알린다)
      const rows = await sql.unsafe(CHECK_TABLES) as unknown as { members?: boolean; channels?: boolean; messages?: boolean; push?: boolean; push_config?: boolean; reads?: boolean }[];
      const t = rows?.[0] ?? {};
      if (!(t.members && t.channels && t.messages && t.push && t.push_config && t.reads)) throw new Error('표를 만들지 못했습니다');
      console.log(FN, 'schema ready', Date.now() - t0, 'ms', fresh ? '(created)' : '(existing)');
    })().catch((e) => {
      schemaReady = null; // 다음 요청에서 다시 시도
      throw e;
    });
  }
  return schemaReady;
}

// ---------- 표 행 → 브라우저 모양 ----------
const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : (v == null ? null : String(v)));
const COLORS = ['#ffdc1a', '#0abbee', '#02c245', '#ff614a', '#7e65c1', '#b0e7f8', '#fef1b8', '#a4e9bc'];
function colorFor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return COLORS[h % COLORS.length];
}

type Member = { id: string; email: string; name: string; role: 'member' | 'admin'; avatar_color: string; last_seen_at: string | null };
type Channel = { id: number; slug: string | null; name: string; kind: 'channel' | 'dm' | 'ai'; description: string; dm_key: string | null; created_at: string; unread: number };
type Attachment = { path: string; name: string; mime: string; size: number };
type Message = {
  id: number; channel_id: number; parent_id: number | null; user_id: string | null;
  author_name: string; author_kind: 'user' | 'ai'; content: string; created_at: string; reply_count: number;
  attachments: Attachment[];
};

const MAX_FILES = 5;
const MAX_FILE_BYTES = 10 * 1024 * 1024; // 버킷 한도와 같음
const isImage = (mime: string) => /^image\//i.test(mime);

/** DB 의 jsonb 값을 믿지 않고 모양을 맞춰 읽는다 (예전 메시지·잘못된 값은 빈 목록) */
function readAttachments(v: unknown): Attachment[] {
  let list: unknown = v;
  if (typeof v === 'string') { try { list = JSON.parse(v); } catch { return []; } }
  if (!Array.isArray(list)) return [];
  return list.slice(0, MAX_FILES).map((a) => {
    const o = (a ?? {}) as Record<string, unknown>;
    return {
      path: String(o.path ?? ''),
      name: String(o.name ?? '').slice(0, 200) || '파일',
      mime: String(o.mime ?? 'application/octet-stream').slice(0, 100),
      size: Number(o.size) || 0,
    };
  }).filter((a) => a.path);
}

/** 브라우저가 보낸 첨부 목록을 확인한다 — 내 폴더(<내 아이디>/…) 안의 영문 경로만 */
function normAttachments(raw: unknown, meId: string): Attachment[] {
  if (raw == null) return [];
  if (!Array.isArray(raw)) throw new HttpError(400, '첨부 목록이 올바르지 않습니다.', 'bad_attachment');
  if (raw.length > MAX_FILES) throw new HttpError(400, `첨부는 한 번에 ${MAX_FILES}개까지 보낼 수 있어요.`, 'too_many_files');
  const out: Attachment[] = [];
  for (const a of raw) {
    const o = (a ?? {}) as Record<string, unknown>;
    const path = String(o.path ?? '');
    const seg = path.split('/');
    const okPath = seg.length === 2 && seg[0] === meId
      && /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(seg[1]) && seg[1] !== '.' && seg[1] !== '..';
    if (!okPath) throw new HttpError(400, '첨부 파일 정보가 올바르지 않습니다.', 'bad_attachment');
    const name = String(o.name ?? '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200) || '파일';
    const mimeRaw = String(o.mime ?? '');
    const mime = /^[\w.+-]+\/[\w.+-]+$/.test(mimeRaw) ? mimeRaw.slice(0, 100) : 'application/octet-stream';
    const size = Number(o.size);
    if (!Number.isFinite(size) || size < 0) throw new HttpError(400, '첨부 파일 크기가 올바르지 않습니다.', 'bad_attachment');
    if (size > MAX_FILE_BYTES) throw new HttpError(400, '한 파일은 10MB까지 보낼 수 있어요.', 'file_too_large');
    out.push({ path, name, mime, size: Math.round(size) });
  }
  return out;
}

/** 알림 본문 — 글이 없으면 첨부만으로 짧게 */
function pushBody(m: Message): string {
  const files = m.attachments ?? [];
  const text = m.content.replace(/\s+/g, ' ').trim();
  if (text) return (files.length ? '📎 ' : '') + text.slice(0, 160);
  if (!files.length) return '';
  const first = files[0];
  if (files.length === 1) return (isImage(first.mime) ? '🖼️ 사진' : `📎 파일: ${first.name}`).slice(0, 160);
  const images = files.filter((f) => isImage(f.mime)).length;
  if (images === files.length) return `🖼️ 사진 ${files.length}장`;
  return `📎 파일 ${files.length}개: ${first.name}`.slice(0, 160);
}

/** AI 에게 알려 줄 첨부 설명 — 이름·종류만 (내용은 볼 수 없음) */
const fileNotes = (files: Attachment[]) =>
  files.map((f) => `${isImage(f.mime) ? '사진' : '파일'} ${f.name} (${f.mime}, ${Math.max(1, Math.round(f.size / 1024))}KB)`);

const asMember = (r: Record<string, unknown>): Member => ({
  id: String(r.user_id), email: String(r.email ?? ''), name: String(r.name ?? ''),
  role: r.role === 'admin' ? 'admin' : 'member',
  avatar_color: String(r.avatar_color || colorFor(String(r.user_id))),
  last_seen_at: iso(r.last_seen_at),
});
const asChannel = (r: Record<string, unknown>): Channel => ({
  id: Number(r.id), slug: r.slug == null ? null : String(r.slug), name: String(r.name),
  kind: r.kind === 'dm' || r.kind === 'ai' ? r.kind : 'channel',
  description: String(r.description ?? ''), dm_key: r.dm_key == null ? null : String(r.dm_key),
  created_at: String(iso(r.created_at) ?? ''),
  unread: Number(r.unread_count ?? 0),
});
const asMessage = (r: Record<string, unknown>): Message => ({
  id: Number(r.id), channel_id: Number(r.channel_id),
  parent_id: r.parent_id == null ? null : Number(r.parent_id),
  user_id: r.user_id == null ? null : String(r.user_id),
  author_name: String(r.author_name ?? ''), author_kind: r.author_kind === 'ai' ? 'ai' : 'user',
  content: String(r.content ?? ''), created_at: String(iso(r.created_at) ?? ''),
  reply_count: Number(r.reply_count ?? 0),
  attachments: readAttachments(r.attachments),
});

// ---------- 멤버 확인 (처음 로그인하면 등록) ----------
async function memberFor(sql: Sql, u: User): Promise<Member> {
  const [found] = await sql`select * from ${sql(SCHEMA)}.members where user_id = ${u.id}`;
  if (found) {
    const name = u.name && u.name !== found.name ? u.name : String(found.name ?? '');
    const [row] = await sql`update ${sql(SCHEMA)}.members
      set last_seen_at = now(), name = ${name || String(found.name ?? '')}, email = ${u.email}
      where user_id = ${u.id} returning *`;
    return asMember(row ?? found);
  }
  if (!u.confirmed) throw new HttpError(403, '메일 확인이 끝나지 않은 계정입니다. 메일함의 확인 링크를 눌러 주세요.', 'unconfirmed');

  const [{ n }] = await sql`select count(*)::int as n from ${sql(SCHEMA)}.members` as unknown as { n: number }[];
  const school = /@(bmrschool\.(org|net))$/i.test(u.email);
  if (n > 0 && !school) {
    throw new HttpError(403, '이 워크스페이스에 아직 초대되지 않은 계정입니다. 관리자에게 멤버 등록을 요청해 주세요.', 'not_invited');
  }
  const role = n === 0 ? 'admin' : 'member';
  const name = u.name || u.email.split('@')[0] || '선생님';
  const [row] = await sql`insert into ${sql(SCHEMA)}.members (user_id, email, name, role, avatar_color, last_seen_at)
    values (${u.id}, ${u.email}, ${name}, ${role}, ${colorFor(u.id)}, now())
    on conflict (user_id) do update set last_seen_at = now(), name = excluded.name, email = excluded.email
    returning *`;
  return asMember(row);
}

/** 내 Alter 방이 없으면 만든다 */
async function ensureAiChannel(sql: Sql, me: Member): Promise<void> {
  const dmKey = 'ai:' + me.id;
  const [ch] = await sql`insert into ${sql(SCHEMA)}.channels (slug, name, kind, description, dm_key, created_by)
    values (${'ai-' + me.id}, ${'🤖 Alter (AI)'}, ${'ai'}, ${'Alter 와 1:1로 묻고 답하는 나만의 방'}, ${dmKey}, ${me.id})
    on conflict (dm_key) do update set name = excluded.name
    returning id`;
  if (ch?.id) {
    await sql`insert into ${sql(SCHEMA)}.channel_members (channel_id, user_id)
      values (${Number(ch.id)}, ${me.id}) on conflict do nothing`;
  }
}

/** 볼 수 있는 채널인지 확인하고 채널 행을 돌려준다 */
async function channelFor(sql: Sql, meId: string, channelId: number): Promise<Record<string, unknown>> {
  const [c] = await sql`select * from ${sql(SCHEMA)}.channels where id = ${channelId}`;
  if (!c) throw new HttpError(404, '없는 채널입니다.', 'no_channel');
  if (c.kind !== 'channel') {
    const [m] = await sql`select 1 from ${sql(SCHEMA)}.channel_members where channel_id = ${channelId} and user_id = ${meId}`;
    if (!m) throw new HttpError(403, '이 채널에 들어갈 수 없습니다.', 'no_access');
  }
  return c as Record<string, unknown>;
}

// ---------- 메시지 ----------
const MSG_COLS = `m.id, m.channel_id, m.parent_id, m.user_id, m.author_name, m.author_kind, m.content, m.attachments, m.created_at,
  (select count(*)::int from workspace.messages r where r.parent_id = m.id) as reply_count`;

async function topMessages(sql: Sql, channelId: number): Promise<Message[]> {
  const rows = await sql.unsafe(
    `select ${MSG_COLS} from workspace.messages m
     where m.channel_id = $1 and m.parent_id is null
     order by m.id desc limit 200`,
    [channelId],
  ) as unknown as Record<string, unknown>[];
  return rows.map(asMessage).reverse();
}

/** 채널별 안 읽은 메시지 수 + 그 채널의 마지막 메시지 번호 */
async function unreadFor(sql: Sql, meId: string): Promise<{ channel_id: number; unread: number; last_id: number }[]> {
  const rows = await sql`select c.id,
      (select count(*)::int from ${sql(SCHEMA)}.messages m
        where m.channel_id = c.id and m.id > coalesce(r.last_read_id, 0)
          and (m.user_id is null or m.user_id <> ${meId})) as unread,
      coalesce((select max(m2.id) from ${sql(SCHEMA)}.messages m2 where m2.channel_id = c.id), 0) as last_id
    from ${sql(SCHEMA)}.channels c
    left join ${sql(SCHEMA)}.channel_reads r on r.channel_id = c.id and r.user_id = ${meId}
    where c.kind = 'channel'
       or exists (select 1 from ${sql(SCHEMA)}.channel_members cm where cm.channel_id = c.id and cm.user_id = ${meId})`;
  return (rows as Record<string, unknown>[]).map((r) => ({
    channel_id: Number(r.id), unread: Number(r.unread ?? 0), last_id: Number(r.last_id ?? 0),
  }));
}

async function threadMessages(sql: Sql, channelId: number, parentId: number): Promise<{ parent: Message; replies: Message[] }> {
  const [p] = await sql.unsafe(
    `select ${MSG_COLS} from workspace.messages m where m.id = $1 and m.channel_id = $2`,
    [parentId, channelId],
  ) as unknown as Record<string, unknown>[];
  if (!p) throw new HttpError(404, '스레드의 원래 메시지를 찾지 못했습니다.', 'no_parent');
  const rows = await sql.unsafe(
    `select ${MSG_COLS} from workspace.messages m where m.parent_id = $1 order by m.id asc limit 300`,
    [parentId],
  ) as unknown as Record<string, unknown>[];
  return { parent: asMessage(p), replies: rows.map(asMessage) };
}

/** Gemini 에 보낼 최근 대화 (스레드면 그 스레드만, 아니면 채널 전체) */
async function contextTurns(sql: Sql, channelId: number, parentId: number | null): Promise<Turn[]> {
  const rows = parentId == null
    ? await sql.unsafe(
      `select author_name, author_kind, content, attachments from workspace.messages
       where channel_id = $1 and parent_id is null order by id desc limit 12`, [channelId],
    ) as unknown as Record<string, unknown>[]
    : await sql.unsafe(
      `select author_name, author_kind, content, attachments from workspace.messages
       where parent_id = $1 order by id desc limit 12`, [parentId],
    ) as unknown as Record<string, unknown>[];
  return rows.reverse().map((r) => ({
    author: String(r.author_name ?? ''),
    kind: r.author_kind === 'ai' ? 'ai' as const : 'user' as const,
    content: String(r.content ?? ''),
    files: fileNotes(readAttachments(r.attachments)),
  }));
}

const MAX_CONTENT = 4000;
const mentionRe = /@\s?(ai|alter)\b/i;

// ---------- 알림 보내기 (응답을 막지 않게 백그라운드로) ----------
const bg = (p: Promise<unknown>) => {
  const er = (globalThis as { EdgeRuntime?: { waitUntil?: (q: Promise<unknown>) => void } }).EdgeRuntime;
  if (er?.waitUntil) { try { er.waitUntil(p); return; } catch { /* 아래로 */ } }
  p.catch(() => { /* notifyPush 안에서 이미 기록 */ });
};

async function notifyPush(sql: Sql, ch: Record<string, unknown>, m: Message) {
  if (!pushAvailable()) return;
  const cid = m.channel_id;
  const kind = String(ch.kind ?? 'channel');
  try {
    // 받는 사람: 보낸 사람을 뺀 구독자. 공개 채널은 구독한 모든 멤버, DM·AI 방은 그 채널의 멤버만.
    const rows = kind === 'channel'
      ? (m.user_id
        ? await sql`select endpoint, p256dh, auth from ${sql(SCHEMA)}.push_subscriptions where user_id <> ${m.user_id} limit 50`
        : await sql`select endpoint, p256dh, auth from ${sql(SCHEMA)}.push_subscriptions limit 50`)
      : (m.user_id
        ? await sql`select ps.endpoint, ps.p256dh, ps.auth from ${sql(SCHEMA)}.push_subscriptions ps
            join ${sql(SCHEMA)}.channel_members cm on cm.user_id = ps.user_id and cm.channel_id = ${cid}
            where ps.user_id <> ${m.user_id} limit 50`
        : await sql`select ps.endpoint, ps.p256dh, ps.auth from ${sql(SCHEMA)}.push_subscriptions ps
            join ${sql(SCHEMA)}.channel_members cm on cm.user_id = ps.user_id and cm.channel_id = ${cid} limit 50`);
    const subs = (rows as Record<string, unknown>[]).map((r) => ({
      endpoint: String(r.endpoint), p256dh: String(r.p256dh), auth: String(r.auth),
    }));
    if (!subs.length) return;
    const title = kind === 'channel'
      ? `#${String(ch.name)} · ${m.author_name}`
      : (kind === 'ai' ? 'Alter' : `${m.author_name} · DM`);
    const body = pushBody(m);
    const out = await sendPush(sql, subs, { title, body, tag: `workspace-${cid}`, url: '/workspace/' });
    console.log(FN, 'push', kind, cid, JSON.stringify(out));
  } catch (e) {
    console.error(FN, 'push', (e as Error)?.message ?? e);
  }
}

async function postMessage(sql: Sql, me: Member, ch: Record<string, unknown>, channelId: number, raw: string, parentId: number | null, rawAttachments: unknown = null) {
  const content = String(raw ?? '').replace(/\r\n/g, '\n').trim();
  const attachments = normAttachments(rawAttachments, me.id);
  if (!content && !attachments.length) throw new HttpError(400, '메시지 내용을 적거나 사진·파일을 붙여 주세요.', 'empty');
  if (content.length > MAX_CONTENT) throw new HttpError(413, `메시지가 너무 깁니다 (${MAX_CONTENT}자까지).`, 'too_long');

  let threadRoot: number | null = null;
  if (parentId != null) {
    const [p] = await sql`select id, parent_id from ${sql(SCHEMA)}.messages where id = ${parentId} and channel_id = ${channelId}`;
    if (!p) throw new HttpError(404, '답글을 달 메시지를 찾지 못했습니다.', 'no_parent');
    // 답글의 답글은 같은 스레드에 붙인다 (Slack 처럼 1단계 스레드)
    threadRoot = p.parent_id == null ? Number(p.id) : Number(p.parent_id);
  }

  const [row] = await sql`insert into ${sql(SCHEMA)}.messages (channel_id, parent_id, user_id, author_name, author_kind, content, attachments)
    values (${channelId}, ${threadRoot}, ${me.id}, ${me.name || '선생님'}, ${'user'}, ${content}, ${sql.json(attachments)}) returning *`;
  const message = asMessage(row);
  bg(notifyPush(sql, ch, message));

  const kind = String(ch.kind ?? 'channel');
  const wantsAi = kind === 'ai' || mentionRe.test(content);
  if (!wantsAi) return { message, ai: null };

  // AI 답글이 붙을 자리: AI 방의 최상위 글은 그 채널에, 그 밖에는 스레드에
  const aiParent: number | null = threadRoot != null ? threadRoot : (kind === 'ai' ? null : message.id);
  const turns = await contextTurns(sql, channelId, threadRoot);
  const channelName = kind === 'channel' ? '#' + String(ch.name) : String(ch.name);
  const res = await ask({ channel: channelName, turns, message: content, files: fileNotes(attachments) });
  try {
    const [aiRow] = await sql`insert into ${sql(SCHEMA)}.messages (channel_id, parent_id, user_id, author_name, author_kind, content)
      values (${channelId}, ${aiParent}, ${null}, ${'Alter'}, ${'ai'}, ${res.text}) returning *`;
    const ai = asMessage(aiRow);
    bg(notifyPush(sql, ch, ai));
    return { message, ai: { ...ai, source: res.source, model: res.source === 'gemini' ? (res.model ?? currentModel()) : null } };
  } catch (e) {
    console.error(FN, 'ai insert', (e as Error)?.message ?? e);
    return { message, ai: null, ai_error: 'Alter 의 답글을 저장하지 못했어요.' };
  }
}

// ---------- 라우팅 ----------
const route = (req: Request) => {
  const p = new URL(req.url).pathname; const i = p.indexOf('/' + FN);
  return (i < 0 ? '/' : p.slice(i + FN.length + 1)).replace(/\/+$/, '') || '/';
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(req) });
  const o = req.headers.get('Origin');
  if (o && !ORIGINS.includes(o)) return json(req, 403, { error: '허용되지 않은 출처입니다.' });
  const path = route(req);
  const sql = db;
  try {
    if (path === '/health') {
      if (!sql) return json(req, 503, { ok: false, db: false });
      await sql`select 1`;
      let schema = false;
      let counts: { channels?: number; members?: number; messages?: number } | null = null;
      try {
        await ensureSchema(sql);
        const rows = await sql.unsafe(`select
          (select count(*)::int from workspace.channels) as channels,
          (select count(*)::int from workspace.members) as members,
          (select count(*)::int from workspace.messages) as messages,
          (select count(*)::int from workspace.push_subscriptions) as push_subs`) as unknown as { channels: number; members: number; messages: number; push_subs: number }[];
        counts = rows?.[0] ?? null;
        schema = true;
      } catch (e) {
        console.error(FN, 'schema', (e as Error)?.message ?? e);
      }
      return json(req, 200, { ok: true, db: true, schema, ...(counts || {}), ai_last: lastAiResult(), push: pushAvailable(), function: FN });
    }

    const user = await getUser(req);
    if (path === '/hello') {
      return json(req, 200, {
        app: SCHEMA, user: user ? { id: user.id, email: user.email, name: user.name } : null,
        db: Boolean(sql), gemini_key_set: aiHasKey(), gemini_model: currentModel(), time: new Date().toISOString(),
      });
    }
    if (!sql) return json(req, 503, { error: '서버 설정이 아직 끝나지 않았습니다 (DB 연결 정보 없음).' });
    await ensureSchema(sql);

    // 여기부터는 로그인 + 이 앱 멤버만
    if (!user) return json(req, 401, { error: '로그인이 필요합니다. 다시 로그인해 주세요.' });
    const me = await memberFor(sql, user);

    if (path === '/bootstrap' && req.method === 'GET') {
      await ensureAiChannel(sql, me);
      const memberRows = await sql`select user_id, email, name, role, avatar_color, last_seen_at
        from ${sql(SCHEMA)}.members order by name asc, email asc limit 300`;
      const channelRows = await sql`select c.id, c.slug, c.name, c.kind, c.description, c.dm_key, c.created_at,
          (select count(*)::int from ${sql(SCHEMA)}.messages m
            where m.channel_id = c.id and m.id > coalesce(r.last_read_id, 0)
              and (m.user_id is null or m.user_id <> ${me.id})) as unread_count
        from ${sql(SCHEMA)}.channels c
        left join ${sql(SCHEMA)}.channel_reads r on r.channel_id = c.id and r.user_id = ${me.id}
        where c.kind = 'channel'
           or exists (select 1 from ${sql(SCHEMA)}.channel_members cm where cm.channel_id = c.id and cm.user_id = ${me.id})
        order by case c.kind when 'channel' then 0 when 'ai' then 2 else 1 end, c.id asc`;
      return json(req, 200, {
        me,
        members: (memberRows as Record<string, unknown>[]).map(asMember),
        channels: (channelRows as Record<string, unknown>[]).map(asChannel),
        gemini_key_set: aiHasKey(),
      });
    }

    if (path === '/push/key' && req.method === 'GET') {
      try {
        const v = await getVapid(sql);
        return json(req, 200, { publicKey: v.publicKey, subject: v.subject, available: pushAvailable() });
      } catch (e) {
        console.error(FN, 'vapid', (e as Error)?.message ?? e);
        return json(req, 500, { error: '알림 열쇠를 준비하지 못했어요. 잠시 뒤 다시 시도해 주세요.' });
      }
    }

    if (path === '/push/subscribe' && req.method === 'POST') {
      const raw = await req.text();
      if (raw.length > 8192) return json(req, 413, { error: '요청이 너무 큽니다.' });
      let b: { subscription?: { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } } };
      try { b = JSON.parse(raw || '{}'); } catch { return json(req, 400, { error: 'JSON 형식이 아닙니다.' }); }
      const sub = b.subscription ?? {};
      const endpoint = String(sub.endpoint ?? '');
      const p256dh = String(sub.keys?.p256dh ?? '');
      const auth = String(sub.keys?.auth ?? '');
      if (!/^https:\/\//.test(endpoint) || endpoint.length > 1000 || !p256dh || p256dh.length > 200 || !auth || auth.length > 100) {
        return json(req, 400, { error: '알림 구독 정보가 올바르지 않습니다.' });
      }
      await sql`insert into ${sql(SCHEMA)}.push_subscriptions (user_id, endpoint, p256dh, auth)
        values (${me.id}, ${endpoint}, ${p256dh}, ${auth})
        on conflict (endpoint) do update set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, created_at = now()`;
      return json(req, 201, { ok: true });
    }

    if (path === '/push/unsubscribe' && req.method === 'POST') {
      const raw = await req.text();
      if (raw.length > 4096) return json(req, 413, { error: '요청이 너무 큽니다.' });
      let b: { endpoint?: unknown };
      try { b = JSON.parse(raw || '{}'); } catch { return json(req, 400, { error: 'JSON 형식이 아닙니다.' }); }
      const endpoint = String(b.endpoint ?? '');
      if (!endpoint) return json(req, 400, { error: 'endpoint 가 필요합니다.' });
      await sql`delete from ${sql(SCHEMA)}.push_subscriptions where endpoint = ${endpoint} and user_id = ${me.id}`;
      return json(req, 200, { ok: true });
    }

    if (path === '/channels/read' && req.method === 'POST') {
      const raw = await req.text();
      if (raw.length > 4096) return json(req, 413, { error: '요청이 너무 큽니다.' });
      let b: { channel_id?: unknown };
      try { b = JSON.parse(raw || '{}'); } catch { return json(req, 400, { error: 'JSON 형식이 아닙니다.' }); }
      const channelId = Number(b.channel_id);
      if (!Number.isInteger(channelId) || channelId <= 0) return json(req, 400, { error: 'channel_id 가 필요합니다.' });
      await channelFor(sql, me.id, channelId);
      const [row] = await sql`select coalesce(max(id), 0) as last_id from ${sql(SCHEMA)}.messages where channel_id = ${channelId}`;
      const lastId = Number((row as Record<string, unknown> | undefined)?.last_id ?? 0);
      await sql`insert into ${sql(SCHEMA)}.channel_reads (user_id, channel_id, last_read_id, updated_at)
        values (${me.id}, ${channelId}, ${lastId}, now())
        on conflict (user_id, channel_id) do update
          set last_read_id = greatest(channel_reads.last_read_id, excluded.last_read_id), updated_at = now()`;
      return json(req, 200, { ok: true, channel_id: channelId, last_read_id: lastId });
    }

    if (path === '/channels' && req.method === 'POST') {
      const raw = await req.text();
      if (raw.length > 8192) return json(req, 413, { error: '요청이 너무 큽니다.' });
      let b: { kind?: unknown; name?: unknown; description?: unknown; target_user_id?: unknown };
      try { b = JSON.parse(raw || '{}'); } catch { return json(req, 400, { error: 'JSON 형식이 아닙니다.' }); }
      const kind = b.kind === 'dm' ? 'dm' : 'channel';

      if (kind === 'channel') {
        const name = String(b.name ?? '').replace(/^#+/, '').replace(/\s+/g, ' ').trim().slice(0, 40);
        if (!name) return json(req, 400, { error: '채널 이름을 적어 주세요.' });
        const desc = String(b.description ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
        const slug = 'c-' + crypto.randomUUID().slice(0, 8);
        const [row] = await sql`insert into ${sql(SCHEMA)}.channels (slug, name, kind, description, created_by)
          values (${slug}, ${name}, ${'channel'}, ${desc}, ${me.id}) returning *`;
        return json(req, 201, { channel: asChannel(row) });
      }

      const target = String(b.target_user_id ?? '');
      if (!/^[0-9a-f-]{36}$/i.test(target)) return json(req, 400, { error: '상대를 고르지 않았습니다.' });
      if (target === me.id) return json(req, 400, { error: '나와의 DM 은 AI 방을 쓰면 됩니다.' });
      const [other] = await sql`select user_id, name, email from ${sql(SCHEMA)}.members where user_id = ${target}`;
      if (!other) return json(req, 404, { error: '상대를 찾지 못했습니다.' });
      const key = [me.id, target].sort().join(':');
      const [created] = await sql`insert into ${sql(SCHEMA)}.channels (slug, name, kind, dm_key, created_by)
        values (${'dm-' + key.slice(0, 8) + '-' + crypto.randomUUID().slice(0, 4)}, ${String(other.name || other.email)}, ${'dm'}, ${key}, ${me.id})
        on conflict (dm_key) do nothing returning *`;
      let row = created as Record<string, unknown> | undefined;
      if (!row) {
        const [existing] = await sql`select * from ${sql(SCHEMA)}.channels where dm_key = ${key}`;
        row = existing as Record<string, unknown>;
      }
      if (!row) return json(req, 500, { error: 'DM 을 열지 못했습니다.' });
      await sql`insert into ${sql(SCHEMA)}.channel_members (channel_id, user_id)
        values (${Number(row.id)}, ${me.id}), (${Number(row.id)}, ${target}) on conflict do nothing`;
      return json(req, 201, { channel: asChannel(row) });
    }

    if (path === '/messages' && req.method === 'GET') {
      const q = new URL(req.url).searchParams;
      const channelId = Number(q.get('channel_id'));
      if (!Number.isInteger(channelId) || channelId <= 0) return json(req, 400, { error: 'channel_id 가 필요합니다.' });
      await channelFor(sql, me.id, channelId);
      const parent = q.get('parent_id');
      if (parent) {
        const parentId = Number(parent);
        if (!Number.isInteger(parentId) || parentId <= 0) return json(req, 400, { error: 'parent_id 가 올바르지 않습니다.' });
        const t = await threadMessages(sql, channelId, parentId);
        return json(req, 200, { channel_id: channelId, parent: t.parent, messages: t.replies, unread: await unreadFor(sql, me.id) });
      }
      const messages = await topMessages(sql, channelId);
      return json(req, 200, { channel_id: channelId, messages, unread: await unreadFor(sql, me.id) });
    }

    if (path === '/messages' && req.method === 'POST') {
      const raw = await req.text();
      if (raw.length > 64_000) return json(req, 413, { error: '요청이 너무 큽니다.' });
      let b: { channel_id?: unknown; content?: unknown; parent_id?: unknown; attachments?: unknown };
      try { b = JSON.parse(raw || '{}'); } catch { return json(req, 400, { error: 'JSON 형식이 아닙니다.' }); }
      const channelId = Number(b.channel_id);
      if (!Number.isInteger(channelId) || channelId <= 0) return json(req, 400, { error: 'channel_id 가 필요합니다.' });
      const parentRaw = b.parent_id == null ? null : Number(b.parent_id);
      if (parentRaw != null && (!Number.isInteger(parentRaw) || parentRaw <= 0)) return json(req, 400, { error: 'parent_id 가 올바르지 않습니다.' });
      const ch = await channelFor(sql, me.id, channelId);
      const out = await postMessage(sql, me, ch, channelId, String(b.content ?? ''), parentRaw, b.attachments);
      return json(req, 201, out);
    }

    return json(req, 404, { error: '없는 경로입니다.' });
  } catch (e) {
    if (e instanceof HttpError) return json(req, e.status, { error: e.message, code: e.code });
    console.error(FN, (e as { code?: string })?.code ?? '', (e as Error)?.message ?? e);
    return json(req, 500, { error: '서버 오류가 났습니다. 잠시 뒤 다시 시도해 주세요.' });
  }
});
