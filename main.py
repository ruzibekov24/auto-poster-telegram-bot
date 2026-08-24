"""
Telegram kanaliga avtomatik "fact" postlari tashlaydigan bot.

Ish tartibi:
1. Kuniga belgilangan vaqtlarda (APScheduler cron) ishga tushadi.
2. Tasodifiy kategoriya tanlanadi.
3. Google Gemini API orqali shu kategoriyada yangi fakt matni generatsiya qilinadi.
4. Oxirgi 20 ta fakt bilan solishtirilib, takrorlanish bo'lsa qayta generatsiya qilinadi.
5. Tayyor post Telegram Bot API orqali kanalga yuboriladi.
"""

import asyncio
import json
import logging
import os
import random
from datetime import datetime
from pathlib import Path

import httpx
from apscheduler.schedulers.asyncio import AsyncIOScheduler
from apscheduler.triggers.cron import CronTrigger
from dotenv import load_dotenv
from google import genai
from telegram import Bot
from telegram.error import TelegramError

# ----------------------------------------------------------------------------
# Konfiguratsiya
# ----------------------------------------------------------------------------

load_dotenv()

BOT_TOKEN = os.getenv("BOT_TOKEN")
CHANNEL_ID = os.getenv("CHANNEL_ID")
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")
CHANNEL_USERNAME = os.getenv("CHANNEL_USERNAME", CHANNEL_ID or "@MyHarvardPath")

# Ixtiyoriy: har bir post natijasi (muvaffaqiyat/xato) haqida shaxsiy xabar olish uchun
# o'z Telegram chat ID'ingizni kiriting (@userinfobot orqali bilib olish mumkin)
ADMIN_CHAT_ID = os.getenv("ADMIN_CHAT_ID")

# Ixtiyoriy: healthchecks.io (yoki shunga o'xshash) monitoring URL — jarayon o'zi
# ishdan chiqsa (masalan server o'chib qolsa) ham SIZGA alohida ogohlantirish keladi
HEALTHCHECK_URL = os.getenv("HEALTHCHECK_URL")

GEMINI_MODEL = "gemini-3.6-flash"
TIMEZONE = "Asia/Tashkent"
POST_TIMES = [(9, 0)]  # (soat, minut) — Toshkent vaqti, har kuni soat 9:00 da post

BASE_DIR = Path(__file__).resolve().parent
RECENT_FACTS_FILE = BASE_DIR / "recent_facts.json"
LOG_FILE = BASE_DIR / "bot.log"
MAX_RECENT_FACTS = 20
MAX_GENERATION_ATTEMPTS = 3

CATEGORIES = [
    "Crazy facts (fizika, koinot, inson tanasi, hayvonot dunyosi haqida hayratlanarli faktlar)",
    "Fun facts (kulgili, kutilmagan statistikalar)",
    "About love (lowkey/hazil uslubda, jiddiy emas — sevgi psixologiyasi haqida kulgili tarzda)",
    "Random weird facts (g'alati, kam ma'lum faktlar)",
    "Tech/space facts",
]

HOOKS = ["#Facts", "🧠 Did you know?", "🤯 Fact time:", "👀 Ever wondered?"]

# ----------------------------------------------------------------------------
# Logging
# ----------------------------------------------------------------------------

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.FileHandler(LOG_FILE, encoding="utf-8"),
        logging.StreamHandler(),
    ],
)
logger = logging.getLogger("facts_bot")

# ----------------------------------------------------------------------------
# recent_facts.json bilan ishlash (takrorlanishni oldini olish uchun)
# ----------------------------------------------------------------------------


def load_recent_facts() -> list[str]:
    if not RECENT_FACTS_FILE.exists():
        return []
    try:
        with open(RECENT_FACTS_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError) as e:
        logger.warning("recent_facts.json o'qishda xatolik: %s", e)
        return []


def save_recent_fact(fact_text: str) -> None:
    recent = load_recent_facts()
    recent.append(fact_text)
    recent = recent[-MAX_RECENT_FACTS:]
    with open(RECENT_FACTS_FILE, "w", encoding="utf-8") as f:
        json.dump(recent, f, ensure_ascii=False, indent=2)


# ----------------------------------------------------------------------------
# Gemini orqali fakt generatsiya qilish
# ----------------------------------------------------------------------------

gemini_client = genai.Client(api_key=GEMINI_API_KEY)


def build_prompt(category: str, avoid: list[str]) -> str:
    avoid_block = ""
    if avoid:
        avoid_list = "\n".join(f"- {fact}" for fact in avoid[-MAX_RECENT_FACTS:])
        avoid_block = (
            "\n\nQuyidagi faktlarni TAKRORLAMA, ular allaqachon post qilingan:\n"
            f"{avoid_list}"
        )

    return f"""Sen Telegram kanali uchun qisqa "fact" post matni yozadigan copywriter'san.
Kanal auditoriyasi: Gen-Z, fun va hazil-mutoyibali uslubni yaxshi ko'radi.

Kategoriya: {category}

Talablar:
- 1-3 ta qisqa jumlada qiziqarli/kulgili fakt yoz (ingliz tilida).
- Fakt haqiqiy va qiziqarli bo'lsin, lekin jiddiy/akademik ohangda emas.
- Oxirida bitta qisqa, kulgili yoki relatable punchline qo'sh (1 ta mos emoji bilan).
- Matn ichida sarlavha, hashtag yoki username YOZMA — faqat fakt matni va punchline.
- Javobni faqat tayyor matn sifatida qaytar, boshqa hech qanday izoh yoki formatlashsiz.{avoid_block}"""


