/**
 * Harvard Path — Admin control bot (Cloudflare Worker)
 *
 * Bu bot @GoingToHarvard_bot (sayt boti) dan BUTUNLAY ALOHIDA — shu sababli
 * saytdagi login/Lessons/Quiz funksiyalariga hech qanday ta'sir qilmaydi.
 *
 * Buyruqlar:
 *   /help                      — buyruqlar ro'yxati
 *   /fact                      — hoziroq shaxsiy fakt (hammaga ochiq)
 *   /post_now facts|poll|flex  — kanalga hoziroq post yuborish (admin)
 *   /preview facts|poll|flex   — kanalga YUBORMASDAN, sizga preview (admin)
 *   /deadline YYYY-MM-DD|clear — FLEX aniq muddatini o'rnatish (admin)
 *   /pause / /resume           — kunlik avtomatik postlarni to'xtatish/yoqish (admin)
 *   /stats                     — oxirgi postlar holati + pauza holati (admin)
 *   /next                      — keyingi avtomatik post qachon ketishi (admin)
 *   /mypoints                  — o'z ballaringiz (hammaga ochiq)
 *   /leaderboard                — TOP 10 (hammaga ochiq)
 *   /post_leaderboard          — TOP 10'ni kanalga post qilish (admin)
 *
 * Gamifikatsiya: kunlik poll (14:00 Toshkent) endi shu Worker'ning cron trigger'i
 * orqali, ADMIN_BOT_TOKEN bilan va is_anonymous=false qilib yuboriladi — shu sababli
 * poll_answer webhook'lari kelib, D1'da ball hisoblanadi. main.py'dagi eski
 * send_poll_post() endi GitHub Actions jadvalida ISHLATILMAYDI (faqat zaxira).
 */

interface TelegramUpdate {
  message?: {
    message_id: number;
    text?: string;
    chat: { id: number };
    from?: { id: number };
  };
  poll_answer?: {
    poll_id: string;
    user: { id: number; username?: string; first_name?: string };
    option_ids: number[];
  };
}

export interface Env {
  ADMIN_BOT_TOKEN: string; // shu Worker webhook orqali tinglaydigan yangi bot
  BOT_TOKEN: string; // kanalga admin bo'lgan mavjud fact-bot tokeni (postlash uchun)
  CHANNEL_ID: string;
  CHANNEL_USERNAME: string;
  GEMINI_API_KEY: string;
  ADMIN_CHAT_ID: string; // faqat shu Telegram user_id admin buyruqlarini ishlata oladi
  WEBHOOK_SECRET: string; // Telegram secret_token tekshiruvi uchun
  GITHUB_TOKEN: string; // /pause, /resume, /stats, /deadline uchun (repo+workflow huquqi)
  DB: D1Database; // gamifikatsiya: users, polls jadvallari
}

const POINTS_CORRECT = 10;
const POINTS_WRONG = 2;
const POINTS_PARTICIPATION = 3;

// GitHub repo joylashuvi — main.py'ni ishga tushiradigan GitHub Actions shu yerda
const GITHUB_OWNER = "ruzibekov24";
const GITHUB_REPO = "auto-poster-telegram-bot";
const WORKFLOW_FILE = "post.yml";

// post.yml'dagi cron jadvali bilan qo'lda sinxronlab turing (UTC soatlari)
const SCHEDULE_UTC: { hourUtc: number; type: string; label: string }[] = [
  { hourUtc: 4, type: "facts", label: "🧠 Fact post" },
  { hourUtc: 9, type: "poll", label: "🗳 Poll/Viktorina" },
  { hourUtc: 15, type: "flex", label: "✈️ FLEX countdown" },
];

const GEMINI_MODEL = "gemini-3.6-flash";
const SPLIT_MARKER = "|||";

