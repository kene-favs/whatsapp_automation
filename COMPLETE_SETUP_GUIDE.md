# Complete From-Scratch Setup Guide
## WhatsApp Automation Platform — Full MVP

Follow every step in order. Do not skip anything.

---

## WHAT YOU'RE BUILDING

A complete SaaS platform where businesses:
1. Visit your website
2. Fill in their business details
3. Pay (Paystack for Nigeria, Stripe for international)
4. Scan a QR code to connect their WhatsApp
5. Their bot goes live automatically — replies customers, posts status daily

You watch everything from your admin panel.

---

## ACCOUNTS YOU NEED (all free to start)

| Account | Link | Status |
|---------|------|--------|
| Supabase (database) | https://supabase.com | You have it ✅ |
| Paystack (Nigeria payments) | https://paystack.com | You have it ✅ |
| Stripe (international payments) | https://stripe.com | You have it ✅ |
| Railway (server hosting) | https://railway.app | Create free account |
| GitHub (code storage) | https://github.com | Create free account |

---

## PART 1 — INSTALL SOFTWARE ON YOUR COMPUTER

### Step 1: Install Node.js
1. Go to https://nodejs.org
2. Download the **LTS** version (green button)
3. Install it (click Next → Next → Finish)
4. Verify: open Command Prompt and type `node --version`
   → You should see something like `v20.11.0`

### Step 2: Install Git
1. Go to https://git-scm.com/download/win
2. Download and install (all default options, just click Next)
3. Verify: in Command Prompt type `git --version`
   → You should see `git version 2.x.x`

### Step 3: Install VS Code (code editor)
1. Go to https://code.visualstudio.com
2. Download and install
3. This is where you'll view and edit your code files

---

## PART 2 — SET UP SUPABASE DATABASE

### Step 1: Create your project
1. Go to https://supabase.com and log in
2. Click **New Project**
3. Name it: `whatsapp-automation`
4. Set a strong database password (save it somewhere safe)
5. Choose region: **Europe West** (closest to Nigeria with good latency)
6. Click **Create new project** — wait 2 minutes for it to set up

### Step 2: Run the database schema
1. In your Supabase project, click **SQL Editor** in the left sidebar
2. Click **New query**
3. Open the file `supabase-schema.sql` from your project folder
4. Copy all the SQL and paste it into the editor
5. Click **Run** (green button)
6. You should see "Success" — your tables are now created

### Step 3: Get your Supabase keys
1. Go to **Project Settings** (gear icon) → **API**
2. Copy these two values — you'll need them:
   - **Project URL** (looks like `https://xxxx.supabase.co`)
   - **anon public** key (long string starting with `eyJ...`)

---

## PART 3 — SET UP PAYSTACK (Nigeria payments)

### Step 1: Get your API keys
1. Log in to https://dashboard.paystack.com
2. Go to **Settings** → **API Keys & Webhooks**
3. Copy your **Secret Key** (starts with `sk_live_` for live or `sk_test_` for testing)
4. Start with TEST keys until ready to go live

### Step 2: Create a subscription plan
1. Go to **Products** → **Plans**
2. Click **Create Plan**
3. Plan name: `Monthly Bot Subscription`
4. Amount: `10000` (₦10,000)
5. Interval: `monthly`
6. Click **Create Plan**
7. Copy the **Plan Code** (looks like `PLN_xxxx`) — save it

