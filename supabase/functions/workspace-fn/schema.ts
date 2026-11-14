// workspace-fn 이 처음 살아날 때(콜드 스타트) 스스로 표를 만듭니다.
// supabase/migrations/202611140001_workspace_init.sql 과 같은 내용입니다 —
// 마이그레이션을 손으로 돌리지 않아도 앱이 바로 동작하게 하려는 안전장치예요.
// 함수는 표 주인 권한(workspace_fn ← workspace_dev)으로 접속하므로 만들 수 있습니다.

export const DDL: string[] = [
  `create table if not exists workspace.members (
    user_id uuid primary key,
    email text unique not null check (email = lower(email)),
    name text not null default '',
    role text not null default 'member' check (role in ('member', 'admin')),
    avatar_color text,
    created_at timestamptz not null default now(),
    last_seen_at timestamptz
  )`,

  `create table if not exists workspace.channels (
    id bigint generated always as identity primary key,
    slug text unique,
    name text not null check (char_length(name) between 1 and 60),
    kind text not null default 'channel' check (kind in ('channel', 'dm', 'ai')),
    description text not null default '' check (char_length(description) <= 300),
    dm_key text unique,
    created_by uuid,
    created_at timestamptz not null default now()
  )`,

  `create table if not exists workspace.channel_members (
    channel_id bigint not null references workspace.channels(id) on delete cascade,
    user_id uuid not null,
    primary key (channel_id, user_id)
  )`,

  `create table if not exists workspace.messages (
    id bigint generated always as identity primary key,
    channel_id bigint not null references workspace.channels(id) on delete cascade,
    parent_id bigint references workspace.messages(id) on delete cascade,
    user_id uuid,
    author_name text not null check (char_length(author_name) between 1 and 80),
    author_kind text not null default 'user' check (author_kind in ('user', 'ai')),
    content text not null default '' check (char_length(content) <= 8000),
    attachments jsonb not null default '[]'::jsonb,
    created_at timestamptz not null default now(),
    constraint messages_body_check check (char_length(content) > 0 or jsonb_array_length(attachments) > 0)
  )`,

  `create index if not exists messages_channel_idx on workspace.messages (channel_id, id)`,
  `create index if not exists messages_parent_idx on workspace.messages (parent_id, id) where parent_id is not null`,

  // ---------- 사진·파일 첨부 (이미 있는 표에도 더한다) ----------
  // 파일 자체는 Storage 버킷 'workspace' 에 <내 아이디>/<시각>-<무작위>.<확장자> 로 올리고,
  // 여기에는 [{ path, name, mime, size }] 만 적는다 (한글 파일 이름은 여기에만, 경로에는 쓰지 않는다).
  `alter table workspace.messages add column if not exists attachments jsonb not null default '[]'::jsonb`,
  // 글 없이 사진·파일만 보내는 메시지를 위해 '1자 이상' 조건을 '0자 이상'으로 바꾼다 (내용은 함수가 확인)
  `do $$ begin
     alter table workspace.messages drop constraint if exists messages_content_check;
   exception when others then null; end $$`,
  `do $$ begin
     alter table workspace.messages add constraint messages_content_check check (char_length(content) <= 8000);
   exception when duplicate_object then null; when others then null; end $$`,
  `do $$ begin
     alter table workspace.messages add constraint messages_body_check check (char_length(content) > 0 or jsonb_array_length(attachments) > 0);
   exception when duplicate_object then null; when others then null; end $$`,

  `create or replace function workspace.is_member() returns boolean
   language sql stable security definer set search_path = '' as $$
     select exists (select 1 from workspace.members m where m.user_id = (select bmr.uid()))
   $$`,

  `create or replace function workspace.is_channel_member(cid bigint) returns boolean
   language sql stable security definer set search_path = '' as $$
     select exists (select 1 from workspace.channel_members cm where cm.channel_id = cid and cm.user_id = (select bmr.uid()))
   $$`,

  `create or replace function workspace.can_read_channel(cid bigint) returns boolean
   language sql stable security definer set search_path = '' as $$
     select exists (
       select 1 from workspace.channels c
       where c.id = cid
         and exists (select 1 from workspace.members m where m.user_id = (select bmr.uid()))
         and (c.kind = 'channel'
           or exists (select 1 from workspace.channel_members cm where cm.channel_id = c.id and cm.user_id = (select bmr.uid())))
     )
   $$`,

  `alter table workspace.members enable row level security`,
  `alter table workspace.channels enable row level security`,
  `alter table workspace.channel_members enable row level security`,
  `alter table workspace.messages enable row level security`,

  `drop policy if exists "멤버끼리 보기" on workspace.members`,
  `create policy "멤버끼리 보기" on workspace.members for select to authenticated
     using ((select workspace.is_member()))`,

  `drop policy if exists "볼 수 있는 채널만" on workspace.channels`,
  `create policy "볼 수 있는 채널만" on workspace.channels for select to authenticated
     using ((select workspace.is_member()) and (kind = 'channel' or (select workspace.is_channel_member(id))))`,

  `drop policy if exists "내가 든 채널만" on workspace.channel_members`,
  `create policy "내가 든 채널만" on workspace.channel_members for select to authenticated
     using ((select workspace.is_member()) and user_id = (select bmr.uid()))`,

  `drop policy if exists "볼 수 있는 채널의 메시지만" on workspace.messages`,
  `create policy "볼 수 있는 채널의 메시지만" on workspace.messages for select to authenticated
     using ((select workspace.can_read_channel(channel_id)))`,

  `grant usage on schema workspace to authenticated, anon`,
  `grant select on workspace.members, workspace.channels, workspace.channel_members, workspace.messages to authenticated`,

  // ---------- 알림(Web Push) — 브라우저는 읽지도 쓰지도 않고, 함수만 다룬다 ----------
  `create table if not exists workspace.push_subscriptions (
    id bigint generated always as identity primary key,
    user_id uuid not null,
    endpoint text unique not null,
    p256dh text not null,
    auth text not null,
    created_at timestamptz not null default now()
  )`,
  `create index if not exists push_subscriptions_user_idx on workspace.push_subscriptions (user_id)`,
  `create table if not exists workspace.push_config (
    id int primary key default 1,
    public_key text not null,
    private_jwk jsonb not null,
    subject text not null
  )`,
  `alter table workspace.push_subscriptions enable row level security`,
  `alter table workspace.push_config enable row level security`,

  // ---------- 읽음 표시 — 채널별로 마지막으로 본 메시지 번호 (함수만 읽고 쓴다) ----------
  `create table if not exists workspace.channel_reads (
    user_id uuid not null,
    channel_id bigint not null references workspace.channels(id) on delete cascade,
    last_read_id bigint not null default 0,
    updated_at timestamptz not null default now(),
    primary key (user_id, channel_id)
  )`,
  `alter table workspace.channel_reads enable row level security`,

  // 실시간 구독용 (프로젝트 설정에 따라 권한이 없을 수 있음 — 실패해도 앱은 폴링으로 동작)
  `do $$ begin
     alter publication supabase_realtime add table workspace.messages;
   exception when others then null; end $$`,
  `do $$ begin
     alter publication supabase_realtime add table workspace.channels;
   exception when others then null; end $$`,
];

// 기본 채널 — 콜드 스타트마다 한 번(이미 있으면 그대로 둠)
export const SEED_CHANNELS = `insert into workspace.channels (slug, name, kind, description) values
  ('general',     '일반',      'channel', '모두에게 알리는 이야기'),
  ('class-share', '수업-나눔', 'channel', '수업 아이디어와 자료를 나눠요'),
  ('ai-lounge',   'AI-라운지', 'channel', '@AI 를 부르면 Alter 가 답글을 달아 줘요')
on conflict (slug) do nothing`;

/** 빠른 확인: 핵심 표가 이미 있는지 (있으면 DDL 을 건너뛴다) */
export const CHECK_TABLES = `select
  to_regclass('workspace.members')            is not null as members,
  to_regclass('workspace.channels')           is not null as channels,
  to_regclass('workspace.messages')           is not null as messages,
  to_regclass('workspace.push_subscriptions') is not null as push,
  to_regclass('workspace.push_config')        is not null as push_config,
  to_regclass('workspace.channel_reads')      is not null as reads,
  exists (select 1 from information_schema.columns
     where table_schema = 'workspace' and table_name = 'messages' and column_name = 'attachments') as attachments`;
