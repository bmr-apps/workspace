// workspace-fn — 별무리 워크스페이스 서버 함수
//
// 주소: https://psupfmarnyxontorftio.supabase.co/functions/v1/workspace-fn/<경로>
//   GET  /health                                  DB·표 연결 확인
//   GET  /hello                                   부른 사람, AI 열쇠 설정 여부
//   GET  /bootstrap                               나·멤버·채널 목록 (기본 채널과 내 AI 방을 만들어 줌)
//   POST /channels      {kind:'channel', name, description} | {kind:'dm', target_user_id}
//   GET  /messages?channel_id=…[&parent_id=…]     채널 메시지 / 스레드 답글
//   POST /messages      {channel_id, content, parent_id?}  메시지 쓰기 (+ @AI 면 Alter 답글)
//
// 함수는 이 앱 전용 DB 계정(workspace_fn, 개발자 계정 권한을 물려받음)으로 접속해 RLS 를 거치지 않습니다.
// 그래서 누가 무엇을 볼 수 있는지는 이 파일에서 직접 확인합니다 (memberFor / channelFor).
// 비밀값: WORKSPACE_DB_URL, WORKSPACE_GEMINI_API_KEY, WORKSPACE_GEMINI_MODEL(선택)
import postgres from 'npm:postgres@3.4.5';
import { DDL, SEED_CHANNELS, CHECK_TABLES } from './schema.ts';
import { ask, hasKey as aiHasKey, model as aiModel, type Turn } from './ai.ts';

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
        const rows = await sql.unsafe(CHECK_TABLES) as unknown as { members?: boolean; channels?: boolean; messages?: boolean }[];
        const t = rows?.[0] ?? {};
        fresh = !(t.members && t.channels && t.messages);
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
      const rows = await sql.unsafe(CHECK_TABLES) as unknown as { members?: boolean; channels?: boolean; messages?: boolean }[];
      const t = rows?.[0] ?? {};
      if (!(t.members && t.channels && t.messages)) throw new Error('표를 만들지 못했습니다');
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
type Channel = { id: number; slug: string | null; name: string; kind: 'channel' | 'dm' | 'ai'; description: string; dm_key: string | null; created_at: string };
type Message = {
  id: number; channel_id: number; parent_id: number | null; user_id: string | null;
  author_name: string; author_kind: 'user' | 'ai'; content: string; created_at: string; reply_count: number;
};

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
});
const asMessage = (r: Record<string, unknown>): Message => ({
  id: Number(r.id), channel_id: Number(r.channel_id),
  parent_id: r.parent_id == null ? null : Number(r.parent_id),
  user_id: r.user_id == null ? null : String(r.user_id),
  author_name: String(r.author_name ?? ''), author_kind: r.author_kind === 'ai' ? 'ai' : 'user',
  content: String(r.content ?? ''), created_at: String(iso(r.created_at) ?? ''),
  reply_count: Number(r.reply_count ?? 0),
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
const MSG_COLS = `m.id, m.channel_id, m.parent_id, m.user_id, m.author_name, m.author_kind, m.content, m.created_at,
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
      `select author_name, author_kind, content from workspace.messages
       where channel_id = $1 and parent_id is null order by id desc limit 12`, [channelId],
    ) as unknown as Record<string, unknown>[]
    : await sql.unsafe(
      `select author_name, author_kind, content from workspace.messages
       where parent_id = $1 order by id desc limit 12`, [parentId],
    ) as unknown as Record<string, unknown>[];
  return rows.reverse().map((r) => ({
    author: String(r.author_name ?? ''),
    kind: r.author_kind === 'ai' ? 'ai' as const : 'user' as const,
    content: String(r.content ?? ''),
  }));
}

const MAX_CONTENT = 4000;
const mentionRe = /@\s?(ai|alter)\b/i;

async function postMessage(sql: Sql, me: Member, ch: Record<string, unknown>, channelId: number, raw: string, parentId: number | null) {
  const content = String(raw ?? '').replace(/\r\n/g, '\n').trim();
  if (!content) throw new HttpError(400, '메시지 내용을 적어 주세요.', 'empty');
  if (content.length > MAX_CONTENT) throw new HttpError(413, `메시지가 너무 깁니다 (${MAX_CONTENT}자까지).`, 'too_long');

  let threadRoot: number | null = null;
  if (parentId != null) {
    const [p] = await sql`select id, parent_id from ${sql(SCHEMA)}.messages where id = ${parentId} and channel_id = ${channelId}`;
    if (!p) throw new HttpError(404, '답글을 달 메시지를 찾지 못했습니다.', 'no_parent');
    // 답글의 답글은 같은 스레드에 붙인다 (Slack 처럼 1단계 스레드)
    threadRoot = p.parent_id == null ? Number(p.id) : Number(p.parent_id);
  }

  const [row] = await sql`insert into ${sql(SCHEMA)}.messages (channel_id, parent_id, user_id, author_name, author_kind, content)
    values (${channelId}, ${threadRoot}, ${me.id}, ${me.name || '선생님'}, ${'user'}, ${content}) returning *`;
  const message = asMessage(row);

  const kind = String(ch.kind ?? 'channel');
  const wantsAi = kind === 'ai' || mentionRe.test(content);
  if (!wantsAi) return { message, ai: null };

  // AI 답글이 붙을 자리: AI 방의 최상위 글은 그 채널에, 그 밖에는 스레드에
  const aiParent: number | null = threadRoot != null ? threadRoot : (kind === 'ai' ? null : message.id);
  const turns = await contextTurns(sql, channelId, threadRoot);
  const channelName = kind === 'channel' ? '#' + String(ch.name) : String(ch.name);
  const res = await ask({ channel: channelName, turns, message: content });
  try {
    const [aiRow] = await sql`insert into ${sql(SCHEMA)}.messages (channel_id, parent_id, user_id, author_name, author_kind, content)
      values (${channelId}, ${aiParent}, ${null}, ${'Alter'}, ${'ai'}, ${res.text}) returning *`;
    return { message, ai: { ...asMessage(aiRow), source: res.source, model: res.source === 'gemini' ? aiModel() : null } };
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
          (select count(*)::int from workspace.messages) as messages`) as unknown as { channels: number; members: number; messages: number }[];
        counts = rows?.[0] ?? null;
        schema = true;
      } catch (e) {
        console.error(FN, 'schema', (e as Error)?.message ?? e);
      }
      return json(req, 200, { ok: true, db: true, schema, ...(counts || {}), function: FN });
    }

    const user = await getUser(req);
    if (path === '/hello') {
      return json(req, 200, {
        app: SCHEMA, user: user ? { id: user.id, email: user.email, name: user.name } : null,
        db: Boolean(sql), gemini_key_set: aiHasKey(), gemini_model: aiModel(), time: new Date().toISOString(),
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
      const channelRows = await sql`select c.id, c.slug, c.name, c.kind, c.description, c.dm_key, c.created_at
        from ${sql(SCHEMA)}.channels c
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
        return json(req, 200, { channel_id: channelId, parent: t.parent, messages: t.replies });
      }
      const messages = await topMessages(sql, channelId);
      return json(req, 200, { channel_id: channelId, messages });
    }

    if (path === '/messages' && req.method === 'POST') {
      const raw = await req.text();
      if (raw.length > 64_000) return json(req, 413, { error: '요청이 너무 큽니다.' });
      let b: { channel_id?: unknown; content?: unknown; parent_id?: unknown };
      try { b = JSON.parse(raw || '{}'); } catch { return json(req, 400, { error: 'JSON 형식이 아닙니다.' }); }
      const channelId = Number(b.channel_id);
      if (!Number.isInteger(channelId) || channelId <= 0) return json(req, 400, { error: 'channel_id 가 필요합니다.' });
      const parentRaw = b.parent_id == null ? null : Number(b.parent_id);
      if (parentRaw != null && (!Number.isInteger(parentRaw) || parentRaw <= 0)) return json(req, 400, { error: 'parent_id 가 올바르지 않습니다.' });
      const ch = await channelFor(sql, me.id, channelId);
      const out = await postMessage(sql, me, ch, channelId, String(b.content ?? ''), parentRaw);
      return json(req, 201, out);
    }

    return json(req, 404, { error: '없는 경로입니다.' });
  } catch (e) {
    if (e instanceof HttpError) return json(req, e.status, { error: e.message, code: e.code });
    console.error(FN, (e as { code?: string })?.code ?? '', (e as Error)?.message ?? e);
    return json(req, 500, { error: '서버 오류가 났습니다. 잠시 뒤 다시 시도해 주세요.' });
  }
});
