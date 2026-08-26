# Harvard Path — Admin Control Bot (Cloudflare Worker)

Bu — asosiy facts-bot'dan **butunlay alohida**, yangi Telegram bot orqali ishlaydigan
Cloudflare Worker. Mavjud sayt bot (`@GoingToHarvard_bot`) ga hech qanday ta'sir qilmaydi.

## Buyruqlar

- `/fact` — hoziroq shaxsiy fakt (hammaga ochiq, kanalga chiqmaydi)
- `/post_now facts|poll|flex` — kanalga hoziroq post yuborish (faqat `ADMIN_CHAT_ID`)

## Sozlash

```bash
npm install
```

Secretlarni o'rnatish (har biri alohida so'raladi):

```bash
npx wrangler secret put ADMIN_BOT_TOKEN
npx wrangler secret put BOT_TOKEN
npx wrangler secret put CHANNEL_ID
npx wrangler secret put CHANNEL_USERNAME
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put ADMIN_CHAT_ID
npx wrangler secret put WEBHOOK_SECRET
```

Deploy:

```bash
npx wrangler deploy
```

Webhook ulash (ADMIN_BOT_TOKEN va WEBHOOK_SECRET qiymatlarini ishlatib):

```bash
curl -X POST "https://api.telegram.org/bot<ADMIN_BOT_TOKEN>/setWebhook" \
  -d "url=https://harvard-path-admin-bot.<account>.workers.dev" \
  -d "secret_token=<WEBHOOK_SECRET>"
```

## Eslatma

`main.py`dagi `CATEGORIES`, `POLL_TOPICS`, `APPROX_ROUNDS` o'zgarsa, shu fayldagi
mos konstantalarni ham qo'lda sinxronlab turing (ikki alohida runtime — Python va
Cloudflare Worker — bir xil kontent mantig'ini takrorlaydi).