def generate_fact_text(category: str) -> str:
    recent = load_recent_facts()

    for attempt in range(1, MAX_GENERATION_ATTEMPTS + 1):
        prompt = build_prompt(category, recent)
        response = gemini_client.models.generate_content(
            model=GEMINI_MODEL,
            contents=prompt,
        )
        fact_text = response.text.strip()

        if fact_text not in recent:
            return fact_text

        logger.info("Takroriy fakt chiqdi, qayta urinish (%s/%s)", attempt, MAX_GENERATION_ATTEMPTS)

    # Barcha urinishlardan keyin ham takror chiqsa, oxirgi natijani ishlatamiz
    logger.warning("Takrorlanmas fakt topilmadi, oxirgi generatsiya ishlatiladi")
    return fact_text


def build_post_text(category: str) -> str:
    hook = random.choice(HOOKS)
    fact = generate_fact_text(category)
    return f"{hook}\n{fact}\n\n#Facts\n{CHANNEL_USERNAME}"


# ----------------------------------------------------------------------------
# Monitoring: adminga xabar va tashqi healthcheck ping
# ----------------------------------------------------------------------------


async def notify_admin(bot: Bot, text: str) -> None:
    """Ixtiyoriy: post natijasi haqida sizga shaxsiy xabar yuboradi (ADMIN_CHAT_ID bo'lsa)."""
    if not ADMIN_CHAT_ID:
        return
    try:
        await bot.send_message(chat_id=ADMIN_CHAT_ID, text=text)
    except TelegramError as e:
        logger.warning("Adminga xabar yuborib bo'lmadi: %s", e)


def ping_healthcheck(success: bool) -> None:
    """Ixtiyoriy: healthchecks.io kabi xizmatga ping yuboradi (HEALTHCHECK_URL bo'lsa).

    Jarayon o'zi butunlay to'xtab qolsa (server o'chib qolsa, kod xato bilan
    crash bo'lsa) bu ping ham kelmay qoladi va monitoring xizmati sizga
    alohida (email/Telegram) ogohlantirish yuboradi — bu Telegramga xabar
    yuborishdan farqli, chunki jarayonning o'zi ishlamay qolganda ham ishlaydi.
    """
    if not HEALTHCHECK_URL:
        return
    url = HEALTHCHECK_URL if success else f"{HEALTHCHECK_URL}/fail"
    try:
        httpx.get(url, timeout=10)
    except httpx.HTTPError as e:
        logger.warning("Healthcheck ping yuborilmadi: %s", e)


# ----------------------------------------------------------------------------
# Telegramga post yuborish
# ----------------------------------------------------------------------------


async def send_fact_post() -> None:
    category = random.choice(CATEGORIES)
    logger.info("Yangi post tayyorlanmoqda. Kategoriya: %s", category)
    bot = Bot(token=BOT_TOKEN)

    try:
        post_text = build_post_text(category)
    except Exception as e:
        logger.error("Fakt generatsiya qilishda xatolik: %s", e)
        await notify_admin(bot, f"❌ Fakt generatsiya qilishda xatolik: {e}")
        ping_healthcheck(success=False)
        return

    try:
        await bot.send_message(chat_id=CHANNEL_ID, text=post_text)
        # Faqat fakt matnini (hook/hashtag/username'siz) recent_facts.json'ga saqlaymiz
        fact_only = post_text.split("\n", 1)[1].split("\n\n#Facts")[0]
        save_recent_fact(fact_only)
        logger.info("Post muvaffaqiyatli yuborildi: %s", CHANNEL_ID)
        await notify_admin(bot, f"✅ Post yuborildi ({datetime.now():%Y-%m-%d %H:%M})\n\n{post_text}")
        ping_healthcheck(success=True)
    except TelegramError as e:
        logger.error("Telegramga post yuborishda xatolik: %s", e)
        await notify_admin(bot, f"❌ Telegramga post yuborishda xatolik: {e}")
        ping_healthcheck(success=False)
    except Exception as e:
        logger.error("Kutilmagan xatolik post yuborishda: %s", e)
        await notify_admin(bot, f"❌ Kutilmagan xatolik: {e}")
        ping_healthcheck(success=False)


# ----------------------------------------------------------------------------
# Scheduler
# ----------------------------------------------------------------------------


def setup_scheduler() -> AsyncIOScheduler:
    scheduler = AsyncIOScheduler(timezone=TIMEZONE)
    for hour, minute in POST_TIMES:
        scheduler.add_job(
            send_fact_post,
            trigger=CronTrigger(hour=hour, minute=minute, timezone=TIMEZONE),
            id=f"post_{hour:02d}{minute:02d}",
        )
        logger.info("Post vaqti belgilandi: %02d:%02d (%s)", hour, minute, TIMEZONE)
    return scheduler


async def main() -> None:
    if not BOT_TOKEN or not CHANNEL_ID or not GEMINI_API_KEY:
        logger.error(
            "BOT_TOKEN, CHANNEL_ID yoki GEMINI_API_KEY topilmadi. .env faylini tekshiring."
        )
        return

    logger.info("Bot ishga tushdi. Joriy vaqt: %s", datetime.now())
    scheduler = setup_scheduler()
    scheduler.start()

    # Dastur doim ishlab tursin
    try:
        while True:
            await asyncio.sleep(3600)
    except (KeyboardInterrupt, SystemExit):
        logger.info("Bot to'xtatildi.")
        scheduler.shutdown()


if __name__ == "__main__":
    asyncio.run(main())
