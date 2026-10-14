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
 *   /opendate rasmiy|norasmiy YYYY-MM-DD|clear — FLEX ochilish sanasi (admin)
 *   /deadline rasmiy|norasmiy YYYY-MM-DD|clear — FLEX yopilish/muddat sanasi (admin)
 *   /pause / /resume           — kunlik avtomatik postlarni to'xtatish/yoqish (admin)
 *   /stats                     — oxirgi postlar holati + pauza holati (admin)
 *   /next                      — keyingi avtomatik post qachon ketishi (admin)
 *   /mypoints                  — o'z ballaringiz (hammaga ochiq)
 *   /leaderboard                — TOP 10 (hammaga ochiq)
 *   /post_leaderboard          — TOP 10'ni kanalga post qilish (admin)
 *
 * Gamifikatsiya: kunlik poll (14:00 Toshkent) endi shu Worker'ning cron trigger'i
 * orqali yuboriladi. 50% ehtimol bilan — VIKTORINA (inline tugmali xabar, ball
 * beriladi) yoki oddiy SO'ROVNOMA (native anonim Telegram Poll, ball berilmaydi,
 * chunki kanal pollari Telegram tomonidan majburiy anonim). main.py'dagi eski
 * send_poll_post() endi GitHub Actions jadvalida ISHLATILMAYDI (faqat zaxira).
 */

interface TelegramUpdate {
  message?: {
    message_id: number;
    text?: string;
    chat: { id: number };
    from?: { id: number };
  };
  callback_query?: {
    id: string;
    data?: string;
    from: { id: number; username?: string; first_name?: string };
    message?: { message_id: number; chat: { id: number }; text?: string };
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
  GITHUB_TOKEN_MHP: string; // my-harvard-path repo'ga alohida cheklangan token (flex.html sync uchun)
  DB: D1Database; // gamifikatsiya: users, quizzes, quiz_answers, settings jadvallari
  ASSETS: Fetcher; // Mini App statik fayllari (public/)
}

const POINTS_CORRECT = 10;
const POINTS_WRONG = 2;

// GitHub repo joylashuvi — main.py'ni ishga tushiradigan GitHub Actions shu yerda
const GITHUB_OWNER = "ruzibekov24";
const GITHUB_REPO = "auto-poster-telegram-bot";
const WORKFLOW_FILE = "post.yml";

// flex-radar/notify/telegram_notifier.py'dagi SEPARATOR bilan qo'lda sinxronlab turing
const FLEX_RADAR_SEPARATOR = "─".repeat(8);

// post.yml'dagi cron jadvali bilan qo'lda sinxronlab turing (UTC soatlari)
const SCHEDULE_UTC: { hourUtc: number; type: string; label: string }[] = [
  { hourUtc: 4, type: "facts", label: "🧠 Fact post" },
  { hourUtc: 9, type: "poll", label: "🗳 Poll/Viktorina + kunlik maxsus post (myth/essay/story/...)" },
  { hourUtc: 15, type: "flex", label: "✈️ FLEX countdown" },
];

const GEMINI_MODEL = "gemini-3.8-flash";
const SPLIT_MARKER = "|||";

// main.py'dagi EMOJI_BAN_NOTE bilan qo'lda sinxronlab turing
const EMOJI_BAN_NOTE =
  "MUHIM: 💀 va 💅 emojilarini HECH QACHON ishlatma — ular juda ko'p takrorlanib " +
  "ketgan. Buning o'rniga har safar boshqa-boshqa, mavzuga mos emojilardan " +
  "foydalan (masalan 😭 🤯 😂 🔥 ✨ 👀 🚀 🥲 kabi xilma-xil variantlardan tanlab, " +
  "bir xilini qayta-qayta ishlatma).";

// main.py'dagi NO_CTA_NOTE bilan qo'lda sinxronlab turing
const NO_CTA_NOTE =
  "MUHIM: matn ichida botga/kanalga o'tishga chaqiruvchi jumlalar YOZMA — masalan " +
  '"botda mashq qiling", "botga o\'ting", "quyidagi tugmani bosing", "@bot orqali ' +
  'ko\'proq bilib oling" kabi. Faqat fakt/savol mazmuniga e\'tibor qarat.';

const CATEGORY_EMOJI: Record<string, string> = {
  "Crazy facts (fizika, koinot, inson tanasi, hayvonot dunyosi haqida hayratlanarli faktlar)": "🤯",
  "Fun facts (kulgili, kutilmagan statistikalar)": "😂",
  "About love (lowkey/hazil uslubda, jiddiy emas — sevgi psixologiyasi haqida kulgili tarzda)": "💘",
  "Random weird facts (g'alati, kam ma'lum faktlar)": "👽",
  "Tech/space facts": "🚀",
  "Ivy League / top universitetlar va elite akademiyalar haqida qiziqarli, kam ma'lum faktlar (tarix, an'analar, mashhur bitiruvchilar)": "🎓",
};
const CATEGORIES = Object.keys(CATEGORY_EMOJI);
const HOOKS = ["#Facts", "🧠 Did you know?", "🤯 Fact time:", "👀 Ever wondered?"];
const FLEX_HOOKS = ["✈️ FLEX countdown:", "⏳ Reality check:", "🔥 FLEX fact:", "🌎 Exchange szn:"];
const POLL_TOPICS = [
  "Random qiziqarli fakt/ilmiy trivia (fizika, koinot, hayvonot dunyosi, inson tanasi)",
  "FLEX (Future Leaders Exchange Program) dasturi haqida trivia",
  "Ivy League universitetlari va top akademiyalar (MIT, Stanford, Exeter) haqida trivia",
  "Talaba hayoti, o'qish odatlari haqida hazil-mutoyibali savol",
  "Gen-Z / kundalik hayot haqida qiziqarli fikr-mulohaza savoli",
];
// main.py'dagi APPROX_ROUNDS bilan qo'lda sinxronlab turing
const APPROX_ROUNDS = [{ name: "FLEX ariza topshirish muddati", month: 10, day: 22 }];

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

// Asosiy model band bo'lsa (503/429) ketma-ket zaxira modellarga o'tamiz
const GEMINI_FALLBACK_MODELS = ["gemini-3.6-flash"]; // gemini-2.5/2.0-flash Google tomonidan o'chirilgan

// Telegram buyrug'i fonda (waitUntil, ~30s limit) bajarilganda umumiy vaqt byudjeti shu yerda saqlanadi.
// Cron'da (null) byudjet kengroq.
let invocationDeadline: number | null = null;

async function callGemini(env: Env, prompt: string, jsonMode = false): Promise<string> {
  const body: Record<string, unknown> = {
    contents: [{ parts: [{ text: prompt }] }],
  };
  if (jsonMode) {
    body.generationConfig = { responseMimeType: "application/json" };
  }

  // Band modelda kutib o'tirmaymiz — darrov keyingisiga o'tamiz. Hammasi band bo'lsa,
  // qisqa pauzadan so'ng yana bir aylanish. 3.8 kabi "o'ylaydigan" model 10s+ olishi mumkin.
  const deadline = invocationDeadline ?? Date.now() + 60000;
  const errors: string[] = [];
  const dead = new Set<string>(); // 404 — bu model endi yo'q, qayta urinmaymiz
  for (let pass = 1; pass <= 2; pass++) {
    for (const model of [GEMINI_MODEL, ...GEMINI_FALLBACK_MODELS]) {
      const remaining = deadline - Date.now();
      if (dead.has(model) || remaining < 3000) continue;
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`;
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(Math.min(25000, remaining - 500)),
        });
        if (res.ok) {
          const data = (await res.json()) as any;
          const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
          if (typeof text === "string") return text.trim();
          errors.push(`${model}: javobda matn yo'q`);
          continue;
        }
        errors.push(`${model}: ${res.status} ${(await res.text()).slice(0, 100).replace(/\s+/g, " ")}`);
        if (res.status !== 429 && res.status < 500) dead.add(model);
      } catch (e) {
        errors.push(`${model}: ${(e as Error).name === "TimeoutError" ? "timeout" : (e as Error).message}`);
      }
    }
    if (pass === 1 && deadline - Date.now() > 8000) await new Promise((r) => setTimeout(r, 2500));
  }
  throw new Error(`Gemini API xatoligi — ${errors.slice(-3).join(" | ")}`);
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