const CATEGORY_EMOJI: Record<string, string> = {
  "Crazy facts (fizika, koinot, inson tanasi, hayvonot dunyosi haqida hayratlanarli faktlar)": "🤯",
  "Fun facts (kulgili, kutilmagan statistikalar)": "😂",
  "About love (lowkey/hazil uslubda, jiddiy emas — sevgi psixologiyasi haqida kulgili tarzda)": "💘",
  "Random weird facts (g'alati, kam ma'lum faktlar)": "👽",
  "Tech/space facts": "🚀",
};
const CATEGORIES = Object.keys(CATEGORY_EMOJI);
const HOOKS = ["#Facts", "🧠 Did you know?", "🤯 Fact time:", "👀 Ever wondered?"];
const FLEX_HOOKS = ["✈️ FLEX countdown:", "⏳ Reality check:", "🔥 FLEX fact:", "🌎 Exchange szn:"];
const POLL_TOPICS = [
  "Random qiziqarli fakt/ilmiy trivia (fizika, koinot, hayvonot dunyosi, inson tanasi)",
  "FLEX (Future Leaders Exchange Program) dasturi haqida trivia",
  "Talaba hayoti, o'qish odatlari haqida hazil-mutoyibali savol",
  "Gen-Z / kundalik hayot haqida qiziqarli fikr-mulohaza savoli",
];
// main.py'dagi APPROX_ROUNDS bilan qo'lda sinxronlab turing
const APPROX_ROUNDS = [{ name: "FLEX ariza topshirish muddati", month: 9, day: 12 }];

// ---------------------------------------------------------------------------
// Yordamchi: HTML escape + **so'z** -> <b>so'z</b>
// ---------------------------------------------------------------------------

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function applyBoldMarkup(text: string): string {
  return text.replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
}

// ---------------------------------------------------------------------------
// Gemini API
// ---------------------------------------------------------------------------

async function callGemini(env: Env, prompt: string, jsonMode = false): Promise<string> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${env.GEMINI_API_KEY}`;
  const body: Record<string, unknown> = {
    contents: [{ parts: [{ text: prompt }] }],
  };
  if (jsonMode) {
    body.generationConfig = { responseMimeType: "application/json" };
  }

  const maxAttempts = 4;
  let lastError: string = "";
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.ok) {
      const data = (await res.json()) as any;
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (typeof text === "string") return text.trim();
      throw new Error("Gemini javobida matn topilmadi");
    }
    lastError = `${res.status} ${await res.text()}`;
    if (attempt < maxAttempts) {
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
  throw new Error(`Gemini API xatoligi: ${lastError}`);
}

// ---------------------------------------------------------------------------
// Fakt generatsiyasi (fact + reaction, /fact va /post_now facts uchun umumiy)
// ---------------------------------------------------------------------------

function buildFactPrompt(category: string): string {
  return `Sen Telegram kanali uchun qisqa "fact" post matni yozadigan copywriter'san.
Kanal auditoriyasi: Gen-Z, fun va hazil-mutoyibali uslubni yaxshi ko'radi.

Kategoriya: ${category}

Ikkita qism yoz (ingliz tilida):

1) FAKT: 1-3 ta qisqa jumlada qiziqarli/kulgili fakt, haqiqiy va jiddiy/akademik bo'lmagan
   ohangda. Oxirida bitta qisqa, kulgili yoki relatable punchline qo'sh (1 ta mos emoji bilan).
   Matn ichidagi 1-2 ta ENG kalit/muhim so'z yoki qisqa iborani **so'z** shaklida belgila.

2) REAKSIYA: shu faktga o'quvchining lahzalik hissiy reaksiyasi — juda qisqa (3-6 so'z),
   hazil-mutoyibali, emoji bilan boyitilgan jumla. Bu qator Telegram'da spoiler ostida yashiriladi.

Javobni FAQAT quyidagi formatda qaytar, boshqa hech qanday izoh yoki sarlavha yozma:
<FAKT matni>
${SPLIT_MARKER}
<REAKSIYA matni>`;
}

async function generateFact(env: Env, category: string): Promise<{ fact: string; reaction: string }> {
  const raw = await callGemini(env, buildFactPrompt(category));
  const [factPart, reactionPart] = raw.split(SPLIT_MARKER);
  return {
    fact: (factPart ?? "").trim(),
    reaction: (reactionPart ?? "").trim() || "🤯",
  };
}

// ---------------------------------------------------------------------------
// GitHub API — /pause, /resume, /stats, /deadline uchun
// ---------------------------------------------------------------------------

async function ghRequest(env: Env, method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(`https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      Accept: "application/vnd.github+json",
      "User-Agent": "harvard-path-admin-bot",
      "Content-Type": "application/json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : {};
  if (!res.ok) {
    throw new Error(`GitHub API xatoligi (${method} ${path}): ${res.status} ${JSON.stringify(data)}`);
  }
  return data;
}

async function getExactDeadline(env: Env): Promise<{ date: string; round: string } | null> {
  try {
    const file = await ghRequest(env, "GET", "/contents/deadline.json");
    const content = JSON.parse(atob((file.content as string).replace(/\n/g, "")));
    if (content?.date) return { date: content.date, round: content.round ?? "Ariza topshirish" };
    return null;
  } catch {
    return null;
  }
}