### Step 3: Set up webhook
1. Go to **Settings** → **API Keys & Webhooks**
2. Scroll to **Webhook URL**
3. Enter: `https://YOUR-RAILWAY-URL/webhooks/paystack`
   (You'll fill this in after Railway deployment in Part 5)
4. Check: `charge.success`, `subscription.create`, `invoice.payment_failed`

---

## PART 4 — SET UP STRIPE (international payments)

### Step 1: Get your API keys
1. Log in to https://dashboard.stripe.com
2. Go to **Developers** → **API keys**
3. Copy your **Secret key** (starts with `sk_test_` for testing)

### Step 2: Create products + prices
1. Go to **Products** → **Add product**
2. **Product 1:** Setup Fee
   - Name: `WhatsApp Bot Setup`
   - Price: `$45.00` one time
   - Click **Save product**
   - Copy the **Price ID** (looks like `price_xxxx`)

3. **Product 2:** Monthly Subscription
   - Name: `WhatsApp Bot Monthly`
   - Price: `$10.00` recurring monthly
   - Click **Save product**
   - Copy the **Price ID**

### Step 3: Set up webhook
1. Go to **Developers** → **Webhooks**
2. Click **Add endpoint**
3. URL: `https://YOUR-RAILWAY-URL/webhooks/stripe`
4. Events: `payment_intent.succeeded`, `invoice.payment_succeeded`, `invoice.payment_failed`
5. Click **Add endpoint**
6. Copy the **Signing secret** (starts with `whsec_`)

---

## PART 5 — SET UP GITHUB (code storage)

### Step 1: Create account
1. Go to https://github.com and create a free account

### Step 2: Create repository
1. Click **New** (green button)
2. Repository name: `whatsapp-automation`
3. Set to **Private**
4. Click **Create repository**

### Step 3: Upload your code
1. Open Command Prompt
2. Navigate to your project folder:
   ```
   cd Desktop\whatsapp-automation
   ```
3. Run these commands one by one:
   ```
   git init
   git add .
   git commit -m "Initial commit"
   git branch -M main
   git remote add origin https://github.com/YOUR-USERNAME/whatsapp-automation.git
   git push -u origin main
   ```
4. Refresh GitHub — your files should be there

---

## PART 6 — SET UP RAILWAY (server hosting, runs 24/7)

### Step 1: Create account + deploy
1. Go to https://railway.app
2. Sign up with your GitHub account
3. Click **New Project** → **Deploy from GitHub repo**
4. Select `whatsapp-automation`
5. Railway will start deploying automatically

### Step 2: Add environment variables
1. In Railway, click your project
2. Click **Variables**
3. Add ALL of these (copy from your notes):

```
PORT=3000
NODE_ENV=production

# Supabase
SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_KEY=eyJxxxx...

# Paystack
PAYSTACK_SECRET_KEY=sk_test_xxxx
PAYSTACK_PLAN_CODE=PLN_xxxx

# Stripe
STRIPE_SECRET_KEY=sk_test_xxxx
STRIPE_SETUP_PRICE_ID=price_xxxx
STRIPE_MONTHLY_PRICE_ID=price_xxxx
STRIPE_WEBHOOK_SECRET=whsec_xxxx

# App
JWT_SECRET=make-up-a-long-random-string-here-anything
ADMIN_EMAIL=your@email.com
ADMIN_PASSWORD=your-admin-password
```

### Step 3: Get your Railway URL
1. Click **Settings** → **Domains**
2. Click **Generate Domain**
3. Copy the URL (looks like `https://whatsapp-automation-production.up.railway.app`)
4. Go back to Paystack and Stripe and paste this URL into their webhook fields

---

## PART 7 — INSTALL DEPENDENCIES AND TEST LOCALLY

### Step 1: Install packages
In Command Prompt (in your project folder):
```
npm install
```

### Step 2: Create your .env file
1. Copy `.env.example` → rename copy to `.env`
2. Fill in ALL the values from your notes above

### Step 3: Run locally to test
```
npm start
```
Open http://localhost:3000 — you should see your landing page.

### Step 4: Test the full flow
1. Go to http://localhost:3000
2. Fill in a test business form
3. Use Paystack test card: `4084 0840 8408 4081`, expiry `12/30`, CVV `408`
4. Complete payment
5. QR code should appear
6. Scan it with a WhatsApp number
7. Bot should connect and start working

---

## PART 8 — GO LIVE CHECKLIST

Before switching from test to live mode:

- [ ] Switch Paystack keys from `sk_test_` to `sk_live_`
- [ ] Switch Stripe keys from `sk_test_` to `sk_live_`
- [ ] Update webhook URLs in Paystack and Stripe
- [ ] Update Railway environment variables with live keys
- [ ] Test one real payment end-to-end
- [ ] Set up a custom domain (optional but recommended for credibility)

---

## HOW IT WORKS (the full flow)

```
Client visits your website
        ↓
Fills signup form (business name, WhatsApp number, country, etc.)
        ↓
Clicks "Get Started" → Payment modal appears
        ↓
Pays ₦30,000 setup fee (Paystack) or $45 (Stripe)
        ↓
Payment confirmed → server gets webhook notification
        ↓
Server creates their account in Supabase database
        ↓
QR code appears on their screen automatically
        ↓
Client opens WhatsApp → Linked Devices → Scans QR
        ↓
Bot connects to their WhatsApp ✅
        ↓
Bot starts working immediately:
  • Replies all customer messages automatically
  • Posts to their Status every day
  • Sends broadcasts when you schedule them
        ↓
₦10,000 is charged automatically every month
        ↓
Client can log into their dashboard to update products/flows anytime
        ↓
You see everything in your admin panel at /admin
```

---

## YOUR ADMIN PANEL

Access at: `https://YOUR-RAILWAY-URL/admin`

Login with the ADMIN_EMAIL and ADMIN_PASSWORD you set in environment variables.

You can see:
- All clients and their connection status
- Their flows and status posts
- Payment history
- Connect/disconnect any client

---

## DAILY OPERATIONS (once live)

**You don't need to do anything daily.** The system runs itself.

The only times you intervene:
- A client's WhatsApp logs out (rare) → they re-scan QR from their dashboard
- A client wants a feature not in their dashboard → you do it from admin panel
- A client's payment fails → Paystack/Stripe automatically pauses their subscription

---

## GETTING HELP

If anything breaks:
1. Check Railway logs (your project → Deployments → View logs)
2. Check Supabase logs (your project → Logs)
3. Check Paystack/Stripe webhooks section to see if they're firing

Most common issues:
- **Bot disconnects:** Normal, auto-reconnects in 5s
- **QR doesn't show:** Check Railway logs for errors
- **Payment doesn't confirm:** Check webhook URL is correct in Paystack/Stripe
