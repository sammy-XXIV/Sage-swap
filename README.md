# SAGE — WhatsApp DeFi Agent on TON

> Your autonomous DeFi agent, right in WhatsApp. Swap, stake, withdraw, and track your portfolio on STON.fi — all through plain conversation.

---

## What is SAGE?

SAGE is a WhatsApp bot powered by Claude AI that gives you full DeFi access on the TON blockchain without leaving your chat. It holds a custodial wallet for each user, executes real on-chain transactions, and alerts you when funds arrive.

**"Swap 0.5 TON to NOT"** → SAGE quotes, confirms, executes, and sends a transaction receipt card.

**"Withdraw 1 TON to EQabc..."** → SAGE confirms the address, sends, and follows up with the tx hash and Tonviewer link.

**"What's the best way to earn with my holdings?"** → SAGE reads your portfolio and gives a direct recommendation.

---

## Features

### Swaps
- Any token pair on STON.fi via the Omniston RFQ SDK
- Quote first, confirm, then execute — never skips a step
- Progress bar edits in-place as the swap processes
- Transaction receipt card sent on success (token symbols, rate, timestamp)
- Friendly error messages for low liquidity, insufficient gas, and failed quotes

### Withdrawals
- Send TON or any jetton to an external address
- Confirmation step with truncated destination address
- Receipt card sent instantly after transfer
- Tx hash + Tonviewer link sent as a follow-up once indexed on-chain

### Staking
- Stake TON via TON Stakers for ~5.2% APY
- Executes directly from the SAGE wallet

### Limit Orders
- Set auto-buy or auto-sell triggers at a target price
- Price monitored every 30 seconds
- Auto-executes and returns proceeds when price hits target

### Portfolio Analysis
- Check balance (TON + all jettons with USD values)
- Ask SAGE to analyse your portfolio and it gives a direct action plan per holding
- Recent transaction history with tx hashes

### Price & Market Data
- Live token prices, 24h change, volume, TVL, liquidity via GeckoTerminal
- Price charts for any timeframe (1h, 4h, 1d, 1w, 1m) sent as images
- Trending tokens on STON.fi by volume
- Token safety analysis — liquidity, pool age, price volatility, scam signals
- Real crypto market opinions when you ask "what should I buy?"

### Incoming Transfer Alerts
- SAGE monitors your wallet every 30 seconds
- Instant WhatsApp alert when TON or any jetton arrives

### Wallet Management
- Custodial wallet generated per user, encrypted at rest
- Seed phrase viewable within 24 hours of creation
- Import existing wallet via 24-word seed phrase

---

## Architecture

```
User (WhatsApp)
      ↓
Baileys (WA Linked Device)
      ↓
Node.js Server (Railway)
      ↓              ↓               ↓
Claude Haiku    STON.fi SDK      TONAPI / GeckoTerminal
(AI reasoning   (swaps, limit    (balances, transactions,
 + tool use)     orders, staking) price data, events)
      ↓
Supabase
(session auth, wallets, limit orders)
```

### Tech Stack

| Layer | Technology |
|-------|-----------|
| WhatsApp | Baileys `@whiskeysockets/baileys` v6 |
| AI | Claude Haiku 4.5 via Anthropic API |
| Swap Engine | `@ston-fi/sdk` + Omniston RFQ SDK |
| Blockchain | `@ton/ton` — WalletContractV4 |
| Price Data | GeckoTerminal API + STON.fi API |
| Charts | QuickChart.io (Chart.js rendered as PNG) |
| Storage | Supabase (PostgreSQL) |
| Deployment | Railway (single replica, persistent session) |

---

## How It Works

### Session Persistence
SAGE uses a Baileys linked device session stored in Supabase. On deploy, it waits 35 seconds after the health check passes before connecting to WhatsApp — this prevents Railway's rolling restarts from triggering a re-scan. On shutdown, it releases the Supabase lock without closing the WebSocket so the session stays valid.

### Swap Flow
1. User: *"Swap 0.5 TON to NOT"*
2. SAGE calls `lookup_token` to resolve NOT → contract address
3. Calls `get_swap_quote` → shows rate and expected output
4. User confirms → `execute_swap` runs via Omniston SDK
5. Transaction receipt card sent via QuickChart

### Withdrawal Flow
1. User: *"Send 2 TON to EQabc..."*
2. SAGE confirms: *"Send 2 TON to EQabc...xyz. Confirm?"*
3. User confirms → transfer sent via `@ton/ton` internal message
4. Receipt card sent immediately
5. Background process polls TONAPI for the tx hash, sends follow-up with Tonviewer link

### Incoming Transfer Monitor
- On first message after boot, user wallet is registered in memory
- `setInterval` polls TONAPI events every 30 seconds per registered wallet
- New `TonTransfer` or `JettonTransfer` events trigger a WhatsApp alert

---

## Environment Variables

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | Claude API key |
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_KEY` | Supabase anon key |
| `ENCRYPTION_KEY` | 32-char key for encrypting wallet mnemonics |
| `TON_RPC_URL` | TON RPC endpoint (defaults to toncenter.com) |
| `TONCENTER_API_KEY` | Toncenter API key (optional, for higher rate limits) |
| `PORT` | HTTP port (Railway sets this automatically) |

---

## Database Schema

```sql
-- One custodial wallet per WhatsApp user
create table agent_wallets (
  id uuid default gen_random_uuid() primary key,
  user_wallet text unique,       -- "wa:{jid}"
  agent_address text,            -- TON wallet address
  encrypted_mnemonic text,       -- AES-256 encrypted 24-word seed
  created_at timestamptz default now()
);

-- Limit orders (auto-executed by background job)
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
  direction text,                -- "buy" or "sell"
  status text default 'pending', -- pending / filled / cancelled
  created_at timestamptz default now(),
  filled_at timestamptz,
  filled_price float
);

-- WhatsApp session state
create table whatsapp_auth (
  key text primary key,
  value text,
  updated_at timestamptz default now()
);
```

---

## Deployment (Railway)

```toml
# railway.toml
[deploy]
healthcheckPath = "/ping"
healthcheckTimeout = 30
restartPolicyType = "ON_FAILURE"
numReplicas = 1
```

Single replica is required — multiple instances would conflict over the WhatsApp session lock.

---

## Example Conversations

```
You: swap $2 worth of TON to NOT
SAGE: Swap 1.32 TON → 4,821 NOT at rate 1 TON = 3,652 NOT. Confirm?
You: yes
SAGE: [sends transaction receipt card]
SAGE: Tx: a1b2c3d4...e5f6g7h8  https://tonviewer.com/transaction/...

You: show me NOT 4h chart
SAGE: [sends price chart image]
      📊 NOT · 4H · ▼ 2.14%

You: analyse my portfolio and tell me how to earn
SAGE: You've got 1.2 TON ($1.84) and 4,800 NOT ($0.62).
      TON is sitting idle — stake it for 5.2% APY, that's ~$0.10/year on this amount.
      NOT is small — either hold for upside or swap into TON to consolidate.
      Recommended: stake your TON now. Want me to do it?

You: withdraw 1 TON to EQDxxx...
SAGE: Send 1 TON to EQDxxx...abc. Confirm?
You: yes
SAGE: [sends withdrawal receipt card]
SAGE: Tx: f8e7d6c5...b4a3  https://tonviewer.com/transaction/...
```

---

## Built by Samson Samuel

SAGE — Sharp, Autonomous, Generative, Expert
