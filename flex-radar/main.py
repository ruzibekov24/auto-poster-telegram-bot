"""FLEX Radar — FLEX (Future Leaders Exchange Program, O'zbekiston) uchun
RASMIY manbalarni kuzatib, ariza/ro'yxatdan o'tish rasman ochilganini
avtomatik aniqlaydi va Telegram orqali xabar beradi.

Ish tartibi (har ishga tushirishda):
1. sources.yaml'dagi har bir manbadan joriy matnni oladi.
2. Oldingi snapshot bilan solishtiradi (faqat MA'NOLI farq muhim).
3. Farq topilsa, Gemini orqali "bu ariza ochilishini bildiradimi?" deb so'raydi.
4. Yuqori ishonchli signal kamida 2 ta mustaqil manbada (24 soat ichida)
   tasdiqlansa, sizga Telegram orqali (tasdiqlash tugmalari bilan) xabar beradi.
5. Bir xil event ikki marta xabar qilinmaydi.
"""

import datetime
import json
import logging
import os
import sys
from pathlib import Path

import yaml
from dotenv import load_dotenv

from classify.gemini_classifier import classify_change
from diff.differ import has_meaningful_diff
from diff.normalizer import normalize
from fetchers.instagram_fetcher import fetch_instagram_signal
from fetchers.web_fetcher import fetch_text
from notify.telegram_notifier import send_alert, send_warning

load_dotenv()

BASE_DIR = Path(__file__).resolve().parent
SOURCES_FILE = BASE_DIR / "sources.yaml"
SNAPSHOTS_DIR = BASE_DIR / "state" / "snapshots"
ALERTED_EVENTS_FILE = BASE_DIR / "state" / "alerted_events.json"
PENDING_SIGNALS_FILE = BASE_DIR / "state" / "pending_signals.json"

BOT_TOKEN = os.getenv("ADMIN_BOT_TOKEN")
ADMIN_CHAT_ID = os.getenv("ADMIN_CHAT_ID")

CONFIDENCE_THRESHOLD = 85
MIN_CORROBORATING_SOURCES = 2  # yolg'on signalni kamaytirish uchun kamida N ta mustaqil manba
CORROBORATION_WINDOW_HOURS = 24

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("flex_radar")

SNAPSHOTS_DIR.mkdir(parents=True, exist_ok=True)


def load_sources() -> list[dict]:
    with open(SOURCES_FILE, "r", encoding="utf-8") as f:
        data = yaml.safe_load(f)
    return [s for s in data["sources"] if s.get("enabled", True)]


def load_json(path: Path, default):
    if not path.exists():
        return default
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (json.JSONDecodeError, OSError) as e:
        logger.warning("%s o'qishda xatolik: %s", path.name, e)
        return default


def save_json(path: Path, data) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def snapshot_path(source_id: str) -> Path:
    return SNAPSHOTS_DIR / f"{source_id}.txt"


def prune_old_signals(signals: dict) -> dict:
    now = datetime.datetime.now(datetime.timezone.utc)
    fresh = {}
    for source_id, entry in signals.items():
        try:
            ts = datetime.datetime.fromisoformat(entry["timestamp"])
        except (KeyError, ValueError):
            continue
        if (now - ts).total_seconds() < CORROBORATION_WINDOW_HOURS * 3600:
            fresh[source_id] = entry
    return fresh


def check_one_source(source: dict) -> str | None:
    """Manbadan joriy matnni oladi. Xatolik bo'lsa None qaytaradi va admin'ga ogohlantiradi."""
    name = source["name"]
    url = source["url"]
    source_type = source.get("type", "web")

    try:
        if source_type == "instagram":
            return fetch_instagram_signal(url)
        return fetch_text(url)
    except Exception as e:  # noqa: BLE001 — bitta manba xato bersa, boshqalar davom etsin
        logger.error("Manba o'qishda xatolik (%s): %s", name, e)
        if source_type != "instagram":
            # Instagram best-effort — xato kutilgan holat, admin'ga ovoza qilib bezovta qilmaymiz
            try:
                send_warning(
                    BOT_TOKEN,
                    ADMIN_CHAT_ID,
                    f"⚠️ FLEX Radar: \"{name}\" manbasini o'qib bo'lmadi.\n{e}\n\nBoshqa manbalar davom etmoqda.",
                )
            except Exception:  # noqa: BLE001 — ogohlantirish yuborilmasa ham davom etamiz
                logger.error("Ogohlantirish yuborilmadi.")
        return None