async function setDeadline(env: Env, date: string | null, round = "Ariza topshirish"): Promise<void> {
  const path = "/contents/deadline.json";
  const existing = await ghRequest(env, "GET", path).catch(() => null);
  const newContent = date ? { date, round } : {};
  const body = {
    message: date ? `chore: FLEX muddatini o'rnatish (${date}) [admin bot]` : "chore: FLEX muddatini tozalash [admin bot]",
    content: btoa(JSON.stringify(newContent, null, 2) + "\n"),
    sha: existing?.sha,
  };
  await ghRequest(env, "PUT", path, body);
}

async function getWorkflowState(env: Env): Promise<string> {
  const data = await ghRequest(env, "GET", `/actions/workflows/${WORKFLOW_FILE}`);
  return data.state as string; // "active" | "disabled_manually" | ...
}

async function setWorkflowEnabled(env: Env, enabled: boolean): Promise<void> {
  await ghRequest(env, "PUT", `/actions/workflows/${WORKFLOW_FILE}/${enabled ? "enable" : "disable"}`);
}

async function getRecentRuns(env: Env, perPage = 5): Promise<any[]> {
  const data = await ghRequest(env, "GET", `/actions/workflows/${WORKFLOW_FILE}/runs?per_page=${perPage}`);
  return data.workflow_runs ?? [];
}

// ---------------------------------------------------------------------------
// Flex/countdown
// ---------------------------------------------------------------------------

function nextApproxDeadline(): { name: string; daysLeft: number } {
  const today = new Date();
  const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());

  let best: { name: string; daysLeft: number } | null = null;
  for (const round of APPROX_ROUNDS) {
    let target = Date.UTC(today.getUTCFullYear(), round.month - 1, round.day);
    if (target < todayUtc) {
      target = Date.UTC(today.getUTCFullYear() + 1, round.month - 1, round.day);
    }
    const daysLeft = Math.round((target - todayUtc) / 86400000);
    if (!best || daysLeft < best.daysLeft) {
      best = { name: round.name, daysLeft };
    }
  }
  return best!;
}

async function computeDeadline(env: Env): Promise<{ name: string; daysLeft: number; isExact: boolean }> {
  const exact = await getExactDeadline(env).catch(() => null);
  if (exact) {
    const today = new Date();
    const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
    const target = Date.parse(`${exact.date}T00:00:00Z`);
    const daysLeft = Math.round((target - todayUtc) / 86400000);
    if (!Number.isNaN(daysLeft) && daysLeft >= 0) {
      return { name: `FLEX — ${exact.round}`, daysLeft, isExact: true };
    }
  }
  const approx = nextApproxDeadline();
  return { ...approx, isExact: false };
}

function buildFlexPrompt(): string {
  return `Sen Telegram kanali uchun "flex" mini-fakt post matni yozadigan copywriter'san.
Kanal auditoriyasi: FLEX (Future Leaders Exchange Program — AQSh davlat dasturi, O'zbekiston
maktab o'quvchilari uchun bir yillik bepul almashinuv dasturi) ga tayyorlanayotgan Gen-Z
o'quvchilar.

Mavzu: FLEX dasturi haqida qisqa, flex/hazil-mutoyibali mini fakt — masalan dastur
imkoniyatlari (AQShda bir yil bepul o'qish, host family, stipendiya), qabul statistikasi,
ariza/insho maslahatlari, test bosqichlari, yoki motivatsion flex jumla.

Ikkita qism yoz (ingliz tilida):
1) MINI-FAKT: 1-2 ta qisqa jumla, flex/relatable ohangda. ANIQ SANALAR yoki "N kun qoldi"
   YOZMA. Matn ichidagi 1 ta kalit so'zni **so'z** shaklida belgila.
2) REAKSIYA: juda qisqa (3-6 so'z) hissiy reaksiya, emoji bilan.

Javobni FAQAT quyidagi formatda qaytar:
<MINI-FAKT matni>
${SPLIT_MARKER}
<REAKSIYA matni>`;
}

