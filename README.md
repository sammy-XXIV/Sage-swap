# SAGE — AI DeFi Agent for STON.fi

> Your intelligent DeFi co-pilot on TON blockchain. Swap, stake, farm, and set limit orders — all through natural conversation.

![SAGE](https://sammy-xxiv.github.io/sage-app)

## 🔗 Live Demo
**[sammy-xxiv.github.io/sage-app](https://sammy-xxiv.github.io/sage-app)**

---

## What is SAGE?

SAGE is a Telegram Mini App AI agent built on top of STON.fi. Instead of navigating complex DeFi interfaces, users simply talk to SAGE in plain English and it executes on-chain actions automatically.

**"Swap 0.1 TON to NOT"** → SAGE simulates, builds the transaction, and opens your wallet for signing.

**"Buy $0.20 TON with USDT when TON hits $1.20"** → SAGE creates a limit order, generates a dedicated agentic wallet, monitors the price, and executes automatically when the price is hit — while you sleep.

---

## ✨ Features

### 🔄 Instant Swaps
- Any token pair on STON.fi (TON, USDT, NOT, STON, DOGS, any jetton)
- Real-time price simulation via STON.fi SDK
- Slippage protection with auto-retry
- Number formatting (25M, 1.2K etc)

### 📋 Autonomous Limit Orders
- Set buy/sell triggers at target prices
- Per-user agentic wallets generated and encrypted server-side
- Price monitoring every 30 seconds via Render backend
- Auto-executes swap when price hits target
- Automatically sends proceeds back to user's main wallet
- Works while you're offline or asleep

### 🔒 Dual Staking
- **TON Stakers** — liquid stake TON → receive tsTON (~5% APY, no lock-up)
- **STON.fi STON Staking** — lock STON → earn GEMSTON + ARKENSTON NFT
- Side-by-side comparison card with APY, risk, and lock-up info

### 💧 Liquidity & Farming
- Add liquidity to any STON.fi pool
- Stake LP tokens in farms directly from the agent
- Yield calculator on all APR cards (7d / 30d / 90d / 1yr projections)

### 📊 Portfolio Intelligence
- Real-time wallet data (TON + all jettons)
- DeFi positions (LP, farms, staking)
- Personalized yield recommendations based on actual holdings
- Recent swap history

### 📈 Live Market Data
- Real-time price ticker (TON, NOT, DOGS, STON, USDT)
- Price alerts via AI conversation

---

## 🏗️ Architecture

```
User (Telegram Mini App)
    ↓
SAGE HTML/JS (GitHub Pages)
    ↓                    ↓
Cloudflare Worker        Render Node.js Backend
(Claude AI proxy,        (STON.fi SDK swaps,
 wallet data)            limit orders, staking)
    ↓                    ↓
Anthropic Claude API     STON.fi Protocol
                         TON Stakers SDK
                         Supabase (order storage)
```

### Tech Stack
- **Frontend**: Single-file HTML/JS, deployed on GitHub Pages
- **AI**: Claude Sonnet via Anthropic API (Cloudflare Worker proxy)
- **Swap Engine**: Node.js + `@ston-fi/sdk` on Render
- **Liquid Staking**: `tonstakers-sdk`
- **Order Storage**: Supabase (PostgreSQL)
- **Wallet**: TON Connect 2.0
- **Price Data**: STON.fi API + CoinGecko

---

## 🚀 How It Works

### Swap Flow
1. User: *"Swap 0.1 TON to NOT"*
2. SAGE simulates via STON.fi API
3. Render builds tx using `@ston-fi/sdk`
4. TON Connect opens for user signature
5. Transaction executes on-chain

### Limit Order Flow
1. User: *"Buy $0.20 TON with USDT when TON hits $1.20"*
2. SAGE shows limit order card with details
3. User taps "Fund & Place Order"
4. A dedicated encrypted agentic wallet is created for the user
5. User sends USDT to their agent wallet
6. Render monitors price every 30 seconds
7. When TON drops to $1.20 → agent wallet auto-swaps
8. TON is sent back to user's main wallet automatically

### TON Stakers Integration
1. User: *"Stake 1 TON"*
2. SAGE shows comparison: TON Stakers vs STON.fi Farm
3. User selects TON Stakers
4. `tonstakers-sdk` builds stake transaction
5. User receives tsTON — liquid, tradeable, earning ~5% APY

---

## 📦 Repositories

| Repo | Purpose |
|------|---------|
| `sage-app` | Frontend HTML + GitHub Pages deployment |
| `sage-swap` | Node.js backend on Render |

---

## 🔧 Environment Variables (Render)

| Variable | Description |
|----------|-------------|
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_KEY` | Supabase anon key |
| `ENCRYPTION_KEY` | 32-char key for encrypting agent wallet mnemonics |

---

## 🗄️ Database Schema (Supabase)

```sql
-- Agent wallets (one per user)
create table agent_wallets (
  id uuid default gen_random_uuid() primary key,
  user_wallet text unique,
  agent_address text,
  encrypted_mnemonic text,
  created_at timestamptz
);

-- Limit orders
create table limit_orders (
  id uuid default gen_random_uuid() primary key,
  user_wallet text,
  agent_wallet text,
  token_in text,
  token_out text,
  token_in_symbol text,
  token_out_symbol text,
  amount float,
  target_price float,
  direction text,
  status text default 'pending',
  created_at timestamptz,
  filled_at timestamptz,
  filled_price float
);
```

---

## 🏆 Hackathon Tracks

- **Main Track** — STON.fi Vibe Coding Hackathon
- **Tonstakers Track** — TON liquid staking integration

---

## 👤 Built by SAMMY

Made with Claude AI + STON.fi SDK + TON Connect

*SAGE — Sharp, Autonomous, Generative, Expert*

