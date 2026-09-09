"""Gemini orqali: aniqlangan o'zgarish FLEX arizasi rasman ochilganini
bildiradimi yoki yo'qmi, baholaydi."""

import json
import os
import time

from dotenv import load_dotenv
from google import genai
from google.genai import types as genai_types

load_dotenv()  # bu modul main.py'dan ERTAROQ import qilinishi mumkin, shu sabab mustaqil chaqiramiz

GEMINI_MODEL = "gemini-3.6-flash"
API_RETRY_ATTEMPTS = 4
API_RETRY_BASE_DELAY = 3  # soniya, har urinishda ko'payadi

_client = genai.Client(api_key=os.getenv("GEMINI_API_KEY"))


def _call_gemini(prompt: str):
    config = genai_types.GenerateContentConfig(response_mime_type="application/json")
    last_error: Exception | None = None
    for attempt in range(1, API_RETRY_ATTEMPTS + 1):
        try:
            return _client.models.generate_content(model=GEMINI_MODEL, contents=prompt, config=config)
        except Exception as e:  # noqa: BLE001 — vaqtinchalik xatoliklarda qayta urinamiz
            last_error = e
            if attempt < API_RETRY_ATTEMPTS:
                time.sleep(API_RETRY_BASE_DELAY * attempt)
    raise last_error


def classify_change(source_name: str, source_url: str, diff_text: str) -> dict:
    """Qaytaradi: {is_registration_open, confidence (0-100), reasoning, suggested_post}."""
    prompt = f"""Sen FLEX (Future Leaders Exchange Program, O'zbekiston uchun AQSh davlat dasturi)
rasmiy manbalarini kuzatuvchi tizimsan.

Quyida "{source_name}" ({source_url}) rasmiy manbasida aniqlangan o'zgarish (unified diff
formatida, "+" bilan boshlangan qatorlar YANGI qo'shilgan matn):

{diff_text}

Vazifang: shu o'zgarish FLEX dasturiga ARIZA/RO'YXATDAN O'TISH RASMAN OCHILGANINI bildiradimi
yoki bildirmaydimi, aniqla. Faqat aniq va bevosita signal bo'lsa (masalan "Applications are
now open", "Ro'yxatdan o'tish boshlandi", ariza tugmasi/linki yangi paydo bo'lgani, aniq
muddat/sana e'lon qilingani) yuqori ishonch (80-100) ber. Bog'liq bo'lmagan o'zgarishlar
(dizayn, kichik matn tuzatish, umumiy yangilik, bitiruvchilar haqida post, eski ma'lumot) uchun
past ishonch (0-40) ber.

Javobni FAQAT quyidagi JSON formatida qaytar, boshqa hech qanday matn yozma:
{{
  "is_registration_open": true yoki false,
  "confidence": 0 dan 100 gacha butun son,
  "reasoning": "qisqa o'zbekcha izoh, max 200 belgi",
  "suggested_post": "agar is_registration_open=true bo'lsa: Telegram kanaliga postlash uchun tayyor, ANIQ va ishonchli (lekin quruq emas, biroz flex/qiziqarli ohangda) o'zbek tilidagi matn — sarlavha, asosiy xabar, manba linki va CTA bilan. Aks holda bo'sh string \\"\\"."
}}"""
    response = _call_gemini(prompt)
    return json.loads(response.text)