async function buildFlexHtml(env: Env): Promise<string> {
  const raw = await callGemini(env, buildFlexPrompt());
  const [factPart, reactionPart] = raw.split(SPLIT_MARKER);
  const fact = (factPart ?? "").trim();
  const reaction = (reactionPart ?? "").trim() || "✈️";
  const { name, daysLeft, isExact } = await computeDeadline(env);

  const hook = FLEX_HOOKS[Math.floor(Math.random() * FLEX_HOOKS.length)];
  const factHtml = applyBoldMarkup(escapeHtml(fact));
  const countdownLine = isExact
    ? `📅 <b>${daysLeft} kun qoldi</b> — ${escapeHtml(name)}`
    : `📅 Taxminan <b>~${daysLeft} kun</b> qoldi — ${escapeHtml(name)} (aniq sana e'lon qilinganda yangilanadi)`;

  return [
    escapeHtml(hook),
    factHtml,
    "",
    countdownLine,
    "",
    `<tg-spoiler>${escapeHtml(reaction)}</tg-spoiler>`,
    "",
    "#FLEX #FutureLeadersExchange",
    `✈️ @${env.CHANNEL_USERNAME.replace(/^@/, "")}`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Poll/viktorina
// ---------------------------------------------------------------------------

interface PollData {
  question: string;
  options: string[];
  correct_index?: number;
  explanation?: string;
}

function buildPollPrompt(pollType: "quiz" | "regular", topic: string): string {
  const schema =
    pollType === "quiz"
      ? `{
  "question": "savol matni (ingliz tilida, max 250 belgi)",
  "options": ["variant1", "variant2", "variant3", "variant4"],
  "correct_index": 0,
  "explanation": "to'g'ri javobdan keyin ko'rsatiladigan qisqa izoh (max 180 belgi)"
}
Bu VIKTORINA — aniq bitta to'g'ri javob bo'lsin.`
      : `{
  "question": "so'rov savoli (ingliz tilida, max 250 belgi)",
  "options": ["variant1", "variant2", "variant3", "variant4"]
}
Bu ODDIY SO'ROVNOMA — to'g'ri/noto'g'ri javob yo'q.`;

  return `Sen Telegram kanali uchun ${pollType === "quiz" ? "viktorina" : "so'rovnoma"} tayyorlaydigan
copywriter'san. Auditoriya: Harvard/top universitetlarga tayyorlanayotgan Gen-Z talabalar.

Mavzu: ${topic}

Talablar: 3-4 ta qisqa javob varianti (har biri max 80 belgi), qiziqarli/hazil ohangda.

Javobni FAQAT quyidagi JSON formatida qaytar:
${schema}`;
}

async function generatePoll(env: Env, pollType: "quiz" | "regular"): Promise<PollData> {
  const topic = POLL_TOPICS[Math.floor(Math.random() * POLL_TOPICS.length)];
  const raw = await callGemini(env, buildPollPrompt(pollType, topic), true);
  return JSON.parse(raw) as PollData;
}

// ---------------------------------------------------------------------------
// Telegram API
// ---------------------------------------------------------------------------

async function tgCall(token: string, method: string, payload: Record<string, unknown>): Promise<any> {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = (await res.json()) as any;
  if (!data.ok) {
    throw new Error(`Telegram API xatoligi (${method}): ${JSON.stringify(data)}`);
  }
  return data.result;
}

async function sendMessage(token: string, chatId: number | string, text: string, html = false) {
  return tgCall(token, "sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: html ? "HTML" : undefined,
  });
}

async function sendPoll(
  token: string,
  chatId: number | string,
  poll: PollData,
  pollType: "quiz" | "regular",
  anonymous = true
) {
  const payload: Record<string, unknown> = {
    chat_id: chatId,
    question: poll.question,
    options: poll.options,
    is_anonymous: anonymous,
    type: pollType,
  };
  if (pollType === "quiz") {
    payload.correct_option_id = poll.correct_index;
    if (poll.explanation) payload.explanation = poll.explanation;
  }
  return tgCall(token, "sendPoll", payload); // natija: Message obyekti, .poll.id bilan
}

// ---------------------------------------------------------------------------
// Gamifikatsiya (D1): ball, poll kuzatuvi, leaderboard
// ---------------------------------------------------------------------------

async function recordPoll(env: Env, pollId: string, pollType: "quiz" | "regular", correctOptionId: number | null) {
  await env.DB.prepare("INSERT INTO polls (poll_id, poll_type, correct_option_id) VALUES (?, ?, ?)")
    .bind(pollId, pollType, correctOptionId)
    .run();
}

async function getPoll(env: Env, pollId: string): Promise<{ poll_type: string; correct_option_id: number | null } | null> {
  const row = await env.DB.prepare("SELECT poll_type, correct_option_id FROM polls WHERE poll_id = ?")
    .bind(pollId)
    .first();
  return (row as any) ?? null;
}

async function awardPoints(
  env: Env,
  userId: number,
  username: string | undefined,
  firstName: string | undefined,
  points: number,
  wasCorrect: boolean | null
) {
  await env.DB.prepare(
    `INSERT INTO users (user_id, username, first_name, points, correct_answers, total_answers, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, datetime('now'))
     ON CONFLICT(user_id) DO UPDATE SET
       username = excluded.username,
       first_name = excluded.first_name,
       points = points + excluded.points,
       correct_answers = correct_answers + excluded.correct_answers,
       total_answers = total_answers + 1,
       updated_at = datetime('now')`
  )
    .bind(userId, username ?? null, firstName ?? null, points, wasCorrect ? 1 : 0)
    .run();
}

async function handlePollAnswer(env: Env, pollAnswer: NonNullable<TelegramUpdate["poll_answer"]>) {
  if (pollAnswer.option_ids.length === 0) return; // ovozni bekor qilgan

  const poll = await getPoll(env, pollAnswer.poll_id);
  if (!poll) return; // preview yoki gamifikatsiyasiz poll — e'tiborsiz qoldiriladi

  let points = POINTS_PARTICIPATION;
  let wasCorrect: boolean | null = null;
  if (poll.poll_type === "quiz") {
    wasCorrect = pollAnswer.option_ids.includes(poll.correct_option_id ?? -1);
    points = wasCorrect ? POINTS_CORRECT : POINTS_WRONG;
  }

  await awardPoints(env, pollAnswer.user.id, pollAnswer.user.username, pollAnswer.user.first_name, points, wasCorrect);
}

async function getUserStats(env: Env, userId: number) {
  return env.DB.prepare("SELECT points, correct_answers, total_answers FROM users WHERE user_id = ?")
    .bind(userId)
    .first<{ points: number; correct_answers: number; total_answers: number }>();
}

async function getLeaderboard(env: Env, limit = 10) {
  const { results } = await env.DB.prepare(
    "SELECT user_id, username, first_name, points, correct_answers, total_answers FROM users ORDER BY points DESC LIMIT ?"
  )
    .bind(limit)
    .all<{ user_id: number; username: string | null; first_name: string | null; points: number }>();
  return results;
}

async function postGamifiedPoll(env: Env): Promise<{ pollType: "quiz" | "regular"; question: string }> {
  const pollType: "quiz" | "regular" = Math.random() < 0.5 ? "quiz" : "regular";
  const poll = await generatePoll(env, pollType);
  const message = await sendPoll(env.ADMIN_BOT_TOKEN, env.CHANNEL_ID, poll, pollType, false);
  await recordPoll(env, message.poll.id, pollType, pollType === "quiz" ? poll.correct_index ?? null : null);
  return { pollType, question: poll.question };
}

async function getSetting(env: Env, key: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first<{ value: string }>();
  return row?.value ?? null;
}

async function setSetting(env: Env, key: string, value: string): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  )
    .bind(key, value)
    .run();
}

