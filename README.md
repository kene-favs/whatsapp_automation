# 🤖 ForgeBot — WhatsApp Automation Platform

**Enterprise-grade WhatsApp business automation for Nigerian & African businesses**

```
╔════════════════════════════════════════════════════════════════════╗
║                                                                    ║
║  ForgeBot — Your WhatsApp Should Be Making Sales While You Sleep ║
║                                                                    ║
║  • 24/7 Automated WhatsApp Replies                               ║
║  • Payment Alerts & Confirmation System                          ║
║  • Status Post Scheduler                                         ║
║  • Voice Transcription (Nigerian Languages)                      ║
║  • Human Handoff Detection                                       ║
║  • Multi-Client Admin Dashboard                                  ║
║                                                                    ║
╚════════════════════════════════════════════════════════════════════╝
```

---

## 📋 Overview

**ForgeBot** is a complete SaaS platform that turns WhatsApp into a 24/7 sales machine for African businesses. Built with **Node.js + Express + Baileys + Supabase**, it automates customer interactions while keeping the human touch.

### Who It's For
- **Nigerian E-commerce Businesses** (Fashion, Food, Cosmetics, Salons)
- **Ghanaian & Kenyan Traders** (Bulk sellers, wholesalers)
- **Anyone in Africa** selling via WhatsApp

### What It Solves
- 🚫 **Lost Customers** → 24/7 auto-replies to inquiries (price, availability, payment)
- 🚫 **Missed Payments** → Automatic payment alerts when customers claim payment
- 🚫 **Manual Posting** → Scheduled status posts to showcase products
- 🚫 **Language Barriers** → Transcribe voice notes from Yoruba, Igbo, Hausa to English
- 🚫 **Burnout** → Bot handles simple questions, alerts you for complex ones

---

## 🏗️ Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    ForgeBot Ecosystem                           │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────────────────────┐         ┌──────────────────────┐ │
│  │  Landing Page / Signup   │         │  Bot Instance        │ │
│  │  (index.html)            │         │  (Baileys + Node)    │ │
│  │  ─────────────────────   │         │  ──────────────────  │ │
│  │  • Marketing copy        │────────→│  • Listen for msgs   │ │
│  │  • Pricing (₦30K/month)  │         │  • Match keywords    │ │
│  │  • Flutterwave payment   │         │  • Send replies      │ │
│  │  • Email verification    │         │  • Post to status    │ │
│  └──────────────────────────┘         │  • Alert on payment  │ │
│                                       └──────────────────────┘ │
│           ▲                                       ▼              │
│           │                    Supabase (PostgreSQL)            │
│           │                                                      │
│  ┌────────┴──────────────────────────────────────┐             │
│  │                                               │              │
│  ▼                                               ▼              │
│ ┌──────────────────┐                  ┌──────────────────┐    │
│ │  Admin Dashboard │                  │  Client Database │    │
│ │  (Admin panel)   │                  │                  │    │
│ │  ──────────────  │                  │  • Clients       │    │
│ │  • All clients   │                  │  • Flows         │    │
│ │  • Payments      │                  │  • Status posts  │    │
│ │  • Broadcasts    │                  │  • Chat history  │    │
│ │  • Bot stats     │                  │  • Subscriptions │    │
│ └──────────────────┘                  └──────────────────┘    │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## 🎯 Key Features

### 1. **24/7 Auto-Reply System**
Customers send WhatsApp messages → Bot instantly replies with pre-configured answers.

**Supported Topics:**
- 💰 Price inquiries
- 📦 Availability & stock
- 🚚 Delivery & shipping
- 💳 Payment methods
- ⏰ Business hours
- 🔧 Custom keywords

**Example Flow:**
```
Customer: "How much for a dress?"
Bot: "Hello! Our dresses start at ₦5,000. Which style interest you? See our catalog: [link]"
```

### 2. **Payment Alert System** 
When customer sends "I've paid" → Bot alerts you immediately with their account details.

**Workflow:**
```
Customer: "I paid you just now"
↓
Bot detects payment claim
↓
Bot: "Thank you! Confirming with seller..."
↓
Admin receives alert: "Payment received from Chioma Okafor"
↓
Admin replies: "1" (confirmed) / "2" (wait, still pending) / "3" (rejected)
↓
Bot sends customer: "Payment confirmed! Shipping in 24 hours ✅"
```