def main() -> None:
    if not BOT_TOKEN or not ADMIN_CHAT_ID:
        logger.error("ADMIN_BOT_TOKEN yoki ADMIN_CHAT_ID topilmadi. Muhit o'zgaruvchilarini tekshiring.")
        sys.exit(1)

    sources = load_sources()
    alerted_events = load_json(ALERTED_EVENTS_FILE, [])
    pending_signals = prune_old_signals(load_json(PENDING_SIGNALS_FILE, {}))

    for source in sources:
        source_id = source["id"]
        name = source["name"]
        logger.info("Tekshirilmoqda: %s", name)

        raw_text = check_one_source(source)
        if raw_text is None:
            continue

        new_text = normalize(raw_text)
        snap_path = snapshot_path(source_id)
        old_text = snap_path.read_text(encoding="utf-8") if snap_path.exists() else ""

        if not old_text:
            # Birinchi marta ishga tushish — boshlang'ich holat, alert yubormaymiz
            snap_path.write_text(new_text, encoding="utf-8")
            logger.info("Boshlang'ich holat saqlandi: %s", name)
            continue

        changed, diff_text = has_meaningful_diff(old_text, new_text)
        snap_path.write_text(new_text, encoding="utf-8")

        if not changed:
            continue

        logger.info("Ma'noli o'zgarish topildi: %s", name)

        try:
            result = classify_change(name, source["url"], diff_text)
        except Exception as e:  # noqa: BLE001
            logger.error("AI klassifikatsiyada xatolik (%s): %s", name, e)
            continue

        confidence = result.get("confidence", 0)
        if not result.get("is_registration_open") or confidence < CONFIDENCE_THRESHOLD:
            logger.info("Tegishli emas yoki past ishonch (%s): %s%%", name, confidence)
            continue

        logger.info("Yuqori ishonchli signal (%s): %s%%", name, confidence)
        pending_signals[source_id] = {
            "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat(),
            "source": source,
            "result": result,
        }

    save_json(PENDING_SIGNALS_FILE, pending_signals)

    if len(pending_signals) < MIN_CORROBORATING_SOURCES:
        logger.info(
            "Hozircha %s/%s ta manba tasdiqladi — alert yuborilmaydi.",
            len(pending_signals), MIN_CORROBORATING_SOURCES,
        )
        save_json(ALERTED_EVENTS_FILE, alerted_events)
        return

    event_key = "flex_registration_open"
    if event_key in alerted_events:
        logger.info("Bu event allaqachon xabar qilingan — qayta yuborilmaydi.")
        save_json(ALERTED_EVENTS_FILE, alerted_events)
        return

    best_id, best_entry = max(pending_signals.items(), key=lambda kv: kv[1]["result"]["confidence"])
    send_alert(
        BOT_TOKEN,
        ADMIN_CHAT_ID,
        source_name=best_entry["source"]["name"],
        source_url=best_entry["source"]["url"],
        confidence=best_entry["result"]["confidence"],
        reasoning=best_entry["result"]["reasoning"],
        suggested_post=best_entry["result"]["suggested_post"],
    )
    alerted_events.append(event_key)
    save_json(ALERTED_EVENTS_FILE, alerted_events)
    logger.info(
        "✅ Alert yuborildi! (%s ta manba tasdiqladi: %s)",
        len(pending_signals), ", ".join(pending_signals.keys()),
    )


if __name__ == "__main__":
    main()