// ---------------------------------------------------------------------------
// Buyruq handler'lari
// ---------------------------------------------------------------------------

async function handleFactCommand(env: Env, chatId: number) {
  const category = CATEGORIES[Math.floor(Math.random() * CATEGORIES.length)];
  const { fact, reaction } = await generateFact(env, category);
  const factHtml = applyBoldMarkup(escapeHtml(fact));
  const text = `${factHtml}\n\n<tg-spoiler>${escapeHtml(reaction)}</tg-spoiler>`;
  await sendMessage(env.ADMIN_BOT_TOKEN, chatId, text, true);
}

async function handlePostNowCommand(env: Env, chatId: number, fromId: number, args: string[]) {
  if (!(await requireAdmin(env, chatId, fromId))) return;

  const target = args[0];
  if (!["facts", "poll", "flex"].includes(target)) {
    await sendMessage(env.ADMIN_BOT_TOKEN, chatId, "Foydalanish: /post_now facts|poll|flex");
    return;
  }

  await sendMessage(env.ADMIN_BOT_TOKEN, chatId, `⏳ ${target} tayyorlanmoqda...`);

  try {
    if (target === "facts") {
      const category = CATEGORIES[Math.floor(Math.random() * CATEGORIES.length)];
      const { fact, reaction } = await generateFact(env, category);
      const html = buildFactHtmlForChannel(env, category, fact, reaction);
      await sendMessage(env.BOT_TOKEN, env.CHANNEL_ID, html, true);
    } else if (target === "flex") {
      const html = await buildFlexHtml(env);
      await sendMessage(env.BOT_TOKEN, env.CHANNEL_ID, html, true);
    } else {
      await postGamifiedPoll(env); // ball hisoblanishi uchun ADMIN_BOT_TOKEN + is_anonymous=false
    }
    await sendMessage(env.ADMIN_BOT_TOKEN, chatId, `✅ Kanalga "${target}" post yuborildi.`);
  } catch (e) {
    await sendMessage(env.ADMIN_BOT_TOKEN, chatId, `❌ Xatolik: ${(e as Error).message}`);
  }
}