${EMOJI_BAN_NOTE}

${NO_CTA_NOTE}

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

async function ghRequestRepo(
  token: string,
  owner: string,
  repo: string,
  method: string,
  path: string,
  body?: unknown
): Promise<any> {
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
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

async function ghRequest(env: Env, method: string, path: string, body?: unknown): Promise<any> {
  return ghRequestRepo(env.GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO, method, path, body);
}

// ---------------------------------------------------------------------------
// Flex/countdown — ochilish (open) va yopilish (close) sanalari, har biri
// "rasmiy" (official=true) yoki "taxminiy" (official=false) holatga ega
// ---------------------------------------------------------------------------

type DeadlineKey = "open" | "close";
type DeadlineEntry = { date: string; official: boolean };
type DeadlineConfig = Partial<Record<DeadlineKey, DeadlineEntry>>;

const DEADLINE_LABELS: Record<DeadlineKey, string> = { open: "Ochilish sanasi", close: "Ariza muddati" };

async function getDeadlineConfig(env: Env): Promise<DeadlineConfig> {
  try {
    const file = await ghRequest(env, "GET", "/contents/deadline.json");
    return JSON.parse(atob((file.content as string).replace(/\n/g, ""))) as DeadlineConfig;
  } catch {
    return {};
  }
}

async function setDeadlineEntry(env: Env, key: DeadlineKey, entry: DeadlineEntry | null): Promise<void> {
  const path = "/contents/deadline.json";
  const existing = await ghRequest(env, "GET", path).catch(() => null);
  const current: DeadlineConfig = existing ? JSON.parse(atob((existing.content as string).replace(/\n/g, ""))) : {};
  if (entry) {
    current[key] = entry;
  } else {
    delete current[key];
  }
  const body = {
    message: entry
      ? `chore: FLEX ${key} sanasini o'rnatish (${entry.date}, ${entry.official ? "rasmiy" : "taxminiy"}) [admin bot]`
      : `chore: FLEX ${key} sanasini tozalash [admin bot]`,
    content: btoa(JSON.stringify(current, null, 2) + "\n"),
    sha: existing?.sha,
  };
  await ghRequest(env, "PUT", path, body);
}

function nextApproxDeadline(): { name: string; daysLeft: number; isoDate: string } {
  const today = new Date();
  const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());

  let best: { name: string; daysLeft: number; isoDate: string } | null = null;
  for (const round of APPROX_ROUNDS) {
    let target = Date.UTC(today.getUTCFullYear(), round.month - 1, round.day);
    if (target < todayUtc) {
      target = Date.UTC(today.getUTCFullYear() + 1, round.month - 1, round.day);
    }
    const daysLeft = Math.round((target - todayUtc) / 86400000);
    if (!best || daysLeft < best.daysLeft) {
      best = { name: round.name, daysLeft, isoDate: new Date(target).toISOString().slice(0, 10) };
    }
  }
  return best!;
}

/** Eng yaqin (ochilish yoki yopilish) sanani hisoblaydi — post matni va sayt sync uchun umumiy. */
async function resolveNextDate(env: Env): Promise<{ name: string; daysLeft: number; isExact: boolean; isoDate: string }> {
  const config = await getDeadlineConfig(env).catch(() => ({}) as DeadlineConfig);
  const today = new Date();
  const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());

  const candidates: { name: string; daysLeft: number; isExact: boolean; isoDate: string }[] = [];
  for (const key of Object.keys(DEADLINE_LABELS) as DeadlineKey[]) {
    const entry = config[key];
    if (!entry?.date) continue;
    const target = Date.parse(`${entry.date}T00:00:00Z`);
    if (Number.isNaN(target)) continue;
    const daysLeft = Math.round((target - todayUtc) / 86400000);
    if (daysLeft >= 0) {
      candidates.push({ name: DEADLINE_LABELS[key], daysLeft, isExact: !!entry.official, isoDate: entry.date });
    }
  }

  if (candidates.length) {
    return candidates.reduce((best, c) => (c.daysLeft < best.daysLeft ? c : best));
  }

  const approx = nextApproxDeadline();
  return { ...approx, isExact: false };
}

async function computeDeadline(env: Env): Promise<{ name: string; daysLeft: number; isExact: boolean }> {
  return resolveNextDate(env);
}

// my-harvard-path saytidagi FLEX countdown (flex.html) — /deadline va /opendate
// buyruqlaridan keyin shu funksiya chaqirilib, saytni ham sinxronlaydi.
// Alohida, shu repo'ga cheklangan GITHUB_TOKEN_MHP token ishlatiladi.
const MHP_OWNER = "ruzibekov24";
const MHP_REPO = "my-harvard-path";
const MHP_FLEX_FILE = "flex.html";

/** Katta fayllarda "Maximum call stack size exceeded" bo'lmasligi uchun bo'lib-bo'lib kodlaydi. */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000; // 32768
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

