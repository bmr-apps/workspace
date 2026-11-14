// 미리보기(연습)용 백엔드 — 서버 함수가 아직 배포되지 않았거나 AI 열쇠가 없을 때도
// 화면 전체를 그대로 써 볼 수 있게, 이 브라우저 안에서만 도는 가짜 데이터로 같은 모양의 답을 돌려줍니다.
// 아무것도 저장하지 않습니다(새로 고치면 처음 상태로 돌아갑니다).

const MIN = 60_000;
const iso = (ms) => new Date(ms).toISOString();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let seq = 1000;

const ME = {
  id: 'u-me', email: 'preview@bmrschool.net', name: '나 (미리보기)', role: 'member',
  avatar_color: '#ffdc1a', last_seen_at: iso(Date.now()),
};
const MEMBERS = [
  { id: 'u-haneul', email: 'haneul@bmrschool.org', name: '김하늘', role: 'member', avatar_color: '#0abbee', last_seen_at: iso(Date.now() - 40 * MIN) },
  { id: 'u-seoyun', email: 'seoyun@bmrschool.org', name: '이서윤', role: 'member', avatar_color: '#02c245', last_seen_at: iso(Date.now() - 95 * MIN) },
  { id: 'u-junho', email: 'junho@bmrschool.org', name: '박준호', role: 'member', avatar_color: '#7e65c1', last_seen_at: iso(Date.now() - 300 * MIN) },
  { id: 'u-minji', email: 'minji@bmrschool.org', name: '최민지', role: 'member', avatar_color: '#ff614a', last_seen_at: iso(Date.now() - 26 * 60 * MIN) },
  ME,
];

const CHANNELS = [
  { id: 1, slug: 'general', name: '일반', kind: 'channel', description: '모두에게 알리는 이야기', dm_key: null, created_at: iso(Date.now() - 3 * 24 * 60 * MIN) },
  { id: 2, slug: 'class-share', name: '수업-나눔', kind: 'channel', description: '수업 아이디어와 자료를 나눠요', dm_key: null, created_at: iso(Date.now() - 3 * 24 * 60 * MIN) },
  { id: 3, slug: 'ai-lounge', name: 'AI-라운지', kind: 'channel', description: '@AI 를 부르면 Alter 가 답글을 달아 줘요', dm_key: null, created_at: iso(Date.now() - 3 * 24 * 60 * MIN) },
  { id: 4, slug: 'ai-u-me', name: '🤖 Alter (AI)', kind: 'ai', description: 'Alter 와 1:1로 묻고 답하는 나만의 방', dm_key: 'ai:u-me', created_at: iso(Date.now() - 3 * 24 * 60 * MIN) },
  { id: 5, slug: 'dm-u-haneul', name: '김하늘', kind: 'dm', description: '', dm_key: 'dm:u-haneul:u-me', created_at: iso(Date.now() - 2 * 24 * 60 * MIN) },
];

function seedMessages() {
  const t = (mins) => iso(Date.now() - mins * MIN);
  const m = (channel_id, author, content, mins, parent_id = null, kind = 'user') => ({
    id: ++seq, channel_id, parent_id, user_id: kind === 'ai' ? null : (MEMBERS.find((x) => x.name === author) || ME).id,
    author_name: author, author_kind: kind, content, created_at: t(mins), reply_count: 0,
  });
  const list = [
    m(1, '김하늘', '이번 주 금요일 6교시에 전체 자율활동 시간이 있어요. 각 반에서 안내 부탁드립니다.', 320),
    m(1, '이서윤', '확인했습니다. 2학년은 진로 활동으로 잡아 두었어요.', 306),
    m(1, '나 (미리보기)', '10학년은 별드림관에서 독서 토론으로 진행하겠습니다.', 240),
    m(1, '박준호', '이번 주 과학실 정리 도와주실 분 계실까요? 금요일 방과 후면 좋겠습니다.', 120),
    m(1, '최민지', '제가 금요일 4시에 갈 수 있어요. 실험 기구는 어디에 모아 둘까요?', 62),
    m(2, '이서윤', '중핵 수업 3차시에서 "질문 만들기" 활동을 넣어 봤는데 반응이 좋았어요.', 180),
    m(2, '김하늘', '질문 카드 템플릿 공유해 주실 수 있나요? 수학에도 써 보고 싶어요.', 150),
    m(2, '나 (미리보기)', '저도 다음 주에 비슷한 활동을 해 보려고 합니다. @AI 도움 받아 루브릭을 다듬어 볼게요.', 95),
    m(3, '나 (미리보기)', '국어 수업에서 짧은 글쓰기 피드백을 효율적으로 주는 방법이 있을까요?', 200),
    m(3, 'Alter', '**세 단계로 나눠 보세요.**\n\n- **1단계(즉시)**: 맞춤법·문장부호만 표시 (기호 3개 이내)\n- **2단계(수업 중)**: "좋은 점 1 + 고칠 점 1"을 쪽지로\n- **3단계(다음 시간)**: 모둠에서 서로 읽고 한 줄 코멘트\n\n한 번에 다 고치려 하면 선생님도 지치고 학생도 문장만 보게 됩니다. 오늘은 1단계만 해 보시고, 다음 시간에 3단계를 붙여 보세요.', 192, null, 'ai'),
    m(4, 'Alter', '안녕하세요, Alter 입니다. 수업 준비, 문서 정리, 일정 확인처럼 손이 가는 일을 도와드려요. 편하게 물어보세요. 🙂', 260, null, 'ai'),
    m(5, '김하늘', '선생님, 내일 3교시 자료 출력실에 맡겨 둘까요?', 80),
  ];
  // 스레드 예시: 수업-나눔의 질문 카드 글에 답글 2개
  const parent = list.find((x) => x.content.startsWith('중핵 수업 3차시'));
  list.push(m(2, '김하늘', '좋아요! 템플릿 감사합니다. 수학은 "왜 그렇게 생각했나요?" 카드로 바꿔 써 볼게요.', 140, parent.id));
  list.push(m(2, '이서윤', '그 표현 좋네요. 다음 주 공유 때 같이 이야기해요.', 130, parent.id));
  for (const p of list) if (p.parent_id) { const par = list.find((x) => x.id === p.parent_id); if (par) par.reply_count += 1; }
  return list.sort((a, b) => a.id - b.id);
}