function buildFactHtmlForChannel(env: Env, category: string, fact: string, reaction: string): string {
  const hook = HOOKS[Math.floor(Math.random() * HOOKS.length)];
  const emoji = CATEGORY_EMOJI[category] ?? "🚀";
  const factHtml = applyBoldMarkup(escapeHtml(fact));
  return [
    escapeHtml(hook),
    factHtml,
    "",
    `<tg-spoiler>${escapeHtml(reaction)}</tg-spoiler>`,
    "",
    "#Facts",
    `${emoji} @${env.CHANNEL_USERNAME.replace(/^@/, "")}`,
  ].join("\n");
}

function isAdmin(env: Env, fromId: number): boolean {
  return String(fromId) === env.ADMIN_CHAT_ID;
}

async function requireAdmin(env: Env, chatId: number, fromId: number): Promise<boolean> {
  if (isAdmin(env, fromId)) return true;
  await sendMessage(env.ADMIN_BOT_TOKEN, chatId, "⛔ Bu buyruq faqat admin uchun.");
  return false;
}

const HELP_TEXT = `👋 Mavjud buyruqlar:

/fact — hoziroq shaxsiy fakt
/mypoints — sizning ballaringiz
/leaderboard — TOP 10 faol o'quvchilar

Quyidagilar faqat admin uchun:
/post_now facts|poll|flex — kanalga hoziroq post yuborish
/preview facts|poll|flex — kanalga yubormasdan, sizga preview
/post_leaderboard — TOP 10'ni kanalga post qilish
/deadline YYYY-MM-DD — FLEX aniq muddatini o'rnatish
/deadline clear — aniq muddatni bekor qilish (taxminiyga qaytarish)
/pause — kunlik avtomatik postlarni to'xtatish
/resume — kunlik avtomatik postlarni qayta yoqish
/stats — oxirgi postlar holati
/next — keyingi avtomatik post qachon ketishi`;

async function handlePreviewCommand(env: Env, chatId: number, fromId: number, args: string[]) {
  if (!(await requireAdmin(env, chatId, fromId))) return;

  const target = args[0];
  if (!["facts", "poll", "flex"].includes(target)) {
    await sendMessage(env.ADMIN_BOT_TOKEN, chatId, "Foydalanish: /preview facts|poll|flex");
    return;
  }

  await sendMessage(env.ADMIN_BOT_TOKEN, chatId, `👀 Preview (kanalga YUBORILMAYDI): ${target}...`);

  try {
    if (target === "facts") {
      const category = CATEGORIES[Math.floor(Math.random() * CATEGORIES.length)];
      const { fact, reaction } = await generateFact(env, category);
      const html = buildFactHtmlForChannel(env, category, fact, reaction);
      await sendMessage(env.ADMIN_BOT_TOKEN, chatId, html, true);
    } else if (target === "flex") {
      const html = await buildFlexHtml(env);
      await sendMessage(env.ADMIN_BOT_TOKEN, chatId, html, true);
    } else {
      const pollType: "quiz" | "regular" = Math.random() < 0.5 ? "quiz" : "regular";
      const poll = await generatePoll(env, pollType);
      await sendPoll(env.ADMIN_BOT_TOKEN, chatId, poll, pollType);
    }
  } catch (e) {
    await sendMessage(env.ADMIN_BOT_TOKEN, chatId, `❌ Xatolik: ${(e as Error).message}`);
  }
}

async function handleDeadlineCommand(env: Env, chatId: number, fromId: number, args: string[]) {
  if (!(await requireAdmin(env, chatId, fromId))) return;

  const arg = args[0];
  if (!arg) {
    await sendMessage(env.ADMIN_BOT_TOKEN, chatId, "Foydalanish: /deadline YYYY-MM-DD yoki /deadline clear");
    return;
  }

  try {
    if (arg === "clear") {
      await setDeadline(env, null);
      await sendMessage(env.ADMIN_BOT_TOKEN, chatId, "✅ Aniq muddat bekor qilindi — endi taxminiy sana ishlatiladi.");
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(arg)) {
      await sendMessage(env.ADMIN_BOT_TOKEN, chatId, "❌ Sana formati noto'g'ri. Masalan: /deadline 2026-09-15");
      return;
    }
    await setDeadline(env, arg);
    await sendMessage(env.ADMIN_BOT_TOKEN, chatId, `✅ FLEX muddati ${arg} qilib o'rnatildi. Kunlik postlar endi ANIQ countdown ko'rsatadi.`);
  } catch (e) {
    await sendMessage(env.ADMIN_BOT_TOKEN, chatId, `❌ Xatolik: ${(e as Error).message}`);
  }
}