async function syncSiteCountdown(env: Env): Promise<boolean> {
  try {
    const next = await resolveNextDate(env);
    const file = await ghRequestRepo(env.GITHUB_TOKEN_MHP, MHP_OWNER, MHP_REPO, "GET", `/contents/${MHP_FLEX_FILE}`);
    const html = new TextDecoder().decode(Uint8Array.from(atob(file.content.replace(/\n/g, "")), (c) => c.charCodeAt(0)));
    const updatedHtml = html.replace(/data-deadline="[^"]*"/, `data-deadline="${next.isoDate}T23:59:59"`);
    if (updatedHtml === html) {
      console.error("syncSiteCountdown: data-deadline pattern topilmadi");
      return false; // pattern topilmadi — sayt tuzilishi o'zgargan bo'lishi mumkin
    }

    const body = {
      message: `chore: FLEX countdown sync (${next.isoDate}, ${next.isExact ? "rasmiy" : "taxminiy"}) [admin bot]`,
      content: bytesToBase64(new TextEncoder().encode(updatedHtml)),
      sha: file.sha,
    };
    await ghRequestRepo(env.GITHUB_TOKEN_MHP, MHP_OWNER, MHP_REPO, "PUT", `/contents/${MHP_FLEX_FILE}`, body);
    return true;
  } catch (e) {
    console.error("syncSiteCountdown xatoligi:", (e as Error).message);
    return false; // token huquqi yo'q yoki boshqa xatolik — asosiy buyruq oqimini buzmaymiz
  }
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

${EMOJI_BAN_NOTE}

${NO_CTA_NOTE}

Javobni FAQAT quyidagi formatda qaytar:
<MINI-FAKT matni>
${SPLIT_MARKER}
<REAKSIYA matni>`;
}

// main.py'dagi PROGRAM_STAGES bilan qo'lda sinxronlab turing (FLEX 2027-2028 Program Calendar)
const PROGRAM_STAGES: { start: string; end: string; label: string }[] = [
  { start: "2026-10-23", end: "2026-10-31", label: "Onlayn ingliz tili testi (2-bosqich) — havola kelgach 24 soat ichida topshiring" },
  { start: "2026-10-01", end: "2026-12-31", label: "Yarim finalistlar e'loni" },
  { start: "2026-11-01", end: "2027-01-31", label: "Intervyu, ingliz tili bahosi, insholar, yarim finalist arizasi" },
  { start: "2027-03-01", end: "2027-05-31", label: "Finalistlar e'loni" },
  { start: "2027-06-01", end: "2027-07-31", label: "Jo'nashdan oldingi orientatsiyalar" },
  { start: "2027-08-01", end: "2027-08-31", label: "Ishtirokchilar AQShga jo'naydi" },
];

function currentStages(): string[] {
  const today = new Date(Date.now() + 5 * 3600 * 1000).toISOString().slice(0, 10); // Toshkent sanasi
  return PROGRAM_STAGES.filter((s) => s.start <= today && today <= s.end)
    .map((s) => s.label)
    .slice(0, 2);
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

  const stages = currentStages();
  const stageLine = stages.length ? `\n📍 Hozirgi bosqich (taxminiy): ${escapeHtml(stages.join("; "))}` : "";

  return [
    escapeHtml(hook),
    factHtml,
    "",
    countdownLine + stageLine,
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

${EMOJI_BAN_NOTE}

${NO_CTA_NOTE}

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

async function sendMessage(
  token: string,
  chatId: number | string,
  text: string,
  html = false,
  replyMarkup?: unknown
) {
  return tgCall(token, "sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: html ? "HTML" : undefined,
    reply_markup: replyMarkup,
  });
}

async function sendMessageWithButtons(
  token: string,
  chatId: number | string,
  text: string,
  buttons: { text: string; callback_data: string }[]
) {
  return tgCall(token, "sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: buttons.map((b) => [b]) }, // har bir variant alohida qatorda
  });
}

async function sendPoll(
  token: string,
  chatId: number | string,
  poll: PollData,
  pollType: "quiz" | "regular",
  anonymous = true,
  replyMarkup?: unknown
) {
  const payload: Record<string, unknown> = {
    chat_id: chatId,
    question: poll.question,
    options: poll.options,
    is_anonymous: anonymous,
    type: pollType,
    reply_markup: replyMarkup,
  };
  if (pollType === "quiz") {
    payload.correct_option_id = poll.correct_index;
    if (poll.explanation) payload.explanation = poll.explanation;
  }
  return tgCall(token, "sendPoll", payload); // natija: Message obyekti, .poll.id bilan
}

// ---------------------------------------------------------------------------
// Gamifikatsiya (D1): ball, tugmali viktorina, leaderboard
//
// Kanal pollari Telegram tomonidan MAJBURIY anonim qilinadi — shu sabab
// kim qanday javob berganini bilib bo'lmaydi. Shuning uchun VIKTORINA endi
// native Poll o'rniga inline tugmali oddiy xabar orqali yuboriladi: tugma
// bosilganda callback_query keladi (bu kanalda ham to'liq ishlaydi va
// bosuvchining shaxsi ma'lum bo'ladi), javob esa faqat o'sha odamga popup
// (show_alert) sifatida ko'rinadi — boshqalar ko'rmaydi.
// ---------------------------------------------------------------------------

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

async function answerCallbackQuery(env: Env, callbackQueryId: string, text: string, showAlert = false) {
  await tgCall(env.ADMIN_BOT_TOKEN, "answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    text: text.slice(0, 200),
    show_alert: showAlert,
  }).catch(() => {});
}

async function removeInlineKeyboard(env: Env, chatId: number, messageId: number) {
  await tgCall(env.ADMIN_BOT_TOKEN, "editMessageReplyMarkup", {
    chat_id: chatId,
    message_id: messageId,
    reply_markup: { inline_keyboard: [] },
  }).catch(() => {});
}

/**
 * FLEX Radar (flex-radar/main.py) yuborgan alert xabaridagi "✅ Ha" / "❌ Yo'q"
 * tugmasi bosilganda ishlaydi. Xabar matni FLEX_RADAR_SEPARATOR bo'yicha ikkiga
 * bo'linadi: birinchi qism — kanalga postlash uchun tayyor matn, ikkinchi qism —
 * faqat adminga ko'rinadigan ishonch/manba ma'lumoti.
 */
async function handleFlexRadarDecision(env: Env, cq: NonNullable<TelegramUpdate["callback_query"]>) {
  const message = cq.message!;
  await removeInlineKeyboard(env, message.chat.id, message.message_id);

  if (cq.data === "flexradar:no") {
    await answerCallbackQuery(env, cq.id, "Bekor qilindi.");
    return;
  }

  const fullText = message.text ?? "";
  const channelPost = fullText.split(FLEX_RADAR_SEPARATOR)[0].trim();
  if (!channelPost) {
    await answerCallbackQuery(env, cq.id, "❌ Xabar matni topilmadi.", true);
    return;
  }

  try {
    await sendMessage(env.ADMIN_BOT_TOKEN, env.CHANNEL_ID, channelPost);
    await answerCallbackQuery(env, cq.id, "✅ Kanalga yuborildi!", true);
  } catch (e) {
    await answerCallbackQuery(env, cq.id, `❌ Xatolik: ${(e as Error).message}`, true);
  }
}

async function handleCallbackQuery(env: Env, cq: NonNullable<TelegramUpdate["callback_query"]>) {
  if (!cq.message) {
    await answerCallbackQuery(env, cq.id, "");
    return;
  }

  if (cq.data === "flexradar:yes" || cq.data === "flexradar:no") {
    await handleFlexRadarDecision(env, cq);
    return;
  }

  if (cq.data?.startsWith("pv:")) {
    await handlePreviewPublish(env, cq);
    return;
  }

  if (!cq.data?.startsWith("qz:")) {
    await answerCallbackQuery(env, cq.id, "");
    return;
  }

  const chosenIndex = Number.parseInt(cq.data.slice(3), 10);
  const quizKey = `${cq.message.chat.id}:${cq.message.message_id}`;

  const quiz = await env.DB.prepare("SELECT correct_index FROM quizzes WHERE quiz_key = ?")
    .bind(quizKey)
    .first<{ correct_index: number }>();
  if (!quiz) {
    await answerCallbackQuery(env, cq.id, "Bu viktorina topilmadi (eskirgan bo'lishi mumkin).");
    return;
  }

  const existing = await env.DB.prepare("SELECT is_correct FROM quiz_answers WHERE quiz_key = ? AND user_id = ?")
    .bind(quizKey, cq.from.id)
    .first<{ is_correct: number }>();
  if (existing) {
    await answerCallbackQuery(
      env,
      cq.id,
      existing.is_correct ? "Siz allaqachon to'g'ri javob bergansiz ✅" : "Siz allaqachon javob bergansiz ❌",
      true
    );
    return;
  }

  const isCorrect = chosenIndex === quiz.correct_index;
  const points = isCorrect ? POINTS_CORRECT : POINTS_WRONG;
  await env.DB.prepare(
    "INSERT INTO quiz_answers (quiz_key, user_id, chosen_index, is_correct, points) VALUES (?, ?, ?, ?, ?)"
  )
    .bind(quizKey, cq.from.id, chosenIndex, isCorrect ? 1 : 0, points)
    .run();

  await awardPoints(env, cq.from.id, cq.from.username, cq.from.first_name, points, isCorrect);

  const alertText = isCorrect ? `✅ To'g'ri! +${POINTS_CORRECT} ball` : `❌ Noto'g'ri javob. +${POINTS_WRONG} ball`;
  await answerCallbackQuery(env, cq.id, alertText, true);
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

async function getUserRank(env: Env, userId: number): Promise<number | null> {
  const row = await env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM users u2 WHERE u2.points > u1.points) + 1 AS rank
     FROM users u1 WHERE u1.user_id = ?`
  )
    .bind(userId)
    .first<{ rank: number }>();
  return row?.rank ?? null;
}