### 3. **Status Post Scheduler**
Schedule product photos to post automatically to WhatsApp Status.

**Features:**
- Set specific days (Mon-Sun) and times
- Auto-post product images
- Funny Nigerian business memes every Sunday
- Countdown to sales events

### 4. **Voice Transcription**
Nigerian customers often send voice notes in local languages (Yoruba, Igbo, Hausa, Pidgin).

**How It Works:**
```
Customer sends 🎙️ voice note in Yoruba
↓
Bot transcribes: "What's the price of that blouse?"
↓
Bot understands + replies in English
```

### 5. **Human Handoff Detection**
Bot detects when customer needs a real person → pauses and alerts you immediately.

**Example:**
```
Customer: "Can you do custom orders?"
Bot recognizes: "This needs a human"
Bot: "Hold on, connecting you with my boss..."
Admin: 📱 "Custom request from Zainab - respond now"
```

### 6. **Admin Dashboard**
Complete control panel for managing all clients.

**Dashboard Sections:**
- **Clients** — List all active/paused clients, bot status, payment status
- **Payments** — Track setup fees, subscriptions, renewal dates
- **Broadcasts** — Send bulk messages to customers on behalf of a client
- **Stats** — Total clients, active bots, revenue

---

## 📁 Project Structure

```
whatsapp_automation/
├── README.md                        # This file
├── package.json                     # Node.js dependencies
├── index.js                         # Main server (Express)
├── .env.example                     # Environment variables template
├── public/
│   └── index.html                   # Landing page & signup (HTML/CSS/JS)
├── src/
│   ├── admin/
│   │   ├── public/
│   │   │   └── index.html          # Admin dashboard (full UI)
│   │   └── routes.js               # Admin API endpoints
│   ├── bot/
│   │   ├── instance.js             # Baileys WhatsApp client
│   │   ├── message-handler.js      # Message processing logic
│   │   └── scheduler.js            # Status post scheduler
│   ├── client/
│   │   └── routes.js               # Client API endpoints
│   ├── auth/
│   │   └── jwt.js                  # Authentication middleware
│   ├── db/
│   │   └── queries.js              # Supabase database operations
│   └── payments/
│       ├── flutterwave.js          # Nigerian payment gateway
│       └── stripe.js               # International payment gateway
└── db/
    └── schema.sql                  # PostgreSQL schema
```

**Language Composition:**
- **HTML:** 53.3% (Landing page + Admin dashboard UI)
- **JavaScript:** 45.7% (Backend + Frontend logic)
- **PLpgSQL:** 1% (Database triggers & functions)

---

## 🚀 Getting Started

### Prerequisites
- **Node.js** 18+ 
- **PostgreSQL** (via Supabase)
- **Flutterwave** account (African payments)
- **Stripe** account (International payments)
- **WhatsApp Business Account** (optional, but recommended)
- **Google Cloud API** (for voice transcription)

### Quick Setup

**1. Clone repository:**
```bash
git clone https://github.com/kene-favs/whatsapp_automation.git
cd whatsapp_automation
```

**2. Install dependencies:**
```bash
npm install
```

**3. Create `.env` file:**
```env
# Server
PORT=3000
NODE_ENV=production

# Database
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_KEY=your-anon-key
SUPABASE_SERVICE_KEY=your-service-key

# Payments
FLUTTERWAVE_SECRET_KEY=your-flutterwave-key
FLUTTERWAVE_PUBLIC_KEY=your-flutterwave-public-key
STRIPE_SECRET_KEY=sk_live_...
STRIPE_PUBLISHABLE_KEY=pk_live_...

# JWT
JWT_SECRET=your-super-secret-jwt-key

# Google Cloud (Voice transcription)
GOOGLE_CLOUD_API_KEY=your-google-cloud-key

# WhatsApp / Baileys
SESSION_DIR=./sessions

# Admin
ADMIN_EMAIL=admin@forgebot.com
ADMIN_PASSWORD=admin-password-hash
```