let db = null;
let unreadState = {};
function reset() {
  db = { channels: CHANNELS.map((c) => ({ ...c })), messages: seedMessages() };
  // 연습용 안 읽은 배지 (2번 #수업-나눔 2개, 5번 김하늘 DM 1개)
  unreadState = { 2: 2, 5: 1 };
}

function unreadList() {
  return Object.entries(unreadState).map(([id, n]) => ({ channel_id: Number(id), unread: Number(n), last_id: 0 }));
}

function aiReply(text, channelName) {
  const t = text.replace(/@\s?(ai|alter)/gi, '').trim();
  const hello = /^(안녕|하이|hello|hi)/i.test(t);
  const askEval = /(평가|루브릭|채점|피드백)/.test(t);
  const askPlan = /(수업|차시|활동|아이디어|설계)/.test(t);
  const askWhen = /(일정|언제|날짜|시간)/.test(t);
  const askSummary = /(요약|정리)/.test(t);

  if (hello) {
    return '안녕하세요! 지금은 **미리보기**라 정해진 예시로 답하고 있어요.\n\n실제 대화에서는 이 워크스페이스의 흐름을 읽고 답합니다. 오른쪽 아래 `@AI` 버튼으로 불러 보세요.';
  }
  if (askEval) {
    return [
      '평가 기준은 **관찰 가능한 행동**으로 세 문장만 만들어 보세요.',
      '',
      '1. **내용** — 주제에 맞는 근거를 2가지 이상 댄다.',
      '2. **구성** — 처음·가운데·끝이 드러나게 쓴다.',
      '3. **태도** — 동료의 글을 읽고 한 줄 이상 반응한다.',
      '',
      `> "${t.slice(0, 40)}" 에 맞춰 4단계(상·중·하·노력 필요)로만 나누면 채점이 빨라집니다.`,
      '',
      '원하시면 이 기준으로 학생용 체크리스트 문장까지 만들어 드릴게요. (미리보기 예시 답변)',
    ].join('\n');
  }
  if (askPlan) {
    return [
      '**한 차시로 줄여 보는 구성**을 제안합니다.',
      '',
      '- **도입 5분** — 지난 시간 결과물 한 장을 보여 주고 "무엇이 달라졌나" 묻기',
      '- **전개 30분** — 모둠별 질문 카드 3장 만들기 → 서로 바꿔 답하기',
      '- **정리 10분** — 가장 좋은 질문 1개를 칠판에 붙이고 이유 말하기',
      '',
      '준비물은 A5 카드와 마커면 충분합니다. 학생 수가 많으면 카드 수를 2장으로 줄이세요. (미리보기 예시 답변)',
    ].join('\n');
  }
  if (askWhen) {
    return [
      '학교 일정은 제가 임의로 말씀드리면 안 되는 부분이라, **캘린더나 학사일정표**로 확인해 주세요.',
      '',
      '- 이번 주 일정은 BMR APPS 캘린더에서 확인',
      '- 변경된 일정은 이 채널에 공지로 남기기',
      '',
      '원하시면 공지 문장 초안은 만들어 드릴 수 있어요. (미리보기 예시 답변)',
    ].join('\n');
  }
  if (askSummary) {
    return [
      `**${channelName} 요약 (예시)**`,
      '',
      '- 금요일 자율활동 시간 안내 — 반별 진행 확인 필요',
      '- 과학실 정리 도움 요청 — 금요일 방과 후',
      '- 수업 나눔: 질문 카드 활동 공유',
      '',
      '실제 모드에서는 이 채널의 최근 대화 12개를 읽고 정리합니다. (미리보기 예시 답변)',
    ].join('\n');
  }
  return [
    `"${t.slice(0, 60)}" 에 대해 정리해 봤어요.`,
    '',
    '- **먼저 확인할 것** — 지금 상황에서 꼭 필요한 자료가 무엇인지 한 가지로 좁히기',
    '- **바로 할 수 있는 일** — 10분 안에 끝나는 작은 단계 하나 정하기',
    '- **다음 사람에게 넘길 것** — 공유가 필요한 부분은 이 채널에 한 줄로 남기기',
    '',
    '이 답변은 **미리보기용 예시**입니다. 실제 모드에서는 대화 맥락을 읽고 더 구체적으로 답해요.',
  ].join('\n');
}

