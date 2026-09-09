# FLEX Radar

FLEX (Future Leaders Exchange Program, O'zbekiston) uchun **faqat rasmiy manbalarni**
kuzatib, ariza/ro'yxatdan o'tish rasman ochilganini avtomatik aniqlaydigan va
Telegram orqali xabar beradigan tizim.

## Qanday ishlaydi

1. `sources.yaml`dagi har bir rasmiy manbadan (veb-sahifa yoki Instagram) joriy matn olinadi.
2. Oldingi holat (`state/snapshots/`) bilan solishtiriladi — faqat **ma'noli** farq (shovqin
   emas) e'tiborga olinadi.
3. Farq topilsa, Google Gemini orqali "bu FLEX arizasi ochilganini bildiradimi?" deb so'raladi
   (0-100 ishonch darajasi bilan).
4. Ishonch **85%** dan yuqori bo'lgan signal kamida **2 ta mustaqil manbada** (24 soat ichida)
   tasdiqlansagina — sizga Telegram orqali, tasdiqlash tugmalari bilan, xabar keladi.
5. Tugmani bossangiz ("✅ Ha, kanalga post qil"), mavjud Cloudflare Worker (admin-worker)
   xabarni kanalga yuboradi. "❌ Yo'q" bossangiz, hech narsa qilinmaydi.
6. Bir xil event ikki marta xabar qilinmaydi (`state/alerted_events.json`).

## Manbalar (`sources.yaml`)

- American Councils Uzbekistan — rasmiy FLEX sahifasi
- DiscoverFLEX.org — rasmiy global ariza portali
- AQSh elchixonasi Toshkent — FLEX sahifasi
- American Councils — global FLEX dastur sahifasi
- Instagram @flex_program_uz — **ixtiyoriy, past-ishonchli qo'shimcha signal** (best-effort,
  login talab qilinmaydi, lekin Instagram HTML strukturasi o'zgarsa ishlamay qolishi mumkin —
  bu normal, boshqa manbalar davom etadi)

Yangi manba qo'shishdan oldin uni **qo'lda tekshiring** — rasmiy ekaniga ishonch hosil qiling.

## O'rnatish

```bash
pip install -r requirements.txt
cp .env.example .env
```

`.env` faylni to'ldiring (`ADMIN_BOT_TOKEN`, `ADMIN_CHAT_ID`, `GEMINI_API_KEY` — asosiy
loyihadagi bilan bir xil qiymatlar).

Lokal test:

```bash
python main.py
```

## GitHub Actions (production)

`.github/workflows/flex-radar.yml` har 30 daqiqada avtomatik ishga tushadi. Kerakli repo
secrets (agar hali qo'shilmagan bo'lsa):

- `ADMIN_BOT_TOKEN`
- `ADMIN_CHAT_ID`
- `GEMINI_API_KEY`

(`GEMINI_API_KEY` va `ADMIN_CHAT_ID` allaqachon asosiy bot uchun qo'shilgan bo'lishi mumkin —
qayta tekshiring. `ADMIN_BOT_TOKEN` esa hali qo'shilmagan bo'lishi mumkin, chunki u faqat
Cloudflare Worker secret sifatida sozlangan edi.)

## Cheklovlar

- Sayt dizayni o'zgarsa, bog'liq bo'lmagan farq soxta signal berishi mumkin.
- AI klassifikator xato qilishi mumkin — shu sabab 2-manba tasdig'i talab qilinadi.
- Instagram monitoring "huquqiy kulrang zona" (rasmiy API emas, ochiq sahifa o'qish) va
  istalgan payt ishlamay qolishi mumkin.
- GitHub Actions cron aniq vaqtda emas, bir necha daqiqa kechikish bilan ishlaydi.