// ---------------------------------------------------------------------------
// Mini App: Telegram initData tekshiruvi + JSON API
// ---------------------------------------------------------------------------

async function hmacSha256(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
  const cryptoKey = await crypto.subtle.importKey("raw", key as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  return crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(data));
}

function bufToHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function verifyInitData(
  initData: string,
  botToken: string
): Promise<{ id: number; username?: string; first_name?: string } | null> {
  if (!initData) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash) return null;
  params.delete("hash");

  const sortedKeys = [...params.keys()].sort();
  const dataCheckString = sortedKeys.map((k) => `${k}=${params.get(k)}`).join("\n");

  const secretKey = await hmacSha256(new TextEncoder().encode("WebAppData"), botToken);
  const computedHash = bufToHex(await hmacSha256(secretKey, dataCheckString));
  if (computedHash !== hash) return null;

  const userJson = params.get("user");
  if (!userJson) return null;
  try {
    const user = JSON.parse(userJson);
    return { id: user.id, username: user.username, first_name: user.first_name };
  } catch {
    return null;
  }
}

// my-harvard-path.pages.dev saytidan (boshqa domen) ochiq ma'lumotlarni (leaderboard)
// o'qiy olishi uchun CORS ruxsati — faqat public/o'qish endpointlari uchun
const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

async function handleApiMe(request: Request, env: Env): Promise<Response> {
  const initData = request.headers.get("X-Telegram-Init-Data") ?? "";
  const user = await verifyInitData(initData, env.ADMIN_BOT_TOKEN);
  if (!user) return jsonResponse({ error: "Avtorizatsiya xato — botni Telegram ichida oching." }, 401);

  const stats = await getUserStats(env, user.id);
  if (!stats) {
    return jsonResponse({ points: 0, correct_answers: 0, total_answers: 0, rank: null });
  }
  const rank = await getUserRank(env, user.id);
  return jsonResponse({ ...stats, rank });
}

async function handleApiLeaderboard(request: Request, env: Env): Promise<Response> {
  const initData = request.headers.get("X-Telegram-Init-Data") ?? "";
  const user = await verifyInitData(initData, env.ADMIN_BOT_TOKEN);

  const top = await getLeaderboard(env, 20);
  const leaderboard = top.map((u) => ({ ...u, is_me: user ? u.user_id === user.id : false }));
  return jsonResponse({ leaderboard });
}

async function getUserHistory(env: Env, userId: number, limit = 15) {
  const { results } = await env.DB.prepare(
    `SELECT qz.question, qz.options, qz.correct_index, qa.chosen_index, qa.is_correct, qa.points, qa.answered_at
     FROM quiz_answers qa
     JOIN quizzes qz ON qz.quiz_key = qa.quiz_key
     WHERE qa.user_id = ?
     ORDER BY qa.answered_at DESC
     LIMIT ?`
  )
    .bind(userId, limit)
    .all<{
      question: string;
      options: string;
      correct_index: number;
      chosen_index: number;
      is_correct: number;
      points: number;
      answered_at: string;
    }>();
  return results.map((r) => {
    const options: string[] = JSON.parse(r.options);
    return {
      question: r.question,
      chosen: options[r.chosen_index] ?? "",
      correct: options[r.correct_index] ?? "",
      is_correct: !!r.is_correct,
      points: r.points,
      answered_at: r.answered_at,
    };
  });
}

async function handleApiHistory(request: Request, env: Env): Promise<Response> {
  const initData = request.headers.get("X-Telegram-Init-Data") ?? "";
  const user = await verifyInitData(initData, env.ADMIN_BOT_TOKEN);
  if (!user) return jsonResponse({ error: "Avtorizatsiya xato — botni Telegram ichida oching." }, 401);

  const history = await getUserHistory(env, user.id);
  return jsonResponse({ history });
}

async function handleApiDeadline(_request: Request, env: Env): Promise<Response> {
  const deadline = await computeDeadline(env);
  return jsonResponse(deadline);
}

function buildQuizMessageHtml(poll: PollData): string {
  const letters = ["A", "B", "C", "D", "E", "F"];
  const optionsHtml = poll.options
    .map((opt, i) => `${letters[i] ?? i + 1}) ${escapeHtml(opt)}`)
    .join("\n");
  return `🧠 <b>Viktorina!</b>\n\n${escapeHtml(poll.question)}\n\n${optionsHtml}\n\nJavobni pastdagi tugmalardan tanlang 👇`;
}

async function postGamifiedQuiz(env: Env, existing?: PollData): Promise<void> {
  const poll = existing ?? (await generatePoll(env, "quiz"));
  const text = buildQuizMessageHtml(poll);
  const letters = ["A", "B", "C", "D", "E", "F"];
  const buttons = poll.options.map((opt, i) => ({
    text: `${letters[i] ?? i + 1}) ${opt}`.slice(0, 64),
    callback_data: `qz:${i}`,
  }));
  const message = await sendMessageWithButtons(env.ADMIN_BOT_TOKEN, env.CHANNEL_ID, text, buttons);
  const quizKey = `${message.chat.id}:${message.message_id}`;
  await env.DB.prepare("INSERT INTO quizzes (quiz_key, correct_index, options, question) VALUES (?, ?, ?, ?)")
    .bind(quizKey, poll.correct_index, JSON.stringify(poll.options), poll.question)
    .run();
}

