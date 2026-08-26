# Telegram Facts Bot

Telegram kanalga (masalan `@MyHarvardPath`) har kuni uchta avtomatik post tashlaydigan bot (Toshkent vaqti):
- **09:00** — qiziqarli "fact" posti
- **14:00** — poll/viktorina (tasodifiy: ba'zan oddiy so'rovnoma, ba'zan to'g'ri javobli viktorina)
- **20:00** — top universitetlarga ariza topshirish haqida "flex/countdown" posti

Matnlar har safar Google Gemini API orqali yangidan generatsiya qilinadi, shu sababli har bir post noyob va turli xil bo'ladi.

## Fayllar

- `main.py` — asosiy skript (scheduler, Gemini API chaqiruvi, Telegramga yuborish)
- `requirements.txt` — kerakli Python kutubxonalari
- `.env.example` — konfiguratsiya namunasi
- `recent_facts.json` — bot avtomatik yaratadi, oxirgi 20 ta faktni saqlaydi (takrorlanmaslik uchun)
- `recent_flex.json` — bot avtomatik yaratadi, oxirgi 20 ta flex/mini-faktni saqlaydi
- `recent_polls.json` — bot avtomatik yaratadi, oxirgi 20 ta poll savolini saqlaydi
- `bot.log` — bot avtomatik yaratadi, barcha loglar shu yerga yoziladi

## 1. Lokal o'rnatish

### 1.1. Repozitoriyani tayyorlash

```bash
cd "Telegram bot Facts"
python -m venv venv
```

Windows'da faollashtirish:

```bash
venv\Scripts\activate
```

Linux/macOS'da:

```bash
source venv/bin/activate
```

### 1.2. Kutubxonalarni o'rnatish

```bash
pip install -r requirements.txt
```

### 1.3. `.env` faylini yaratish

`.env.example` faylidan nusxa oling va o'z ma'lumotlaringiz bilan to'ldiring:

```bash
cp .env.example .env
```

`.env` faylini oching va quyidagilarni kiriting:

- **BOT_TOKEN** — [@BotFather](https://t.me/BotFather) orqali yaratilgan bot tokeni
- **CHANNEL_ID** — kanal username'i (`@MyHarvardPath`) yoki raqamli ID (`-100...`)
- **GEMINI_API_KEY** — [aistudio.google.com/apikey](https://aistudio.google.com/apikey) dan bepul olinadigan API kalit
- **CHANNEL_USERNAME** — postlar oxirida ko'rsatiladigan username

> **MUHIM:** Botni kanalga **admin** qilib qo'shishni unutmang, aks holda u post yubora olmaydi (`Post Messages` huquqi yetarli).

### 1.4. Botni ishga tushirish

```bash
python main.py
```

Bot ishga tushgach, u fon rejimida ishlab turadi va belgilangan vaqtlarda (10:00, 16:00, 22:00) avtomatik post tashlaydi. To'xtatish uchun `Ctrl+C`.

## 2. VPS'ga joylashtirish (masalan Ubuntu server)

1. Serverga loyihani yuklang (`git clone` yoki `scp` orqali) va yuqoridagi 1.1–1.3 qadamlarni bajaring.
2. Botni doimiy ishlab turishi uchun `systemd` service yarating:

```ini
# /etc/systemd/system/facts-bot.service
[Unit]
Description=Telegram Facts Bot
After=network.target

[Service]
Type=simple
WorkingDirectory=/home/USER/telegram-bot-facts
ExecStart=/home/USER/telegram-bot-facts/venv/bin/python main.py
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
```

3. Service'ni ishga tushirish:

```bash
sudo systemctl daemon-reload
sudo systemctl enable facts-bot
sudo systemctl start facts-bot
```

4. Loglarni kuzatish:

```bash
journalctl -u facts-bot -f
```

yoki loyiha ichidagi `bot.log` faylini o'qing.

## 3. GitHub Actions orqali joylashtirish (server kerak emas — tavsiya etiladi)

Bu usulda hech qanday server yoki kompyuterni doimiy ochiq qoldirish shart emas — GitHub'ning o'zi har kuni belgilangan vaqtda workflow'ni ishga tushiradi. Loyihada `.github/workflows/post.yml` fayli allaqachon tayyor: u har kuni **04:00 UTC (= 09:00 Asia/Tashkent)** da ishga tushadi, bitta `send_fact_post()` chaqiradi va `recent_facts.json`ni yangilanган holda repoga qaytarib commit qiladi (shu sababli takrorlanmaslik nazorati ham saqlanib qoladi).

### 3.1. Repozitoriyani GitHub'ga joylash

```bash
git init
git add .
git commit -m "Initial commit: Telegram facts bot"
```

GitHub'da yangi (bo'sh) repozitoriya yarating (masalan `telegram-facts-bot`), so'ng:

```bash
git remote add origin https://github.com/<username>/<repo-nomi>.git
git branch -M main
git push -u origin main
```

> **MUHIM:** `.env` fayli `.gitignore`ga kiritilgan, u hech qachon GitHub'ga yuklanmaydi — maxfiy ma'lumotlar xavfsiz qoladi.

### 3.2. Repo Secrets qo'shish

GitHub repozitoriyangizda: **Settings → Secrets and variables → Actions → New repository secret** bo'limiga o'ting va quyidagilarni qo'shing (`.env` faylidagi qiymatlar bilan bir xil):

| Secret nomi | Majburiymi |
|---|---|
| `BOT_TOKEN` | Ha |
| `CHANNEL_ID` | Ha |
| `GEMINI_API_KEY` | Ha |
| `CHANNEL_USERNAME` | Ha |
| `ADMIN_CHAT_ID` | Yo'q (ixtiyoriy) |
| `HEALTHCHECK_URL` | Yo'q (ixtiyoriy) |

### 3.3. Test qilish

Push qilgach, **Actions** bo'limiga o'ting, "Post Facts" workflow'ini toping va **Run workflow** tugmasi orqali qo'lda bir marta ishga tushirib ko'ring — shu yerda loglarni ham kuzatishingiz mumkin (4-bo'limdagi log/monitoring usullari GitHub Actions uchun ham ishlaydi).

## 4. Bot ishlab turganini qanday bilamiz?

Bot fon rejimida (VPS yoki GitHub Actions) ishlaganda, uning haqiqatan ham post tashlayotganini bilish uchun bir necha usul mavjud:

> **GitHub Actions orqali joylashtirgan bo'lsangiz**, qo'shimcha sozlashning hojati yo'q: repo'ning **Actions** bo'limida har bir ishga tushishning natijasi (muvaffaqiyatli/xato) va to'liq logi ko'rinib turadi, workflow xato bilan tugasa esa GitHub avtomatik ravishda sizning email manzilingizga ogohlantirish yuboradi. Pastdagi 4.2 va 4.3 bandlari VPS/lokal rejim uchun qo'shimcha, ammo GitHub Actions'da ham ishlayveradi.

### 4.1. `bot.log` fayli (har doim ishlaydi)

Har bir urinish — muvaffaqiyatli yoki xato — `bot.log`ga yoziladi:

```bash
tail -f bot.log
```

`systemd` orqali ishlatayotgan bo'lsangiz:

```bash
journalctl -u facts-bot -f
```

### 4.2. Shaxsiy Telegram xabari (`ADMIN_CHAT_ID`) — tavsiya etiladi

Har bir post yuborilgandan keyin (muvaffaqiyatli bo'lsa ✅, xato bo'lsa ❌) botning o'zi sizga shaxsiy xabar yuboradi — shunda kunига 3 marta log fayl tekshirishga hojat qolmaydi.

1. Telegram'da [@userinfobot](https://t.me/userinfobot)ga yozing — u sizning `chat_id`ingizni qaytaradi.
2. Botga (masalan `@GoingToHarvard_bot`) shaxsiy `/start` bosgan bo'lishingiz kerak (aks holda bot sizga yoza olmaydi).
3. `.env` fayliga qo'shing:

```
ADMIN_CHAT_ID=123456789
```

### 4.3. Tashqi "heartbeat" monitoring (`HEALTHCHECK_URL`) — server o'chib qolsa ham bilib qolasiz

4.2-band faqat kod ishlab turganda ishlaydi. Agar server butunlay o'chib qolsa yoki jarayon crash bo'lsa (masalan xotira yetmasa), botning o'zi hech kimga xabar bera olmaydi — aynan shu holatni ushlab qolish uchun tashqi monitoring kerak:

1. [healthchecks.io](https://healthchecks.io) saytida bepul akkaunt oching.
2. Yangi "Check" yarating: **Period = 1 day**, **Grace = 3 hours** (ya'ni har kuni 9:00'dan keyin ~3 soat ichida ping kelmasa, sizga ogohlantirish yuboriladi).
3. Berilgan ping URL'ni nusxa oling va `.env`ga qo'ying:

```
HEALTHCHECK_URL=https://hc-ping.com/xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

4. healthchecks.io sozlamalarida email yoki Telegram integratsiyasini yoqing — shunda ping kelmay qolsa (bot/server ishlamay qolsa) sizga alohida kanal orqali xabar keladi.

> Ikkala `ADMIN_CHAT_ID` va `HEALTHCHECK_URL` ham **ixtiyoriy** — bo'sh qoldirilsa, bot oddiy tarzda faqat `bot.log`ga yozib ishlashda davom etadi.

## 5. Sozlamalarni o'zgartirish

- **Post vaqtlari**: `main.py` ichidagi `POST_TIMES` (fact post), `POLL_POST_TIME` (poll/viktorina) va `FLEX_POST_TIME` (countdown post) o'zgaruvchilarini o'zgartiring. GitHub Actions orqali ishlatayotgan bo'lsangiz, `.github/workflows/post.yml` faylidagi `cron` qatorlarini ham mos ravishda yangilang (vaqt UTC'da yoziladi).
- **Kategoriyalar**: `main.py` ichidagi `CATEGORY_EMOJI` lug'atiga yangi kategoriya+emoji qo'shishingiz yoki mavjudlarini tahrirlashingiz mumkin.
- **Gemini modeli**: `GEMINI_MODEL` o'zgaruvchisi orqali boshqariladi.

## 6. Flex/Countdown post (universitet ariza muddatlari)

Har kuni soat **20:00 (Toshkent)**da kanalga qo'shimcha post ketadi: top universitetlarga (Harvard, Ivy League) ariza topshirish haqida flex/mini-fakt + "necha kun qoldi" countdown. Bu `send_flex_countdown_post()` funksiyasi orqali ishlaydi (`main.py`).

### 6.1. Hozirgi holat: TAXMINIY countdown

`main.py`dagi `EXACT_DEADLINES` ro'yxati hozircha **bo'sh** — shuning uchun bot `APPROX_ROUNDS`da yozilgan, top universitetlarda har yili taqriban takrorlanadigan sanalarga (Early Action ~1-noyabr, Regular Decision ~1-yanvar) asoslanib **taxminiy** countdown ko'rsatadi va postda buni ochiq yozadi ("Taxminan ~N kun qoldi ... aniq sana e'lon qilinganda yangilanadi").

> Kunlar soni har doim **Python tomonidan aniq hisoblanadi** (AI emas) — shu sababli son hech qachon soxta yoki noto'g'ri bo'lmaydi, faqat qaysi sana asos qilib olinganini (aniq/taxminiy) belgilash kerak.

### 6.2. Aniq muddatlar ma'lum bo'lganda

Universitetning rasmiy ariza muddati e'lon qilingach, `main.py`dagi `EXACT_DEADLINES` ro'yxatiga qo'shing:

```python
EXACT_DEADLINES: list[dict] = [
    {"university": "Harvard", "round": "Regular Decision", "date": "2027-01-01"},
    {"university": "MIT", "round": "Early Action", "date": "2026-11-01"},
]
```

Ro'yxat to'ldirilishi bilanoq bot avtomatik ravishda **aniq** countdown'ga o'tadi (eng yaqin muddatni tanlaydi) va "Taxminan" so'zini olib tashlaydi.

## 7. Poll/Viktorina

Har kuni soat **14:00 (Toshkent)**da kanalga Telegram'ning o'z poll funksiyasi orqali (`send_poll_post()`, `main.py`) so'rovnoma ketadi. Har safar tasodifiy ikkitadan biri tanlanadi:

- **Viktorina (quiz)** — 3-4 variantli savol, bitta to'g'ri javob bilan. Foydalanuvchi javob bergach, Telegram avtomatik "to'g'ri/noto'g'ri" ko'rsatadi va qisqa izoh chiqadi.
- **Oddiy so'rovnoma (poll)** — to'g'ri javobsiz, shunchaki fikr-mulohaza so'raladi (masalan "hozir nima qilyapsiz?" kabi relatable savol).

Mavzu `main.py`dagi `POLL_TOPICS` ro'yxatidan tasodifiy tanlanadi — random fakt/trivia, universitet ariza jarayoni, talaba hayoti yoki umumiy Gen-Z mavzular. Yangi mavzu qo'shish uchun shu ro'yxatga bitta qator qo'shsangiz kifoya.

## 8. Muammolarni bartaraf etish

| Muammo | Yechim |
|---|---|
| Post yuborilmayapti | `bot.log` faylini tekshiring, xatolik sababi shu yerda yoziladi |
| `Chat not found` xatosi | Bot kanalga admin sifatida qo'shilganiga ishonch hosil qiling |
| Gemini API xatosi | `GEMINI_API_KEY` to'g'riligini va kunlik bepul limitni tekshiring |
| Takroriy faktlar chiqyapti | `recent_facts.json` faylini o'chirmang, u takrorlanishni oldini oladi |