async function handlePauseCommand(env: Env, chatId: number, fromId: number, enable: boolean) {
  if (!(await requireAdmin(env, chatId, fromId))) return;
  try {
    await setWorkflowEnabled(env, enable); // GitHub Actions: facts + flex
    await setSetting(env, "paused", enable ? "false" : "true"); // Worker cron: poll
    await sendMessage(
      env.ADMIN_BOT_TOKEN,
      chatId,
      enable ? "▶️ Kunlik avtomatik postlar (fact/poll/flex) qayta yoqildi." : "⏸ Kunlik avtomatik postlar (fact/poll/flex) to'xtatildi."
    );
  } catch (e) {
    await sendMessage(env.ADMIN_BOT_TOKEN, chatId, `❌ Xatolik: ${(e as Error).message}`);
  }
}

async function handleStatsCommand(env: Env, chatId: number, fromId: number) {
  if (!(await requireAdmin(env, chatId, fromId))) return;
  try {
    const [state, runs] = await Promise.all([getWorkflowState(env), getRecentRuns(env, 5)]);
    const pauseLine = state === "active" ? "▶️ Ishlayapti" : "⏸ To'xtatilgan";

    const runLines = runs.map((r) => {
      const icon = r.status !== "completed" ? "🟡" : r.conclusion === "success" ? "✅" : "❌";
      const when = new Date(r.created_at).toISOString().slice(0, 16).replace("T", " ");
      return `${icon} ${r.display_title ?? r.name} — ${when} UTC`;
    });

    const text = [`📊 Holat: ${pauseLine}`, "", "Oxirgi postlar:", ...(runLines.length ? runLines : ["(hali yo'q)"])].join("\n");
    await sendMessage(env.ADMIN_BOT_TOKEN, chatId, text);
  } catch (e) {
    await sendMessage(env.ADMIN_BOT_TOKEN, chatId, `❌ Xatolik: ${(e as Error).message}`);
  }
}

async function handleNextCommand(env: Env, chatId: number, fromId: number) {
  if (!(await requireAdmin(env, chatId, fromId))) return;
  try {
    const state = await getWorkflowState(env);
    if (state !== "active") {
      await sendMessage(env.ADMIN_BOT_TOKEN, chatId, "⏸ Avtomatik postlar hozir to'xtatilgan (/resume bilan yoqing).");
      return;
    }

    const now = new Date();
    const nowMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
    let best: { type: string; label: string; minutesUntil: number } | null = null;
    for (const s of SCHEDULE_UTC) {
      const slotMinutes = s.hourUtc * 60;
      const diff = (slotMinutes - nowMinutes + 1440) % 1440;
      if (!best || diff < best.minutesUntil) {
        best = { type: s.type, label: s.label, minutesUntil: diff === 0 ? 1440 : diff };
      }
    }
    const hours = Math.floor(best!.minutesUntil / 60);
    const minutes = best!.minutesUntil % 60;
    await sendMessage(
      env.ADMIN_BOT_TOKEN,
      chatId,
      `⏭ Keyingi post: ${best!.label}\n🕐 ${hours} soat ${minutes} daqiqadan keyin`
    );
  } catch (e) {
    await sendMessage(env.ADMIN_BOT_TOKEN, chatId, `❌ Xatolik: ${(e as Error).message}`);
  }
}

function formatLeaderboard(rows: { username: string | null; first_name: string | null; points: number }[]): string {
  const medals = ["🥇", "🥈", "🥉"];
  return rows
    .map((u, i) => {
      const name = u.username ? `@${u.username}` : u.first_name || "Foydalanuvchi";
      const rank = medals[i] ?? `${i + 1}.`;
      return `${rank} ${name} — ${u.points} ball`;
    })
    .join("\n");
}