async function postDailyPollOrQuiz(env: Env): Promise<{ pollType: "quiz" | "regular" }> {
  const pollType: "quiz" | "regular" = Math.random() < 0.5 ? "quiz" : "regular";
  if (pollType === "quiz") {
    await postGamifiedQuiz(env);
  } else {
    // Oddiy so'rovnoma — ball berilmaydi (to'g'ri/noto'g'ri yo'q), shunchaki
    // native (majburiy anonim) Telegram Poll sifatida, sof engagement uchun.
    const poll = await generatePoll(env, "regular");
    await sendPoll(env.ADMIN_BOT_TOKEN, env.CHANNEL_ID, poll, "regular", true);
  }
  return { pollType };
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
  if (!POST_TARGETS.includes(target)) {
    await sendMessage(env.ADMIN_BOT_TOKEN, chatId, `Foydalanish: /post_now facts|poll|flex|${SPECIAL_KINDS.join("|")}`);
    return;
  }

  await sendMessage(env.ADMIN_BOT_TOKEN, chatId, `⏳ ${target} tayyorlanmoqda...`);

  try {
    await publishRecord(env, await generateRecord(env, target));
    await sendMessage(
      env.ADMIN_BOT_TOKEN,
      chatId,
      `✅ Kanalga "${target}" post yuborildi. Bugungi avtomatik "${target}" posti o'tkazib yuboriladi.`
    );
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

const PUBLIC_COMMANDS_TEXT = `/fact — hoziroq qiziqarli fakt oling
/mypoints — ballaringizni ko'ring
/leaderboard — TOP 10 faol o'quvchilarni ko'ring
/help — shu ro'yxatni qayta ko'rish`;

const ADMIN_COMMANDS_TEXT = `/post_now facts|poll|flex — kanalga hoziroq post yuborish
/post_now myth|essay|story|thisorthat|word|faq|campus — maxsus haftalik formatlar
/preview <tur> — kanalga yubormasdan, sizga preview (yuqoridagi turlar)
/post_leaderboard — TOP 10'ni kanalga post qilish
/opendate rasmiy|norasmiy YYYY-MM-DD — FLEX ochilish sanasi
/deadline rasmiy|norasmiy YYYY-MM-DD — FLEX yopilish/muddat sanasi
/opendate clear yoki /deadline clear — tegishlisini bekor qilish
/pause — kunlik avtomatik postlarni to'xtatish
/resume — kunlik avtomatik postlarni qayta yoqish
/stats — oxirgi postlar holati
/next — keyingi avtomatik post qachon ketishi`;

const WELCOME_TEXT = `👋 <b>Salom! Xush kelibsiz!</b>

Bu — <b>Going to Harvard | Garvard sari</b> kanalining rasmiy yordamchi boti.

Bu yerda siz:
🧠 Qiziqarli faktlarni hoziroq olishingiz
🏆 Kanaldagi viktorinalarga javob berib ball to'plashingiz
📊 Boshqa o'quvchilar bilan reytingda raqobatlashishingiz mumkin!

<b>Buyruqlar:</b>
${PUBLIC_COMMANDS_TEXT}`;

function buildHelpText(userIsAdmin: boolean): string {
  const base = `<b>Buyruqlar:</b>\n${PUBLIC_COMMANDS_TEXT}`;
  return userIsAdmin ? `${base}\n\n<b>Admin uchun:</b>\n${ADMIN_COMMANDS_TEXT}` : base;
}

async function handlePreviewCommand(env: Env, chatId: number, fromId: number, args: string[]) {
  if (!(await requireAdmin(env, chatId, fromId))) return;

  const target = args[0];
  if (!POST_TARGETS.includes(target)) {
    await sendMessage(env.ADMIN_BOT_TOKEN, chatId, `Foydalanish: /preview facts|poll|flex|${SPECIAL_KINDS.join("|")}`);
    return;
  }

  await sendMessage(env.ADMIN_BOT_TOKEN, chatId, `👀 Preview (tugmani bossangiz kanalga joylanadi): ${target}...`);

  try {
    const rec = await generateRecord(env, target);
    const id = crypto.randomUUID().slice(0, 8);
    const markup = { inline_keyboard: [[{ text: "📣 Kanalga joylash", callback_data: `pv:${id}` }]] };
    await previewRecord(env, chatId, rec, markup);
    await setSetting(env, `preview:${id}`, JSON.stringify(rec));
  } catch (e) {
    await sendMessage(env.ADMIN_BOT_TOKEN, chatId, `❌ Xatolik: ${(e as Error).message}`);
  }
}

async function handleDeadlineArgCommand(
  env: Env,
  chatId: number,
  fromId: number,
  args: string[],
  key: DeadlineKey
) {
  if (!(await requireAdmin(env, chatId, fromId))) return;

  const commandName = key === "open" ? "/opendate" : "/deadline";
  const label = DEADLINE_LABELS[key];
  const usage = `Foydalanish:\n${commandName} rasmiy YYYY-MM-DD — aniq/tasdiqlangan sana\n${commandName} norasmiy YYYY-MM-DD — taxminiy sana\n${commandName} clear — bekor qilish`;

  const status = args[0];
  if (!status) {
    await sendMessage(env.ADMIN_BOT_TOKEN, chatId, usage);
    return;
  }

  try {
    if (status === "clear") {
      await setDeadlineEntry(env, key, null);
      const siteSynced = await syncSiteCountdown(env);
      await sendMessage(
        env.ADMIN_BOT_TOKEN,
        chatId,
        `✅ ${label} bekor qilindi.` +
          (siteSynced ? "\n🌐 Sayt (my-harvard-path) ham yangilandi." : "\n⚠️ Sayt yangilanmadi (token huquqi yo'q yoki xatolik).")
      );
      return;
    }

    const dateArg = args[1];
    if ((status !== "rasmiy" && status !== "norasmiy") || !dateArg || !/^\d{4}-\d{2}-\d{2}$/.test(dateArg)) {
      await sendMessage(env.ADMIN_BOT_TOKEN, chatId, `❌ Format noto'g'ri.\n\n${usage}`);
      return;
    }

    const official = status === "rasmiy";
    await setDeadlineEntry(env, key, { date: dateArg, official });
    const siteSynced = await syncSiteCountdown(env);
    await sendMessage(
      env.ADMIN_BOT_TOKEN,
      chatId,
      `✅ ${label}: ${dateArg} (${official ? "RASMIY ✅" : "taxminiy"}) qilib o'rnatildi.` +
        (siteSynced ? "\n🌐 Sayt (my-harvard-path) ham yangilandi." : "\n⚠️ Sayt yangilanmadi (token huquqi yo'q yoki xatolik).")
    );
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
// Haftalik maxsus postlar (poll bilan birga, 14:00 Toshkent) — fakt/flex/poll'dan tashqari
// xilma-xil formatlar. Mavzu FLEX va Ivy League/top akademiyalar orasida aralashadi.
// Yakshanba: campus rasmi + haftalik leaderboard.
// ---------------------------------------------------------------------------

type SpecialKind = "myth" | "essay" | "story" | "thisorthat" | "word" | "faq" | "campus";
const SPECIAL_KINDS: SpecialKind[] = ["myth", "essay", "story", "thisorthat", "word", "faq", "campus"];
// getUTCDay(): 0=Yakshanba ... 6=Shanba
const WEEKDAY_SPECIAL: SpecialKind[] = ["campus", "myth", "essay", "story", "thisorthat", "word", "faq"];

const SPECIAL_TRACKS = [
  "FLEX (Future Leaders Exchange Program — AQSh davlat dasturi, O'zbekiston maktab o'quvchilari uchun bir yillik bepul almashinuv)",
  "Ivy League universitetlari (Harvard, Yale, Princeton, Columbia, UPenn, Brown, Cornell, Dartmouth) va ularga qabul",
  "AQShdagi top universitetlar va elite akademiyalar/boarding school'lar (MIT, Stanford, Phillips Exeter, Andover kabi), stipendiya, SAT/Common App",
];

const CAMPUS_NAMES = [
  "Harvard University", "Yale University", "Princeton University", "Columbia University",
  "University of Pennsylvania", "Brown University", "Cornell University", "Dartmouth College",
  "MIT", "Stanford University", "Caltech", "University of Chicago", "Duke University",
  "Phillips Exeter Academy", "Phillips Academy Andover", "Choate Rosemary Hall", "Deerfield Academy",
];

const GEMINI_IMAGE_MODEL = "gemini-2.5-flash-image";

const SPECIAL_ACCURACY_NOTE =
  "MUHIM: faqat barqaror, ishonchli ma'lumot yoz. Aniq sana, qabul foizi, narx yoki raqamni " +
  "FAQAT to'liq ishonching komil bo'lsa yoz, aks holda umumiy tilda ifodala. Hech narsani to'qima.";

function pickRandom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

async function geminiJson<T>(env: Env, prompt: string): Promise<T> {
  return JSON.parse(await callGemini(env, prompt, true)) as T;
}

function specialFooter(env: Env, tags: string, emoji: string): string {
  return `\n\n${tags}\n${emoji} @${env.CHANNEL_USERNAME.replace(/^@/, "")}`;
}

type SpecialPost =
  | { type: "text"; html: string }
  | { type: "photo"; html: string; imagePrompt: string }
  | { type: "poll"; poll: PollData };

async function buildSpecial(env: Env, kind: SpecialKind): Promise<SpecialPost> {
  const track = pickRandom(SPECIAL_TRACKS);
  const audience = "Auditoriya: AQShga/top universitetlarga tayyorlanayotgan O'zbekistonlik Gen-Z o'quvchilar.";
  const style = "Ohang: samimiy, hazil-mutoyibali, jiddiy/akademik emas.";
  const common = `${audience}\n${style}\nMavzu yo'nalishi: ${track}\n\n${EMOJI_BAN_NOTE}\n\n${NO_CTA_NOTE}\n\n${SPECIAL_ACCURACY_NOTE}`;

  switch (kind) {
    case "myth": {
      const d = await geminiJson<{ myth: string; reality: string }>(
        env,
        `Telegram kanali uchun "Myth vs Reality" post yoz. ${common}

Keng tarqalgan bitta MIFni (noto'g'ri tasavvur) va uning HAQIQATini o'zbek tilida (lotin) yoz.
Har biri 1-2 qisqa jumla. Mif odamlar ishonadigan darajada real bo'lsin.

JSON: {"myth": "...", "reality": "..."}`
      );
      return {
        type: "text",
        html:
          `🧩 <b>Myth vs Reality</b>\n\n❌ <b>Mif:</b> ${escapeHtml(d.myth)}\n\n` +
          `<tg-spoiler>✅ <b>Haqiqat:</b> ${escapeHtml(d.reality)}</tg-spoiler>` +
          specialFooter(env, "#MythVsReality", "🧩"),
      };
    }
    case "essay": {
      const d = await geminiJson<{ question: string; tip: string }>(
        env,
        `Telegram kanali uchun kunlik "Writing Challenge" yoz. ${common}

1) question: ariza inshosi yoki intervyu savoli (INGLIZ tilida, 1-2 jumla, o'ylantiradigan).
2) tip: shu savolga qanday yondashish haqida qisqa maslahat (o'zbek tilida, 1-2 jumla).

JSON: {"question": "...", "tip": "..."}`
      );
      return {
        type: "text",
        html:
          `✍️ <b>Writing Challenge</b>\n\n${escapeHtml(d.question)}\n\n💡 <i>${escapeHtml(d.tip)}</i>\n\n` +
          `Javobingizni izohlarda yozing 👇` +
          specialFooter(env, "#WritingChallenge", "✍️"),
      };
    }
    case "story": {
      const d = await geminiJson<{ title: string; story: string; image_prompt: string }>(
        env,
        `Telegram kanali uchun mini-hikoya yoz. ${common}

Bitta o'quvchining (xayoliy ism bilan) shu mavzudagi real-hayotiy lahzasi: 3-5 jumla, o'zbek tilida (lotin),
oxirida kutilmagan yoki ilhomlantiruvchi burilish. Jami 600 belgidan oshmasin.
image_prompt: shu sahna uchun INGLIZ tilida rasm tavsifi (flat illustration, iliq ranglar, rasm ichida HECH QANDAY yozuv yo'q).

JSON: {"title": "...", "story": "...", "image_prompt": "..."}`
      );
      return {
        type: "photo",
        imagePrompt: d.image_prompt,
        html: `📖 <b>${escapeHtml(d.title)}</b>\n\n${escapeHtml(d.story)}` + specialFooter(env, "#MiniStory", "📖"),
      };
    }
    case "thisorthat": {
      const d = await geminiJson<{ question: string; options: string[] }>(
        env,
        `Telegram so'rovnomasi uchun "This or That" yoz. ${common}

question: "This or That?" bilan boshlanadigan qisqa sarlavha (INGLIZ tilida, max 120 belgi), mavzu: tanlov
(masalan o'qish/hayot/odat/orzu). options: aniq 2 ta variant (INGLIZ tilida, har biri max 60 belgi).

JSON: {"question": "...", "options": ["...", "..."]}`
      );
      return { type: "poll", poll: { question: d.question.slice(0, 250), options: d.options.slice(0, 2) } };
    }
    case "word": {
      const d = await geminiJson<{ term: string; meaning: string; example: string; uz: string }>(
        env,
        `Telegram kanali uchun "Word of the day" yoz. ${common}

Foydali amerikacha sleng, ibora yoki akademik/ariza so'zi (maktab, college, kundalik hayot).
term: so'z/ibora. meaning: INGLIZ tilida oddiy izoh (1 jumla). example: INGLIZ tilida misol gap. uz: o'zbekcha tarjima/ma'no.

JSON: {"term": "...", "meaning": "...", "example": "...", "uz": "..."}`
      );
      return {
        type: "text",
        html:
          `🗣 <b>Word of the day:</b> ${escapeHtml(d.term)}\n\n${escapeHtml(d.meaning)}\n\n` +
          `💬 <i>${escapeHtml(d.example)}</i>\n\n🇺🇿 ${escapeHtml(d.uz)}` +
          specialFooter(env, "#WordOfTheDay", "🗣"),
      };
    }
    case "faq": {
      const d = await geminiJson<{ question: string; answer: string }>(
        env,
        `Telegram kanali uchun "Ko'p so'raladigan savol" posti yoz. ${common}

question: o'quvchilar tez-tez so'raydigan savol. answer: aniq, foydali javob (2-4 jumla). Ikkalasi ham o'zbek tilida (lotin).

JSON: {"question": "...", "answer": "..."}`
      );
      return {
        type: "text",
        html:
          `❓ <b>${escapeHtml(d.question)}</b>\n\n${escapeHtml(d.answer)}\n\n` +
          `Sizda ham savol bormi? Izohlarda yozing 👇` +
          specialFooter(env, "#QnA", "❓"),
      };
    }
    case "campus": {
      const name = pickRandom(CAMPUS_NAMES);
      const d = await geminiJson<{ fact: string; image_prompt: string }>(
        env,
        `Telegram kanali uchun "Campus of the week" posti yoz: ${name}. ${audience}\n${style}\n\n${EMOJI_BAN_NOTE}\n\n${NO_CTA_NOTE}\n\n${SPECIAL_ACCURACY_NOTE}

fact: shu maktab/universitet haqida qiziqarli fakt yoki an'ana (o'zbek tilida lotin, 2 jumla, max 350 belgi).
image_prompt: INGLIZ tilida rasm tavsifi — ${name} ruhidagi stilizatsiya qilingan illustration (klassik me'morchilik, kuz yoki tong, rasm ichida HECH QANDAY yozuv yo'q).

JSON: {"fact": "...", "image_prompt": "..."}`
      );
      return {
        type: "photo",
        imagePrompt: d.image_prompt,
        html: `🏛 <b>${escapeHtml(name)}</b>\n\n${escapeHtml(d.fact)}` + specialFooter(env, "#CampusOfTheWeek", "🏛"),
      };
    }
  }
}

async function generateImage(env: Env, prompt: string): Promise<{ data: string; mime: string } | null> {
  const remaining = (invocationDeadline ?? Date.now() + 60000) - Date.now();
  if (remaining < 6000) return null; // byudjet tugagan — rasmsiz, matn bilan davom etamiz
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_IMAGE_MODEL}:generateContent?key=${env.GEMINI_API_KEY}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: `${prompt}. Flat editorial illustration style, no text or letters in the image.` }] }],
        generationConfig: { responseModalities: ["IMAGE"] },
      }),
      signal: AbortSignal.timeout(Math.min(25000, remaining - 1000)),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as any;
    const parts: any[] = data?.candidates?.[0]?.content?.parts ?? [];
    const img = parts.find((p) => p.inlineData?.data);
    return img ? { data: img.inlineData.data, mime: img.inlineData.mimeType ?? "image/png" } : null;
  } catch {
    return null;
  }
}