function channelOf(id) { return db.channels.find((c) => c.id === Number(id)); }
function findMessage(id) { return db.messages.find((m) => m.id === Number(id)); }
function publicMessage(m) { return { ...m, reply_count: db.messages.filter((r) => r.parent_id === m.id).length }; }

export const previewApi = {
  mode: 'preview',
  label: '미리보기',

  async bootstrap() {
    reset();
    return {
      me: { ...ME, last_seen_at: iso(Date.now()) },
      members: MEMBERS.map((m) => ({ ...m })),
      channels: db.channels.map((c) => ({ ...c, unread: unreadState[c.id] || 0 })),
      gemini_key_set: false,
      preview: true,
    };
  },

  async messages(channelId) {
    if (!channelOf(channelId)) throw new Error('없는 채널입니다.');
    return {
      channel_id: Number(channelId),
      messages: db.messages.filter((m) => m.channel_id === Number(channelId) && m.parent_id == null)
        .sort((a, b) => a.id - b.id).map(publicMessage),
      unread: unreadList(),
    };
  },

  async thread(channelId, parentId) {
    const parent = findMessage(parentId);
    if (!parent) throw new Error('스레드의 원래 메시지를 찾지 못했습니다.');
    return {
      channel_id: Number(channelId),
      parent: publicMessage(parent),
      messages: db.messages.filter((m) => m.parent_id === Number(parentId)).sort((a, b) => a.id - b.id).map(publicMessage),
      unread: unreadList(),
    };
  },

  async markRead(channelId) {
    delete unreadState[Number(channelId)];
    return { ok: true, channel_id: Number(channelId), last_read_id: 0 };
  },

  async post({ channelId, content, parentId }) {
    const ch = channelOf(channelId);
    if (!ch) throw new Error('없는 채널입니다.');
    const text = String(content || '').trim();
    if (!text) throw new Error('메시지 내용을 적어 주세요.');
    let root = null;
    if (parentId != null) root = findMessage(parentId) ? (findMessage(parentId).parent_id ?? Number(parentId)) : null;

    const msg = {
      id: ++seq, channel_id: Number(channelId), parent_id: root, user_id: ME.id,
      author_name: ME.name, author_kind: 'user', content: text, created_at: iso(Date.now()), reply_count: 0,
    };
    db.messages.push(msg);

    const wantsAi = ch.kind === 'ai' || /@\s?(ai|alter)\b/i.test(text);
    if (!wantsAi) return { message: publicMessage(msg), ai: null };

    await sleep(700);
    const aiParent = root != null ? root : (ch.kind === 'ai' ? null : msg.id);
    const ai = {
      id: ++seq, channel_id: Number(channelId), parent_id: aiParent, user_id: null,
      author_name: 'Alter', author_kind: 'ai', content: aiReply(text, ch.kind === 'channel' ? '#' + ch.name : ch.name),
      created_at: iso(Date.now()), reply_count: 0, source: 'preview',
    };
    db.messages.push(ai);
    return { message: publicMessage(msg), ai: publicMessage(ai) };
  },

  async createChannel({ name, description }) {
    const clean = String(name || '').replace(/^#+/, '').replace(/\s+/g, ' ').trim().slice(0, 40);
    if (!clean) throw new Error('채널 이름을 적어 주세요.');
    const ch = {
      id: ++seq, slug: 'c-' + seq, name: clean, kind: 'channel',
      description: String(description || '').trim().slice(0, 200), dm_key: null, created_at: iso(Date.now()),
    };
    db.channels.push(ch);
    return { channel: { ...ch } };
  },

  async openDm(targetUserId) {
    const other = MEMBERS.find((m) => m.id === targetUserId);
    if (!other) throw new Error('상대를 찾지 못했습니다.');
    const key = ['dm', ME.id, other.id].sort().join(':');
    const found = db.channels.find((c) => c.dm_key === key || c.dm_key === `dm:${other.id}:${ME.id}`);
    if (found) return { channel: { ...found } };
    const ch = { id: ++seq, slug: 'dm-' + seq, name: other.name, kind: 'dm', description: '', dm_key: key, created_at: iso(Date.now()) };
    db.channels.push(ch);
    return { channel: { ...ch } };
  },

  // 미리보기는 실시간 구독이 없습니다 (5초 폴링도 필요 없음)
  subscribe() { return () => {}; },

  reset,
};
