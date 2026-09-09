"""Telegram orqali admin'ga alert yuboradi — tasdiqlash tugmalari bilan.

Tugma bosilganda javob mavjud Cloudflare Worker'ning webhook'iga keladi
(admin-worker/src/index.ts) — u xabar matnini SEPARATOR bo'yicha bo'lib,
"kanal posti" qismini ajratib oladi. Shu SEPARATOR ikkala tomonda ham
BIR XIL bo'lishi shart.
"""

import httpx

TELEGRAM_API = "https://api.telegram.org/bot{token}/{method}"

# admin-worker/src/index.ts'dagi FLEX_RADAR_SEPARATOR bilan qo'lda sinxronlab turing
SEPARATOR = "─" * 8  # "────────"


def send_alert(
    bot_token: str,
    admin_chat_id: str,
    source_name: str,
    source_url: str,
    confidence: int,
    reasoning: str,
    suggested_post: str,
) -> None:
    # DIQQAT: SEPARATOR'dan OLDINGI qism — kanalga postlanadigan aynan shu matn
    # (tugma bosilganda Worker shu qismini oladi). Shu sabab bu yerda faqat
    # suggested_post bo'lishi shart, boshqa hech narsa qo'shilmasin.
    text = (
        f"{suggested_post}\n\n"
        f"{SEPARATOR}\n"
        f"🚨 FLEX Radar signal (faqat sizga ko'rinadi)\n"
        f"🔎 Ishonch: {confidence}%\n"
        f"📍 Manba: {source_name}\n"
        f"🔗 {source_url}\n"
        f"🤖 AI izohi: {reasoning}"
    )
    payload = {
        "chat_id": admin_chat_id,
        "text": text,
        "reply_markup": {
            "inline_keyboard": [
                [
                    {"text": "✅ Ha, kanalga post qil", "callback_data": "flexradar:yes"},
                    {"text": "❌ Yo'q", "callback_data": "flexradar:no"},
                ]
            ]
        },
    }
    url = TELEGRAM_API.format(token=bot_token, method="sendMessage")
    with httpx.Client(timeout=20) as client:
        response = client.post(url, json=payload)
        response.raise_for_status()


def send_warning(bot_token: str, admin_chat_id: str, text: str) -> None:
    payload = {"chat_id": admin_chat_id, "text": text}
    url = TELEGRAM_API.format(token=bot_token, method="sendMessage")
    with httpx.Client(timeout=20) as client:
        response = client.post(url, json=payload)
        response.raise_for_status()