async function sendPhotoBytes(
  token: string,
  chatId: number | string,
  image: { data: string; mime: string },
  caption?: string,
  replyMarkup?: unknown
): Promise<any> {
  const bin = atob(image.data);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);

  const form = new FormData();
  form.append("chat_id", String(chatId));
  form.append("photo", new Blob([bytes], { type: image.mime }), "image.png");
  if (caption) {
    form.append("caption", caption);
    form.append("parse_mode", "HTML");
  }
  if (replyMarkup) form.append("reply_markup", JSON.stringify(replyMarkup));
  const res = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, { method: "POST", body: form });
  const out = (await res.json()) as any;
  if (!out.ok) throw new Error(`Telegram API xatoligi (sendPhoto): ${JSON.stringify(out)}`);
  return out.result;
}

/** Maxsus postni yuboradi. Rasmli postda Telegram file_id qaytaradi — preview'dagi AYNAN shu rasmni
 * kanalga qayta yuborish uchun (qayta generatsiya qilinmaydi). */
async function deliverSpecial(
  env: Env,
  chatId: number | string,
  post: SpecialPost,
  opts: { fileId?: string; textOnly?: boolean; replyMarkup?: unknown } = {}
): Promise<{ fileId?: string }> {
  const token = env.ADMIN_BOT_TOKEN;
  if (post.type === "poll") {
    await sendPoll(token, chatId, post.poll, "regular", true, opts.replyMarkup);
    return {};
  }
  if (post.type === "text") {
    await sendMessage(token, chatId, post.html, true, opts.replyMarkup);
    return {};
  }

  const image = opts.fileId || opts.textOnly ? null : await generateImage(env, post.imagePrompt);
  if (!opts.fileId && !image) {
    await sendMessage(token, chatId, post.html, true, opts.replyMarkup); // rasm chiqmasa — matn bilan davom etamiz
    return {};
  }

  const short = post.html.length <= 1000;
  const caption = short ? post.html : undefined;
  const markupOnPhoto = short ? opts.replyMarkup : undefined;
  const msg = opts.fileId
    ? await tgCall(token, "sendPhoto", {
        chat_id: chatId,
        photo: opts.fileId,
        caption,
        parse_mode: caption ? "HTML" : undefined,
        reply_markup: markupOnPhoto,
      })
    : await sendPhotoBytes(token, chatId, image!, caption, markupOnPhoto);
  if (!short) await sendMessage(token, chatId, post.html, true, opts.replyMarkup);
  return { fileId: msg?.photo?.[msg.photo.length - 1]?.file_id };
}