async function handleMyPointsCommand(env: Env, chatId: number, userId: number) {
  const stats = await getUserStats(env, userId);
  if (!stats) {
    await sendMessage(env.ADMIN_BOT_TOKEN, chatId, "Hali ballaringiz yo'q — kanaldagi viktorina/pollarga javob bering! 🎯");
    return;
  }
  const accuracy = stats.total_answers > 0 ? Math.round((stats.correct_answers / stats.total_answers) * 100) : 0;
  await sendMessage(
    env.ADMIN_BOT_TOKEN,
    chatId,
    `🏆 Sizning ballaringiz: ${stats.points}\n✅ To'g'ri javoblar: ${stats.correct_answers}/${stats.total_answers} (${accuracy}%)`
  );
}

async function handleLeaderboardCommand(env: Env, chatId: number) {
  const top = await getLeaderboard(env, 10);
  if (!top.length) {
    await sendMessage(env.ADMIN_BOT_TOKEN, chatId, "Hali hech kim ball to'plamagan. Birinchi bo'ling! 🚀");
    return;
  }
  await sendMessage(env.ADMIN_BOT_TOKEN, chatId, `🏆 TOP ${top.length}:\n\n${formatLeaderboard(top)}`);
}

async function handlePostLeaderboardCommand(env: Env, chatId: number, fromId: number) {
  if (!(await requireAdmin(env, chatId, fromId))) return;
  const top = await getLeaderboard(env, 10);
  if (!top.length) {
    await sendMessage(env.ADMIN_BOT_TOKEN, chatId, "Hali hech kim ball to'plamagan.");
    return;
  }
  const text = `🏆 TOP ${top.length} faol o'quvchi:\n\n${formatLeaderboard(top)}\n\n#Leaderboard`;
  await sendMessage(env.ADMIN_BOT_TOKEN, env.CHANNEL_ID, text);
  await sendMessage(env.ADMIN_BOT_TOKEN, chatId, "✅ Leaderboard kanalga yuborildi.");
}

// ---------------------------------------------------------------------------
// Worker entrypoint
// ---------------------------------------------------------------------------

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== "POST") {
      return new Response("OK — bu Telegram webhook endpoint", { status: 200 });
    }

    // Telegram'dan kelayotganini tekshirish (setWebhook'da o'rnatilgan secret_token)
    const secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
    if (secret !== env.WEBHOOK_SECRET) {
      return new Response("Forbidden", { status: 403 });
    }

    let update: TelegramUpdate;
    try {
      update = await request.json();
    } catch {
      return new Response("Bad Request", { status: 400 });
    }

    if (update.poll_answer) {
      await handlePollAnswer(env, update.poll_answer).catch(() => {});
      return new Response("OK");
    }

    const message = update.message;
    if (!message?.text || !message.from) {
      return new Response("OK");
    }

    const text = message.text.trim();
    const chatId = message.chat.id;
    const fromId = message.from.id;

    try {
      if (text === "/fact" || text === "/fact@" || text.startsWith("/fact ")) {
        await handleFactCommand(env, chatId);
      } else if (text.startsWith("/post_now")) {
        await handlePostNowCommand(env, chatId, fromId, text.split(/\s+/).slice(1));
      } else if (text.startsWith("/preview")) {
        await handlePreviewCommand(env, chatId, fromId, text.split(/\s+/).slice(1));
      } else if (text.startsWith("/deadline")) {
        await handleDeadlineCommand(env, chatId, fromId, text.split(/\s+/).slice(1));
      } else if (text === "/pause") {
        await handlePauseCommand(env, chatId, fromId, false);
      } else if (text === "/resume") {
        await handlePauseCommand(env, chatId, fromId, true);
      } else if (text === "/stats") {
        await handleStatsCommand(env, chatId, fromId);
      } else if (text === "/next") {
        await handleNextCommand(env, chatId, fromId);
      } else if (text === "/mypoints") {
        await handleMyPointsCommand(env, chatId, fromId);
      } else if (text === "/leaderboard") {
        await handleLeaderboardCommand(env, chatId);
      } else if (text === "/post_leaderboard") {
        await handlePostLeaderboardCommand(env, chatId, fromId);
      } else if (text === "/start" || text === "/help") {
        await sendMessage(env.ADMIN_BOT_TOKEN, chatId, HELP_TEXT);
      }
    } catch (e) {
      // Xatolikni foydalanuvchiga ko'rsatamiz, lekin Worker'ni yiqitmaymiz
      await sendMessage(env.ADMIN_BOT_TOKEN, chatId, `❌ Xatolik: ${(e as Error).message}`).catch(() => {});
    }

    return new Response("OK");
  },

  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    const paused = await getSetting(env, "paused");
    if (paused === "true") return;
    await postGamifiedPoll(env);
  },
};
