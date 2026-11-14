// Alter(AI) 답변 만들기 — Gemini 를 서버에서만 부릅니다.
// 키는 함수 비밀값 WORKSPACE_GEMINI_API_KEY 에서 읽고, 브라우저에는 절대 내려보내지 않습니다.
// 모델은 WORKSPACE_GEMINI_MODEL 로 바꿀 수 있고, 없으면 gemini-2.5-flash 를 씁니다.

const PREFIX = 'WORKSPACE_';
const key = () => Deno.env.get(PREFIX + 'GEMINI_API_KEY') ?? '';
export const model = () => Deno.env.get(PREFIX + 'GEMINI_MODEL')?.trim() || 'gemini-2.5-flash';
export const hasKey = () => key() !== '';

export type Turn = { author: string; kind: 'user' | 'ai'; content: string };

const SYSTEM = [
  '너는 별무리학교의 교내 워크스페이스에서 함께 일하는 AI 조력자 "Alter" 다.',
  '선생님들이 채널과 스레드에서 나누는 대화를 읽고, 물어본 것에 바로 쓸 수 있는 답을 준다.',
  '규칙:',
  '- 한국어로, 정중하지만 사무적인 인사말 없이 바로 본론부터 쓴다. 보통 3~8문장, 필요하면 짧은 목록.',
  '- 대화에 없는 사실(학교 일정, 학생 개인정보, 성적, 연락처)은 지어내지 않는다. 모르면 모른다고 하고 무엇을 확인하면 되는지 알려 준다.',
  '- 학생 이름·연락처 같은 개인정보가 보이면 답변에 다시 옮겨 적지 않는다.',
  '- 마크다운을 써도 된다(굵게, 목록, `코드`, ```코드블록```). 표는 쓰지 않는다.',
  '- 교사가 바로 실행할 수 있는 다음 행동을 한 가지 이상 제안한다.',
].join('\n');

/** 최근 대화를 프롬프트로 정리 (너무 길면 잘라 냄) */
function buildPrompt(channel: string, turns: Turn[], ask: string): string {
  const lines = turns.slice(-12).map((t) => {
    const who = t.kind === 'ai' ? 'Alter' : t.author || '선생님';
    const text = t.content.replace(/\s+/g, ' ').slice(0, 700);
    return `${who}: ${text}`;
  });
  return [
    `[채널] ${channel}`,
    '[최근 대화]',
    lines.length ? lines.join('\n') : '(아직 대화가 없습니다)',
    '[답할 메시지]',
    ask.slice(0, 2000),
  ].join('\n');
}

export type AiResult = { text: string; source: 'gemini' | 'fallback' | 'error' };

const FALLBACK = [
  '지금은 제 AI 열쇠(`WORKSPACE_GEMINI_API_KEY`)가 아직 연결되지 않아서 실제 답변을 만들 수 없어요.',
  '',
  '관리자분이 BMR APPS 허브 → 내 서비스 → 앱 정보 → **개발자 셀프서비스 → 함수 비밀값**에 `WORKSPACE_GEMINI_API_KEY` 를 넣고, **서버 함수 자동 배포**를 켜면 바로 대화할 수 있습니다.',
  '',
  '그동안에도 이 워크스페이스는 그대로 쓸 수 있어요. 채널에 글을 남기고 스레드로 이어 가면 됩니다. 🙂',
].join('\n');

/** Alter 의 답변 한 개. 실패해도 예외를 던지지 않고 사람이 읽을 수 있는 문장을 돌려줍니다. */
export async function ask(opts: { channel: string; turns: Turn[]; message: string }): Promise<AiResult> {
  const k = key();
  if (!k) return { text: FALLBACK, source: 'fallback' };
  const m = model();
  let status = 0;
  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(m)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': k },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: SYSTEM }] },
        contents: [{ role: 'user', parts: [{ text: buildPrompt(opts.channel, opts.turns, opts.message) }] }],
        generationConfig: { temperature: 0.6, maxOutputTokens: 1200 },
      }),
      signal: AbortSignal.timeout(60_000),
    });
    status = r.status;
    const raw = await r.text();
    if (r.status >= 400) {
      console.error('gemini', r.status, raw.slice(0, 300));
      return { text: explain(status), source: 'error' };
    }
    const j = JSON.parse(raw) as {
      candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[];
      promptFeedback?: { blockReason?: string };
    };
    const text = (j.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? '').join('').trim();
    if (!text) {
      const blocked = j.promptFeedback?.blockReason || j.candidates?.[0]?.finishReason || '';
      return { text: blocked ? `이 내용에는 답하기 어려워요 (${blocked}). 다른 말로 다시 물어봐 주세요.` : '답변을 만들지 못했어요. 다시 한 번 물어봐 주세요.', source: 'error' };
    }
    return { text: text.slice(0, 6000), source: 'gemini' };
  } catch (e) {
    console.error('gemini', (e as Error)?.name ?? '', (e as Error)?.message ?? e);
    return { text: explain(status), source: 'error' };
  }
}

function explain(status: number): string {
  if (status === 429) return '지금 AI 요청이 잠시 몰려서 답을 못 만들었어요 (한도 초과). 1~2분 뒤에 다시 불러 주세요.';
  if (status === 403 || status === 401) return 'AI 열쇠가 거절됐어요 (`WORKSPACE_GEMINI_API_KEY`). 관리자에게 열쇠를 다시 확인해 달라고 알려 주세요.';
  if (status === 404) return `AI 모델 이름(${model()})을 찾지 못했어요. \`WORKSPACE_GEMINI_MODEL\` 값을 확인해 주세요.`;
  if (status >= 500) return 'AI 쪽에 일시적인 문제가 생겼어요. 잠시 뒤 다시 불러 주세요.';
  if (status === 0) return 'AI 에 연결하지 못했어요. 잠시 뒤 다시 불러 주세요.';
  return `답변을 만드는 중 문제가 생겼어요 (HTTP ${status}). 잠시 뒤 다시 불러 주세요.`;
}