async function postWeeklyLeaderboard(env: Env): Promise<void> {
  const top = await getLeaderboard(env, 10);
  if (!top.length) return;
  await sendMessage(
    env.ADMIN_BOT_TOKEN,
    env.CHANNEL_ID,
    `🏆 Haftalik TOP ${top.length} faol o'quvchi:\n\n${formatLeaderboard(top)}\n\n#Leaderboard`
  );
}

function tashkentNow(): Date {
  return new Date(Date.now() + 5 * 3600 * 1000);
}

function tashkentDate(): string {
  return tashkentNow().toISOString().slice(0, 10);
}

async function postWeeklySpecial(env: Env): Promise<void> {
  const weekday = tashkentNow().getUTCDay();
  const kind = WEEKDAY_SPECIAL[weekday];
  if (await wasPostedManually(env, kind)) {
    await notifySkipped(env, kind);
  } else {
    await deliverSpecial(env, env.CHANNEL_ID, await buildSpecial(env, kind));
  }
  if (weekday === 0) await postWeeklyLeaderboard(env);
}

// ---------------------------------------------------------------------------
// Preview -> "Kanalga joylash" tugmasi va qo'lda joylangan postni bugun avtomatik
// takrorlamaslik. Qo'lda joylash (/post_now yoki tugma) settings jadvaliga
// "manual:<Toshkent sanasi>:<tur>" yozadi; avtomatik post shu belgini tekshiradi
// (Worker cron — to'g'ridan-to'g'ri, GitHub Actions'dagi facts/flex — /api/manual-posted orqali).
// ---------------------------------------------------------------------------

type PreviewRecord =
  | { kind: "facts"; html: string }
  | { kind: "flex"; html: string }
  | { kind: "poll"; pollType: "quiz" | "regular"; poll: PollData }
  | { kind: SpecialKind; post: SpecialPost; fileId?: string; textOnly?: boolean };

const POST_TARGETS = ["facts", "poll", "flex", ...SPECIAL_KINDS];

async function deleteSetting(env: Env, key: string): Promise<void> {
  await env.DB.prepare("DELETE FROM settings WHERE key = ?").bind(key).run();
}

async function markManualPost(env: Env, kind: string): Promise<void> {
  await setSetting(env, `manual:${tashkentDate()}:${kind}`, "1");
}

async function wasPostedManually(env: Env, kind: string): Promise<boolean> {
  return (await getSetting(env, `manual:${tashkentDate()}:${kind}`)) === "1";
}

async function notifySkipped(env: Env, kind: string): Promise<void> {
  await sendMessage(
    env.ADMIN_BOT_TOKEN,
    env.ADMIN_CHAT_ID,
    `⏭ Avtomatik "${kind}" posti o'tkazib yuborildi — bugun u qo'lda joylangan.`
  ).catch(() => {});
}