**4. Start server:**
```bash
npm start
```

Server runs on `http://localhost:3000`

**5. Visit in browser:**
- 🏠 **Landing page:** `http://localhost:3000/`
- 🔐 **Admin panel:** `http://localhost:3000/admin`

---

## 📊 How It Works

### Client Signup Flow

```
┌─────────────────────────────────────────────────────────────────┐
│  Step 1: Fill Business Details                                 │
├─────────────────────────────────────────────────────────────────┤
│  • Full Name, Business Name, WhatsApp Number                    │
│  • Business Type (Fashion, Food, Salon, etc.)                   │
│  • Bank Details (for auto-reply payment info)                   │
│  • Email & Password                                             │
└─────────────────────────────────────────────────────────────────┘
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  Step 2: Choose Payment Method                                 │
├─────────────────────────────────────────────────────────────────┤
│  Nigeria:  ₦30,000 setup + ₦10,000/month (Flutterwave)        │
│  Intl:     $45 setup + $10/month (Stripe)                      │
└─────────────────────────────────────────────────────────────────┘
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  Step 3: Payment Processing                                    │
├─────────────────────────────────────────────────────────────────┤
│  • User redirected to Flutterwave/Stripe                        │
│  • Payment confirmed → Account created                          │
│  • Email sent with login credentials                            │
└─────────────────────────────────────────────────────────────────┘
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  Step 4: QR Code Connection                                    │
├─────────────────────────────────────────────────────────────────┤
│  • Client logs in to dashboard                                  │
│  • QR code generated (valid 60 seconds)                         │
│  • Client scans with WhatsApp phone                             │
│  • Bot goes LIVE (WhatsApp status shows "connected")            │
└─────────────────────────────────────────────────────────────────┘
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  Step 5: Set Up Auto-Replies                                   │
├─────────────────────────────────────────────────────────────────┤
│  • Client adds keywords + replies in dashboard                  │
│  • Example: Keyword "price" → Auto-reply "Our items start..."   │
│  • Bot now handles incoming customer messages 24/7              │
└─────────────────────────────────────────────────────────────────┘
```

### Message Processing Flow

```
Customer sends WhatsApp message
                ▼
Bot receives via Baileys
                ▼
Extract message text + sender
                ▼
┌─── Check if text contains keyword? ────┐
│                                        │
YES                                      NO
│                                        │
▼                                        ▼
Match against                    Is it a payment claim?
stored keywords                  ("I've paid", "I sent")
│                                        │
│                                      YES
│                                        │
│                                        ▼
│                                   Alert admin
│                                   Pause auto-reply
│                                   Wait for manual response
│                                        │
▼                                        ▼
Send auto-reply                   Check if needs human?
configured by client              (complex, angry tone, links)
│                                        │
│                                      YES
│                                        │
│                                        ▼
│                                   "Connecting to agent..."
│                                   Alert admin immediately
│                                        │
▼                                        ▼
Save chat to                      Manual response mode
database for                      Admin replies → sent to customer
analytics
```

---

## 💰 Pricing Model

**Simple One-Time + Monthly Structure:**

| **Plan** | **Region** | **Setup Fee** | **Monthly** | **Features** |
|---------|-----------|--------------|-----------|------------|
| **Starter** | Nigeria | ₦30,000 | ₦10,000 | All features |
| **Starter** | Intl | $45 | $10 | All features |

**What's Included:**
✅ 24/7 auto-replies (unlimited keywords)  
✅ Payment alert system  
✅ Status scheduler  
✅ Voice transcription (Nigerian languages)  
✅ Human handoff detection  
✅ Admin dashboard access  
✅ Email support  
✅ Automatic message backups  

**Subscriptions:**
- Auto-renews monthly via stored card
- Can cancel anytime
- 7-day free trial (option)
- Family/bulk discounts available

---

## 🔐 Security Features

- **Encrypted Passwords** — bcryptjs hashing
- **JWT Authentication** — Stateless session tokens
- **Message Encryption** — Baileys encrypts WhatsApp messages
- **Admin Authentication** — Email + password for admin dashboard
- **API Key Rotation** — Rotate Flutterwave/Stripe keys monthly
- **Database Backups** — Supabase handles daily backups
- **Rate Limiting** — Prevent abuse of signup/login endpoints
- **HTTPS Only** — Production enforces encrypted connections

