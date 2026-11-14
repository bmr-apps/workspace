// workspace-fn 메일 도우미 — 허브 함수 hub-mail 을 부릅니다.
// 보내는 주소는 허브가 정합니다: "<표시 이름>" <workspace@mail.bmrschool.net>
// 이 앱의 메일 토큰(WORKSPACE_MAIL_TOKEN)은 함수 비밀값에 들어 있으며, Resend 키는 앱이 갖지 않습니다.
//
// 한도: 앱마다 하루 100통 · 한 시간 20통 · 한 통에 받는 사람 10명. 학교 전체도 하루 100통입니다.
// 토큰을 브라우저에 노출하지 마세요. 서버 함수 안에서만 호출합니다.

const PREFIX = 'WORKSPACE_';
const SB_URL = Deno.env.get('SUPABASE_URL') ?? '';

export type SendMailInput = {
  to: string | string[];
  subject: string;
  html?: string;
  text?: string;
  reply_to?: string | string[];
  from_name?: string;
};

export async function sendMail(input: SendMailInput): Promise<{ ok: true; id: string; from: string; to_count: number }> {
  const token = Deno.env.get(PREFIX + 'MAIL_TOKEN') ?? '';
  if (!token) throw new Error('메일 토큰(WORKSPACE_MAIL_TOKEN)이 없습니다. 관리자에게 요청하세요.');
  if (!SB_URL) throw new Error('SUPABASE_URL 이 없습니다.');
  const r = await fetch(`${SB_URL}/functions/v1/hub-mail`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      apikey: Deno.env.get('SUPABASE_ANON_KEY') ?? '',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(input),
  });
  const body = await r.json().catch(() => ({})) as { ok?: boolean; id?: string; from?: string; to_count?: number; error?: string };
  if (!r.ok || !body.ok) throw new Error(body.error || `메일 보내기 실패 (${r.status})`);
  return { ok: true, id: String(body.id ?? ''), from: String(body.from ?? ''), to_count: Number(body.to_count ?? 0) };
}