async function generateRecord(env: Env, target: string): Promise<PreviewRecord> {
  if (target === "facts") {
    const category = pickRandom(CATEGORIES);
    const { fact, reaction } = await generateFact(env, category);
    return { kind: "facts", html: buildFactHtmlForChannel(env, category, fact, reaction) };
  }
  if (target === "flex") return { kind: "flex", html: await buildFlexHtml(env) };
  if (target === "poll") {
    const pollType: "quiz" | "regular" = Math.random() < 0.5 ? "quiz" : "regular";
    return { kind: "poll", pollType, poll: await generatePoll(env, pollType) };
  }
  return { kind: target as SpecialKind, post: await buildSpecial(env, target as SpecialKind) };
}

/** Postni adminning o'ziga (tugma bilan) ko'rsatadi. Rasmli postda file_id'ni record'ga yozadi. */
async function previewRecord(env: Env, chatId: number, rec: PreviewRecord, markup: unknown): Promise<void> {
  const token = env.ADMIN_BOT_TOKEN;
  if (rec.kind === "facts" || rec.kind === "flex") {
    await sendMessage(token, chatId, rec.html, true, markup);
  } else if (rec.kind === "poll") {
    await sendPoll(token, chatId, rec.poll, rec.pollType, true, markup);
  } else {
    const r = await deliverSpecial(env, chatId, rec.post, { replyMarkup: markup });
    if (rec.post.type === "photo") {
      rec.fileId = r.fileId;
      rec.textOnly = !r.fileId;
    }
  }
}

/** Kanalga joylaydi va bugun uchun "qo'lda joylandi" deb belgilaydi. */
async function publishRecord(env: Env, rec: PreviewRecord): Promise<void> {
  if (rec.kind === "facts" || rec.kind === "flex") {
    await sendMessage(env.BOT_TOKEN, env.CHANNEL_ID, rec.html, true);
  } else if (rec.kind === "poll") {
    if (rec.pollType === "quiz") await postGamifiedQuiz(env, rec.poll);
    else await sendPoll(env.ADMIN_BOT_TOKEN, env.CHANNEL_ID, rec.poll, "regular", true);
  } else {
    await deliverSpecial(env, env.CHANNEL_ID, rec.post, { fileId: rec.fileId, textOnly: rec.textOnly });
  }
  await markManualPost(env, rec.kind);
}

async function handlePreviewPublish(env: Env, cq: NonNullable<TelegramUpdate["callback_query"]>) {
  if (!isAdmin(env, cq.from.id)) {
    await answerCallbackQuery(env, cq.id, "⛔ Bu tugma faqat admin uchun.", true);
    return;
  }
  const key = `preview:${(cq.data ?? "").slice(3)}`;
  const raw = await getSetting(env, key);
  if (!raw) {
    await answerCallbackQuery(env, cq.id, "Bu preview eskirgan yoki allaqachon joylangan.", true);
    return;
  }
  await deleteSetting(env, key); // ikki marta bosilsa, ikki marta joylanmasin
  try {
    await publishRecord(env, JSON.parse(raw) as PreviewRecord);
    await removeInlineKeyboard(env, cq.message!.chat.id, cq.message!.message_id);
    await answerCallbackQuery(env, cq.id, "✅ Kanalga joylandi! Bugungi avtomatik post o'tkazib yuboriladi.", true);
  } catch (e) {
    await setSetting(env, key, raw); // xatoda qayta urinib ko'rish mumkin bo'lsin
    await answerCallbackQuery(env, cq.id, `❌ Xatolik: ${(e as Error).message}`, true);
  }
}

// ---------------------------------------------------------------------------
// Worker entrypoint
// ---------------------------------------------------------------------------

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // CORS preflight (my-harvard-path.pages.dev saytidan so'rovlar uchun)
    if (request.method === "OPTIONS" && url.pathname.startsWith("/api/")) {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // Mini App JSON API
    if (url.pathname === "/api/me") return handleApiMe(request, env);
    if (url.pathname === "/api/leaderboard") return handleApiLeaderboard(request, env);
    if (url.pathname === "/api/history") return handleApiHistory(request, env);
    if (url.pathname === "/api/deadline") return handleApiDeadline(request, env);
    if (url.pathname === "/api/manual-posted") {
      // main.py (GitHub Actions) avtomatik post oldidan so'raydi: bugun qo'lda joylanganmi?
      const kind = url.searchParams.get("kind") ?? "";
      if (!["facts", "flex"].includes(kind)) return jsonResponse({ error: "bad kind" }, 400);
      return jsonResponse({ posted: await wasPostedManually(env, kind) });
    }

    // Mini App statik fayllari (public/index.html va h.k.)
    if (request.method === "GET") {
      return env.ASSETS.fetch(request);
    }

    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
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

    if (update.callback_query) {
      await handleCallbackQuery(env, update.callback_query).catch(() => {});
      return new Response("OK");
    }

    const message = update.message;
    if (!message?.text || !message.from) {
      return new Response("OK");
    }

    const text = message.text.trim();
    const chatId = message.chat.id;
    const fromId = message.from.id;

    // Buyruq (Gemini, rasm) sekin bo'lishi mumkin: Telegram javob kechiksa xabarni QAYTA yuboradi
    // (preview ikki marta chiqib qolardi). Shu sabab darrov "OK" qaytarib, ishni fonda bajaramiz.
    const runCommand = async () => {
    invocationDeadline = Date.now() + 28000; // waitUntil ~30s limiti ichida qolish uchun
    try {
      if (text === "/fact" || text === "/fact@" || text.startsWith("/fact ")) {
        await handleFactCommand(env, chatId);
      } else if (text.startsWith("/post_now")) {
        await handlePostNowCommand(env, chatId, fromId, text.split(/\s+/).slice(1));
      } else if (text.startsWith("/preview")) {
        await handlePreviewCommand(env, chatId, fromId, text.split(/\s+/).slice(1));
      } else if (text.startsWith("/deadline")) {
        await handleDeadlineArgCommand(env, chatId, fromId, text.split(/\s+/).slice(1), "close");
      } else if (text.startsWith("/opendate")) {
        await handleDeadlineArgCommand(env, chatId, fromId, text.split(/\s+/).slice(1), "open");
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
      } else if (text === "/start") {
        await sendMessage(env.ADMIN_BOT_TOKEN, chatId, WELCOME_TEXT, true);
      } else if (text === "/help") {
        await sendMessage(env.ADMIN_BOT_TOKEN, chatId, buildHelpText(isAdmin(env, fromId)), true);
      }
    } catch (e) {
      // Xatolikni foydalanuvchiga ko'rsatamiz, lekin Worker'ni yiqitmaymiz
      await sendMessage(env.ADMIN_BOT_TOKEN, chatId, `❌ Xatolik: ${(e as Error).message}`).catch(() => {});
    }
    };
    ctx.waitUntil(runCommand());

    return new Response("OK");
  },

  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    const paused = await getSetting(env, "paused");
    if (paused === "true") return;
    // Cloudflare Free rejasida akkauntga 5 ta cron limiti bor — shu sabab bitta trigger
    // ichida avval poll/viktorina, so'ng kunning maxsus posti yuboriladi.
    if (await wasPostedManually(env, "poll")) await notifySkipped(env, "poll");
    else await postDailyPollOrQuiz(env);
    await postWeeklySpecial(env).catch(() => {});
  },
};