---

## 🌐 Tech Stack

**Backend:**
- **Node.js + Express** — REST API server
- **@whiskeysockets/baileys** — WhatsApp API (no emulator needed)
- **Supabase (PostgreSQL)** — Database for clients, flows, messages
- **Jsonwebtoken** — Auth tokens
- **bcryptjs** — Password hashing
- **node-cron** — Schedule status posts
- **Puppeteer** — Voice transcription automation
- **Pino** — Logging

**Frontend:**
- **Vanilla HTML/CSS/JS** — Landing page (no build tools)
- **Fetch API** — Client-side requests
- **Modal/Form handling** — Sign up & login flows

**Payments:**
- **Flutterwave** — Nigerian payments (cards, bank transfers, USSD)
- **Stripe** — International payments

**Hosting:**
- **Render.com** or **Railway.app** (Node.js)
- **Supabase** (PostgreSQL database)
- **Cloudflare** (DNS + DDoS protection)

---

## 📊 Admin Dashboard

### Clients Page
- View all clients (connected, paused, inactive)
- Filter by status, payment status, country
- Click "View" to see client details
- Quick actions: Connect, Disconnect, Activate, Pause

### Payments Page
- Overview of all subscription revenue
- Setup payment status (paid/pending)
- Subscription active/inactive
- Renewal dates
- Export for accounting

### Broadcasts Page
- Select a connected client
- Type message
- Enter phone numbers
- Send bulk message on behalf of client

### Stats
- Total clients
- Active bots
- Revenue (monthly recurring)
- Churned clients

---

## 🔄 Database Schema (Simplified)

```sql
-- Clients table
CREATE TABLE clients (
  id UUID PRIMARY KEY,
  email VARCHAR UNIQUE,
  password_hash VARCHAR,
  full_name VARCHAR,
  business_name VARCHAR,
  whatsapp_number VARCHAR,
  notification_number VARCHAR,
  bank_name VARCHAR,
  account_number VARCHAR,
  status VARCHAR ('active', 'paused', 'cancelled'),
  whatsapp_status VARCHAR ('connected', 'connecting', 'offline'),
  setup_paid BOOLEAN,
  subscription_active BOOLEAN,
  created_at TIMESTAMP
);

-- Auto-reply flows
CREATE TABLE flows (
  id UUID PRIMARY KEY,
  client_id UUID REFERENCES clients(id),
  flow_name VARCHAR,
  keywords TEXT[], -- array of keywords
  reply_message TEXT,
  active BOOLEAN
);

-- Status posts
CREATE TABLE status_posts (
  id UUID PRIMARY KEY,
  client_id UUID REFERENCES clients(id),
  caption TEXT,
  image_url TEXT,
  post_time TIME,
  days_of_week INT[], -- 0=Sunday, 1=Monday, etc.
  active BOOLEAN
);

-- Chat history
CREATE TABLE messages (
  id UUID PRIMARY KEY,
  client_id UUID REFERENCES clients(id),
  from_number VARCHAR,
  message_text TEXT,
  was_auto_reply BOOLEAN,
  created_at TIMESTAMP
);
```

---

## 🛠️ Deployment on VPS

**Quick Deploy Steps:**

1. **Rent VPS** (Heroku, Render, Railway)
2. **Connect GitHub repo** to hosting platform
3. **Set environment variables** in dashboard
4. **Deploy** — platform auto-runs `npm start`
5. **Monitor** — Check logs for errors
6. **Test** — Visit `https://yourdomain.com`

---

## 📱 WhatsApp Bot Features in Detail

### Auto-Reply Examples

**Price Inquiry:**
```
Customer: "How much?"
Bot: "Hello! Our prices start at ₦5,000. Which product interests you? 
      See our catalog: [image] [link to shop]"
```

**Availability Check:**
```
Customer: "Do you have the blue shoe in size 40?"
Bot: "Yes! We have all sizes in stock. 
      How many would you like? 
      Bank details for payment: [account info]"
```

