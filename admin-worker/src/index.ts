/**
 * Harvard Path — Admin control bot (Cloudflare Worker)
 *
 * Bu bot @GoingToHarvard_bot (sayt boti) dan BUTUNLAY ALOHIDA — shu sababli
 * saytdagi login/Lessons/Quiz funksiyalariga hech qanday ta'sir qilmaydi.
 *
 * Buyruqlar:
 *   /fact                  — hoziroq shaxsiy fakt (hammaga ochiq)
 *   /post_now facts|poll|flex — kanalga hoziroq post yuborish (faqat admin)
 */

interface TelegramUpdate {
  message?: {
    message_id: number;
    text?: string;
    chat: { id: number };
    from?: { id: number };
  };
}

export interface Env {
  ADMIN_BOT_TOKEN: string; // shu Worker webhook orqali tinglaydigan yangi bot
  BOT_TOKEN: string; // kanalga admin bo'lgan mavjud fact-bot tokeni (postlash uchun)
  CHANNEL_ID: string;
  CHANNEL_USERNAME: string;
  GEMINI_API_KEY: string;
  ADMIN_CHAT_ID: string; // faqat shu Telegram user_id /post_now ishlata oladi
  WEBHOOK_SECRET: string; // Telegram secret_token tekshiruvi uchun
}

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
  const { name, daysLeft } = nextApproxDeadline();

  const hook = FLEX_HOOKS[Math.floor(Math.random() * FLEX_HOOKS.length)];
  const factHtml = applyBoldMarkup(escapeHtml(fact));
  const countdownLine = `📅 Taxminan <b>~${daysLeft} kun</b> qoldi — ${escapeHtml(name)} (aniq sana e'lon qilinganda yangilanadi)`;

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

async function sendPoll(token: string, chatId: number | string, poll: PollData, pollType: "quiz" | "regular") {
  const payload: Record<string, unknown> = {
    chat_id: chatId,
    question: poll.question,
    options: poll.options,
    is_anonymous: true,
    type: pollType,
  };
  if (pollType === "quiz") {
    payload.correct_option_id = poll.correct_index;
    if (poll.explanation) payload.explanation = poll.explanation;
  }
  return tgCall(token, "sendPoll", payload);
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
  if (String(fromId) !== env.ADMIN_CHAT_ID) {
    await sendMessage(env.ADMIN_BOT_TOKEN, chatId, "⛔ Bu buyruq faqat admin uchun.");
    return;
  }

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
      const pollType: "quiz" | "regular" = Math.random() < 0.5 ? "quiz" : "regular";
      const poll = await generatePoll(env, pollType);
      await sendPoll(env.BOT_TOKEN, env.CHANNEL_ID, poll, pollType);
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
        const args = text.split(/\s+/).slice(1);
        await handlePostNowCommand(env, chatId, fromId, args);
      } else if (text === "/start") {
        await sendMessage(
          env.ADMIN_BOT_TOKEN,
          chatId,
          "👋 Salom! /fact — hoziroq fakt olish uchun. /post_now facts|poll|flex — adminlar uchun."
        );
      }
    } catch (e) {
      // Xatolikni foydalanuvchiga ko'rsatamiz, lekin Worker'ni yiqitmaymiz
      await sendMessage(env.ADMIN_BOT_TOKEN, chatId, `❌ Xatolik: ${(e as Error).message}`).catch(() => {});
    }

    return new Response("OK");
  },
};
