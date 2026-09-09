"""Instagram ochiq (public) profil sahifasini o'qiydi — LOGIN TALAB QILINMAYDI,
faqat hamma ko'ra oladigan HTML sahifadan meta-teg o'qiladi.

DIQQAT (best-effort manba): Instagram HTML tuzilishini istalgan vaqt
o'zgartirishi yoki so'rovni rad etishi mumkin. Bu funksiya xato chiqsa None
qaytaradi va chaqiruvchi kod shu manbani jim o'tkazib yuboradi — boshqa
(veb-sayt) manbalar davom etadi, tizim buzilmaydi.
"""

import re

import httpx

USER_AGENT = "Mozilla/5.0 (compatible; FLEXRadarBot/1.0; monitoring official FLEX sources)"

_OG_DESCRIPTION_RE = re.compile(r'<meta property="og:description" content="([^"]*)"')


def fetch_instagram_signal(url: str, timeout: int = 20) -> str | None:
    """Profilning og:description meta tegini qaytaradi (obunachi/post soni, bio matni).

    Bu qiymat o'zgarishi (yangi post e'lon qilinishi, bio yangilanishi) — kuzatuv uchun
    signal sifatida ishlatiladi.
    """
    headers = {"User-Agent": USER_AGENT}
    try:
        with httpx.Client(follow_redirects=True, timeout=timeout, headers=headers) as client:
            response = client.get(url)
            response.raise_for_status()
    except httpx.HTTPError:
        return None

    match = _OG_DESCRIPTION_RE.search(response.text)
    if not match:
        return None
    return match.group(1)