**Delivery Information:**
```
Customer: "How long for delivery?"
Bot: "Lagos & Abuja: 24–48 hours
      Other states: 3–5 days
      Your order ships TODAY if paid before 2 PM ⏰"
```

### Status Post Examples

**Product Showcase:**
- Mon/Wed/Fri @ 10 AM: New arrivals
- Tue/Thu @ 6 PM: Customer testimonials (images)
- Sat @ 9 PM: Weekend sale countdown

**Meme Schedule:**
- Every Sunday @ 7 PM: Nigerian business meme (auto)
  
Example: "When customer says 'I'll come back tomorrow' but you never see them again" 😂

### Voice Transcription

**Supported Languages:**
- 🇳🇬 Yoruba, Igbo, Hausa
- 🇬🇭 Twi, Ga
- 🇰🇪 Swahili
- 🌍 Pidgin English

**Example:**
```
Customer sends 🎙️ voice note (Igbo): "Kedu obere akwa a?"
Bot transcribes: "What's the price of that cloth?"
Bot replies: "That cloth is ₦8,500. Very good quality! 
             Do you want it? ✨"
```

---

## 🚨 Common Use Cases

### Fashion/E-commerce Business
**Problem:** Lose sales because you're sleeping when customers ask about prices  
**Solution:** ForgeBot replies instantly → +40% response rate → +25% sales

### Salon/Beauty Business
**Problem:** Phone calls non-stop, miss bookings  
**Solution:** Bot books appointments → Admin confirms → Customer gets reminder

### Food Business
**Problem:** Forget to post new menu items  
**Solution:** Auto-schedule menu photos → Post daily @ noon → Repeat weekly

### Shipping/Logistics
**Problem:** 100 "where's my order?" messages/day  
**Solution:** Bot replies with tracking link → Customer checks status → No support ticket

---

## 📞 Support & Troubleshooting

| Issue | Fix |
|-------|-----|
| QR code won't scan | Try again, code expires in 60 seconds |
| Bot went offline | WhatsApp kicked the session, disconnect & reconnect |
| Payment failed | Check internet, retry with Flutterwave/Stripe |
| Auto-reply not working | Check keywords are exactly spelled in flows |
| Admin can't see clients | Verify admin email/password in database |
| Transcription fails | Ensure Google Cloud API key has speech-to-text enabled |

---

## 🤝 Contributing

To add features:
1. Create new branch (`git checkout -b feature/my-feature`)
2. Make changes
3. Test locally (`npm run dev`)
4. Submit PR with description

**Ideas for contributions:**
- [ ] AI-powered response suggestions
- [ ] Facebook Messenger integration
- [ ] Telegram bot integration
- [ ] Inventory management sync
- [ ] Customer CRM panel

---

## 📄 License & Credits

**Built by:** [@kene-favs](https://github.com/kene-favs)  
**Company:** TheFavsForge  
**Version:** 2.0.0  
**Status:** Production-ready  
**Last Updated:** August 2026

**Special Thanks:**
- Baileys project (WhatsApp API)
- Supabase (PostgreSQL)
- Flutterwave (African payments)

---

## 🎯 Roadmap

**Q4 2026:**
- [ ] WhatsApp Business API official integration
- [ ] AI chatbot mode (GPT-powered responses)
- [ ] Multi-language support (translations)
- [ ] Customer sentiment analysis
- [ ] Affiliate program for resellers

**Q1 2027:**
- [ ] Mobile app (iOS/Android)
- [ ] SMS fallback option
- [ ] Facebook Messenger + Instagram DM sync
- [ ] Inventory management dashboard

---

```
╔═══════════════════════════════════════════════════════════╗
║                                                           ║
║        ForgeBot — Your WhatsApp Works While You Sleep    ║
║                                                           ║
║        Stop losing customers. Start making sales.        ║
║                                                           ║
║  🚀 Join 1000+ African businesses automating sales       ║
║  💬 24/7 Customer replies without lifting a finger        ║
║  💰 Simple pricing, unlimited replies                     ║
║                                                           ║
║       Start free trial: https://forgebot.app             ║
║                                                           ║
╚═══════════════════════════════════════════════════════════╝
```
