import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import { renderAsync } from '@resvg/resvg-js';
import { readFileSync } from 'fs';
import makeWASocket, { DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion, initAuthCreds, BufferJSON, proto } from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import Pino from 'pino';
import Anthropic from '@anthropic-ai/sdk';
import { mnemonicToPrivateKey, mnemonicNew, mnemonicValidate } from '@ton/crypto';
import { WalletContractV4, internal } from '@ton/ton';
import { createClient } from '@supabase/supabase-js';
import { DEX, pTON, FARM, Client } from '@ston-fi/sdk';
import { StonApiClient } from '@ston-fi/api';
import { Omniston, isSwapQuote } from '@ston-fi/omniston-sdk';
import { Cell } from '@ton/ton';

const app = express();
app.use(cors());
app.use(express.json());

const apiClient = new StonApiClient();
const tonClient = new Client({ endpoint: process.env.TON_RPC_URL || 'https://toncenter.com/api/v2/jsonRPC', apiKey: process.env.TONCENTER_API_KEY || '' });
const ROBOTO_FONT = readFileSync(new URL('./fonts/Roboto.ttf', import.meta.url));
const supabase = createClient(process.env.SUPABASE_URL||'', process.env.SUPABASE_KEY||'');
const TON_NATIVE = 'EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c';
const omniston = new Omniston({ apiUrl: 'wss://omni-ws.ston.fi' });

// Build Omniston AssetId for TON native or jetton address
const makeAssetId = (addr) => addr === TON_NATIVE
  ? { chain: { $case: 'ton', value: { kind: { $case: 'native', value: {} } } } }
  : { chain: { $case: 'ton', value: { kind: { $case: 'jetton', value: addr } } } };

// Get a quote from Omniston with 15s timeout
async function getOmnistonQuote(fromAddr, toAddr, offerUnits) {
  const quoteRequest = {
    inputAsset: makeAssetId(fromAddr),
    outputAsset: makeAssetId(toAddr),
    amount: { $case: 'inputUnits', value: String(offerUnits) },
    settlementParams: [{
      params: { $case: 'swap', value: { maxPriceSlippagePips: 10_000 } },
    }],
  };
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { sub.unsubscribe(); reject(new Error('No quote received — no liquidity or timeout')); }, 15000);
    const sub = omniston.requestForQuote(quoteRequest).subscribe({
      next(event) {
        if (event?.$case === 'quoteUpdated') {
          clearTimeout(timeout); sub.unsubscribe(); resolve(event.value);
        } else if (event?.$case === 'noQuote') {
          clearTimeout(timeout); sub.unsubscribe(); reject(new Error('No liquidity available via Omniston'));
        }
      },
      error(err) { clearTimeout(timeout); reject(err); },
    });
  });
}

// ── Transaction Card Generator ────────────────────────────────────────────────
function fmtAmount(n) {
  if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(2) + 'B';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(2) + 'K';
  return Number(n).toFixed(n < 0.01 ? 6 : 4).replace(/\.?0+$/, '');
}

async function generateTxCard({ fromAmount, fromToken, toAmount, toToken, type = 'SWAP' }) {
  const from = `${fmtAmount(fromAmount)} ${(fromToken || '').replace(/^\$/, '').toUpperCase()}`;
  const to   = `${fmtAmount(toAmount)}   ${(toToken   || '').replace(/^\$/, '').toUpperCase()}`;
  const time = new Date().toUTCString().replace(' GMT', ' UTC');
  const rate = fromAmount > 0 ? `1 ${(fromToken||'').replace(/^\$/,'').toUpperCase()} = ${fmtAmount(toAmount/fromAmount)} ${(toToken||'').replace(/^\$/,'').toUpperCase()}` : '';

  // Escape XML special chars
  const x = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

  const svg = `<svg width="620" height="370" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bgGrad" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#060D1F"/>
      <stop offset="100%" stop-color="#0C1A35"/>
    </linearGradient>
    <linearGradient id="blueBar" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#00C2FF"/>
      <stop offset="100%" stop-color="#0055FF"/>
    </linearGradient>
    <linearGradient id="glowLine" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#00C2FF" stop-opacity="0"/>
      <stop offset="50%" stop-color="#00C2FF" stop-opacity="0.6"/>
      <stop offset="100%" stop-color="#00C2FF" stop-opacity="0"/>
    </linearGradient>
  </defs>

  <!-- Card background -->
  <rect width="620" height="370" rx="18" fill="url(#bgGrad)"/>

  <!-- Top accent bar -->
  <rect width="620" height="5" rx="3" fill="url(#blueBar)"/>

  <!-- Left accent stripe -->
  <rect x="0" y="5" width="4" height="360" rx="2" fill="url(#blueBar)"/>

  <!-- SAGE branding -->
  <text x="34" y="46" font-family="Roboto" font-size="22" font-weight="bold" fill="#00C2FF">SAGE</text>
  <text x="34" y="64" font-family="Roboto" font-size="11" fill="#1E3A60" letter-spacing="2">STON.fi AGENT</text>
  <text x="600" y="50" font-family="Roboto" font-size="12" fill="#1A3050" text-anchor="end">${x(type)}</text>

  <!-- Glowing separator -->
  <rect x="20" y="76" width="580" height="1" fill="url(#glowLine)"/>

  <!-- Checkmark circle -->
  <circle cx="310" cy="118" r="24" fill="none" stroke="#00E676" stroke-width="2.5"/>
  <path d="M298 118 L307 127 L323 109" fill="none" stroke="#00E676" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"/>

  <!-- APPROVED label -->
  <text x="310" y="158" font-family="Roboto" font-size="13" font-weight="bold" fill="#00E676" text-anchor="middle" letter-spacing="3">TRANSACTION APPROVED</text>

  <!-- Separator -->
  <rect x="20" y="172" width="580" height="1" fill="#0F2040"/>

  <!-- FROM label -->
  <text x="155" y="200" font-family="Roboto" font-size="10" fill="#2A5070" text-anchor="middle" letter-spacing="2">FROM</text>
  <!-- TO label -->
  <text x="465" y="200" font-family="Roboto" font-size="10" fill="#2A5070" text-anchor="middle" letter-spacing="2">TO</text>

  <!-- Arrow -->
  <line x1="258" y1="212" x2="355" y2="212" stroke="#00C2FF" stroke-width="1.5"/>
  <path d="M348 206 L356 212 L348 218" fill="none" stroke="#00C2FF" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>

  <!-- Amounts -->
  <text x="155" y="224" font-family="Roboto" font-size="20" font-weight="bold" fill="#FFFFFF" text-anchor="middle">${x(from)}</text>
  <text x="465" y="224" font-family="Roboto" font-size="20" font-weight="bold" fill="#FFFFFF" text-anchor="middle">${x(to)}</text>

  <!-- Separator -->
  <rect x="20" y="244" width="580" height="1" fill="#0F2040"/>

  <!-- Detail rows -->
  <text x="34" y="270" font-family="Roboto" font-size="12" fill="#2A5070">Rate</text>
  <text x="590" y="270" font-family="Roboto" font-size="12" fill="#6A90B8" text-anchor="end">${x(rate)}</text>

  <text x="34" y="295" font-family="Roboto" font-size="12" fill="#2A5070">Network</text>
  <text x="590" y="295" font-family="Roboto" font-size="12" fill="#6A90B8" text-anchor="end">STON.fi</text>

  <text x="34" y="320" font-family="Roboto" font-size="12" fill="#2A5070">Time</text>
  <text x="590" y="320" font-family="Roboto" font-size="12" fill="#6A90B8" text-anchor="end">${x(time)}</text>

  <!-- Bottom separator -->
  <rect x="20" y="338" width="580" height="1" fill="#0A1828"/>

  <!-- Footer -->
  <text x="310" y="358" font-family="Roboto" font-size="10" fill="#142030" text-anchor="middle" letter-spacing="1">SAGE · BUILT ON STON.fi</text>
</svg>`;

  const resvg = await renderAsync(svg, { font: { loadSystemFonts: false, fontBuffers: [ROBOTO_FONT] } });
  return Buffer.from(resvg.asPng());
}

// Asset cache — STON.fi search API is broken, so we cache top assets and filter client-side
let assetCache = null;
let assetCacheTime = 0;
const ASSET_CACHE_TTL = 5 * 60 * 1000; // 5 min

async function getAssets() {
  if (assetCache && Date.now() - assetCacheTime < ASSET_CACHE_TTL) return assetCache;
  const res = await fetch('https://api.ston.fi/v1/assets?limit=500');
  const data = await res.json();
  assetCache = (data.asset_list || []).filter(a => !a.blacklisted && a.dex_usd_price);
  assetCacheTime = Date.now();
  return assetCache;
}

async function findAssetBySymbol(symbol) {
  const upper = symbol.toUpperCase();
  const assets = await getAssets();
  const matches = assets.filter(a => a.symbol?.toUpperCase() === upper);
  if (!matches.length) return null;
  // Pick most popular (highest popularity_index = most liquid/real token)
  return matches.sort((a, b) => (b.popularity_index || 0) - (a.popularity_index || 0))[0];
}

// ── Encryption ────────────────────────────────────────────
function encrypt(text) {
  const iv = crypto.randomBytes(16);
  const key = crypto.scryptSync(process.env.ENCRYPTION_KEY||'sage-default-32-char-key-padded!', 'salt', 32);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  return iv.toString('hex')+':'+Buffer.concat([cipher.update(text),cipher.final()]).toString('hex');
}
function decrypt(text) {
  const [ivHex,encHex] = text.split(':');
  const key = crypto.scryptSync(process.env.ENCRYPTION_KEY||'sage-default-32-char-key-padded!', 'salt', 32);
  const decipher = crypto.createDecipheriv('aes-256-cbc', key, Buffer.from(ivHex,'hex'));
  return Buffer.concat([decipher.update(Buffer.from(encHex,'hex')),decipher.final()]).toString();
}

// ── Per-user agent wallet ────────────────────────────────
async function getUserWallet(userWallet) {
  const { data: existing } = await supabase.from('agent_wallets').select('*').eq('user_wallet',userWallet).single();
  let mnemonic;
  if(existing) {
    mnemonic = decrypt(existing.encrypted_mnemonic).split(' ');
  } else {
    mnemonic = await mnemonicNew(24);
    const kp = await mnemonicToPrivateKey(mnemonic);
    const w = WalletContractV4.create({ workchain:0, publicKey:kp.publicKey });
    const addr = w.address.toString({ bounceable:false, urlSafe:true });
    await supabase.from('agent_wallets').insert({
      user_wallet: userWallet, agent_address: addr,
      encrypted_mnemonic: encrypt(mnemonic.join(' ')),
      created_at: new Date().toISOString(),
    });
  }
  const keyPair = await mnemonicToPrivateKey(mnemonic);
  const wallet = WalletContractV4.create({ workchain:0, publicKey:keyPair.publicKey });
  const contract = tonClient.open(wallet);
  const address = wallet.address.toString({ bounceable:false, urlSafe:true });
  return { wallet, contract, keyPair, address };
}

// ── Health ────────────────────────────────────────────────
app.get('/ping', (req,res) => res.json({ ok:true, service:'SAGE Swap v2' }));
app.get('/debug', (req,res) => res.json({
  instanceId: INSTANCE_ID,
  waConnected,
  hasQR: !!currentQR,
  reconnect440Count,
  hasAnthropicKey: !!process.env.ANTHROPIC_API_KEY,
  anthropicKeyPrefix: process.env.ANTHROPIC_API_KEY ? process.env.ANTHROPIC_API_KEY.slice(0,10) + '...' : 'NOT SET',
  hasSupabaseUrl: !!process.env.SUPABASE_URL,
  hasEncryptionKey: !!process.env.ENCRYPTION_KEY,
}));

// ── Swap ──────────────────────────────────────────────────
app.post('/build/swap', async (req,res) => {
  try {
    const { fromToken, toToken, fromAmount, walletAddress, slippage } = req.body;
    const isTon = !fromToken||fromToken==='ton';
    const isTonAsk = !toToken||toToken==='ton';
    const slip = parseFloat(slippage??0.01);

    // Get decimals dynamically from STON.fi API
    let fromDecimals = 9;
    if(!isTon){
      try{
        const assetRes = await fetch(`https://api.ston.fi/v1/assets/${fromToken}`);
        const assetData = await assetRes.json();
        fromDecimals = assetData?.asset?.decimals ?? assetData?.decimals ?? 9;
      }catch{}
    }
    const offerUnits = String(BigInt(Math.round(parseFloat(fromAmount) * Math.pow(10, fromDecimals))));
    const sim = await apiClient.simulateSwap({
      offerAddress: isTon?TON_NATIVE:fromToken,
      askAddress: isTonAsk?TON_NATIVE:toToken,
      offerUnits,
      slippageTolerance: String(slip),
    });
    if(!sim.askUnits) throw new Error('No liquidity for this pair');
    const router = tonClient.open(new DEX.v1.Router());
    const proxyTon = new pTON.v1();
    let txParams;
    if(isTon) txParams = await router.getSwapTonToJettonTxParams({ userWalletAddress:walletAddress, proxyTon, offerAmount:BigInt(offerUnits), askJettonAddress:toToken, minAskAmount:BigInt(sim.minAskUnits), queryId:Date.now() });
    else if(isTonAsk) txParams = await router.getSwapJettonToTonTxParams({ userWalletAddress:walletAddress, offerJettonAddress:fromToken, offerAmount:BigInt(offerUnits), proxyTon, minAskAmount:BigInt(sim.minAskUnits), queryId:Date.now() });
    else txParams = await router.getSwapJettonToJettonTxParams({ userWalletAddress:walletAddress, offerJettonAddress:fromToken, offerAmount:BigInt(offerUnits), askJettonAddress:toToken, minAskAmount:BigInt(sim.minAskUnits), queryId:Date.now() });
    const toAddress = txParams.to.toString({ bounceable:true, urlSafe:true });
    res.json({ ok:true, simulation:{ offerUnits:sim.offerUnits, askUnits:sim.askUnits, minAskUnits:sim.minAskUnits, swapRate:sim.swapRate, priceImpact:sim.priceImpact }, transaction:{ validUntil:Math.floor(Date.now()/1000)+300, messages:[{ address:toAddress, amount:txParams.value.toString(), payload:txParams.body?.toBoc().toString('base64')??'' }] } });
  } catch(e) { res.status(400).json({ ok:false, error:e.message }); }
});

// ── Token search ──────────────────────────────────────────
app.post('/search/token', async (req,res) => {
  try {
    const { symbol } = req.body;
    const assets = await apiClient.queryAssets({ searchString:symbol, limit:10 });
    const match = assets.find(a=>a.symbol?.toUpperCase()===symbol.toUpperCase()&&a.dexUsdPrice&&!a.blacklisted)||assets.find(a=>a.symbol?.toUpperCase()===symbol.toUpperCase())||assets[0];
    if(!match) return res.status(404).json({ ok:false, error:`"${symbol}" not found` });
    res.json({ ok:true, symbol:match.symbol, address:match.contractAddress, decimals:match.decimals??9, price:match.dexUsdPrice });
  } catch(e) { res.status(400).json({ ok:false, error:e.message }); }
});

// ── Liquidity ─────────────────────────────────────────────
app.post('/build/liquidity', async (req,res) => {
  try {
    const { tokenA, tokenB, amountA, walletAddress } = req.body;
    const isTonA = !tokenA||tokenA==='ton';
    const sim = await apiClient.simulateLiquidityProvision({ provisionType:'Balanced', tokenA:isTonA?TON_NATIVE:tokenA, tokenB, tokenAUnits:String(BigInt(Math.round(parseFloat(amountA)*1e9))), slippageTolerance:'0.01' });
    const router = tonClient.open(new DEX.v1.Router());
    const proxyTon = new pTON.v1();
    let txParams;
    if(isTonA) txParams = await router.getProvideLiquidityTonTxParams({ userWalletAddress:walletAddress, proxyTon, otherTokenAddress:tokenB, sendAmount:BigInt(sim.tokenAUnits||Math.round(parseFloat(amountA)*1e9)), minLpOut:BigInt(sim.minLpOut||'1'), queryId:Date.now() });
    else txParams = await router.getProvideLiquidityJettonTxParams({ userWalletAddress:walletAddress, sendTokenAddress:tokenA, sendAmount:BigInt(sim.tokenAUnits||Math.round(parseFloat(amountA)*1e9)), otherTokenAddress:tokenB, minLpOut:BigInt(sim.minLpOut||'1'), queryId:Date.now() });
    res.json({ ok:true, simulation:sim, transaction:{ validUntil:Math.floor(Date.now()/1000)+300, messages:[{ address:txParams.to.toString({ bounceable:true, urlSafe:true }), amount:txParams.value.toString(), payload:txParams.body?.toBoc().toString('base64')??'' }] } });
  } catch(e) { res.status(400).json({ ok:false, error:e.message }); }
});

// ── Farm stake ────────────────────────────────────────────
app.post('/build/stake', async (req,res) => {
  try {
    const { walletAddress, farmAddress, lpTokenAddress, lpAmount } = req.body;
    if(!walletAddress||!farmAddress||!lpTokenAddress||!lpAmount) return res.status(400).json({ ok:false, error:'Missing fields' });
    const farm = tonClient.open(FARM.v3.NftMinter.create(farmAddress));
    const stakeTxParams = await farm.getStakeTxParams({ userWalletAddress:walletAddress, jettonAddress:lpTokenAddress, jettonAmount:BigInt(Math.round(parseFloat(lpAmount)*1e9)), queryId:Date.now() });
    res.json({ ok:true, transaction:{ validUntil:Math.floor(Date.now()/1000)+300, messages:[{ address:stakeTxParams.to.toString({ bounceable:true, urlSafe:true }), amount:stakeTxParams.value.toString(), payload:stakeTxParams.body?.toBoc().toString('base64')??'' }] } });
  } catch(e) { res.status(400).json({ ok:false, error:e.message }); }
});

// ── Farms list ────────────────────────────────────────────
app.get('/farms', async (req,res) => {
  try {
    const farms = await apiClient.getFarms();
    res.json({ ok:true, farms:farms.slice(0,20).map(f=>({ address:f.address, poolAddress:f.poolAddress, apr:f.apr, tvl:f.tvl, rewardToken:f.rewardTokenSymbol, lpToken:f.lpTokenAddress, name:f.poolName })) });
  } catch(e) { res.status(400).json({ ok:false, error:e.message }); }
});

// ── TON Stakers ───────────────────────────────────────────
// TON Stakers pool contract address
const TONSTAKERS_POOL = 'EQCkWxfyhAkim3g2DjKQQg8T5P4g-Q1-K_jErGcDJZ4i-vqR';

app.post('/build/tonstake', async (req,res) => {
  try {
    const { walletAddress, amount } = req.body;
    if(!walletAddress||!amount) return res.status(400).json({ ok:false, error:'Missing fields' });

    const nanoAmount = BigInt(Math.round(parseFloat(amount)*1e9));

    // TON Stakers uses a simple TON transfer to the pool contract
    // with op code 0x47d54391 and referral code
    const { beginCell } = await import('@ton/ton');
    const body = beginCell()
      .storeUint(0x47d54391, 32) // TON Stakers deposit op
      .storeUint(0, 64)          // query id
      .storeUint(0, 32)          // referral code (0 = none)
      .endCell();

    // Fetch current APY from TON Stakers API
    let apy = 5.2, tvl = 0;
    try {
      const statsRes = await fetch('https://api.tonstakers.com/v1/stats');
      if(statsRes.ok){
        const stats = await statsRes.json();
        apy = parseFloat(stats.apy||stats.apr||5.2);
        tvl = parseFloat(stats.tvl||0);
      }
    } catch{}

    res.json({
      ok: true,
      apy,
      tvl,
      transaction: {
        validUntil: Math.floor(Date.now()/1000)+300,
        messages:[{
          address: TONSTAKERS_POOL,
          amount: (nanoAmount + BigInt('100000000')).toString(), // amount + 0.1 TON gas
          payload: body.toBoc().toString('base64'),
        }]
      }
    });
  } catch(e) { res.status(400).json({ ok:false, error:e.message }); }
});

app.get('/tonstake/stats', async (req,res) => {
  try {
    let apy = 5.2, tvl = 0;
    try {
      const statsRes = await fetch('https://api.tonstakers.com/v1/stats');
      if(statsRes.ok){ const s=await statsRes.json(); apy=parseFloat(s.apy||s.apr||5.2); tvl=parseFloat(s.tvl||0); }
    } catch{}
    res.json({ ok:true, apy, tvl });
  } catch(e) { res.status(400).json({ ok:false, error:e.message }); }
});

// ── LIMIT ORDERS ──────────────────────────────────────────

// Step 1: Get user's agent wallet address (create if new)
app.post('/agent/address', async (req,res) => {
  try {
    const { userWallet } = req.body;
    if(!userWallet) return res.status(400).json({ ok:false, error:'Missing userWallet' });
    const { address } = await getUserWallet(userWallet);
    res.json({ ok:true, address });
  } catch(e) { res.status(500).json({ ok:false, error:e.message }); }
});

// Step 2: Place limit order (after user has funded agent wallet)
app.post('/limit/place', async (req,res) => {
  try {
    const { userWallet, tokenIn, tokenOut, amount, targetPrice, direction, tokenInSymbol, tokenOutSymbol } = req.body;
    if(!userWallet||!tokenIn||!tokenOut||!amount||!targetPrice||!direction)
      return res.status(400).json({ ok:false, error:'Missing fields' });
    const { address:agentAddress } = await getUserWallet(userWallet);
    const { data, error } = await supabase.from('limit_orders').insert({
      user_wallet: userWallet,
      agent_wallet: agentAddress,
      token_in: tokenIn,
      token_out: tokenOut,
      token_in_symbol: tokenInSymbol||tokenIn,
      token_out_symbol: tokenOutSymbol||tokenOut,
      amount: parseFloat(amount),
      target_price: parseFloat(targetPrice),
      direction,
      status: 'pending',
      created_at: new Date().toISOString(),
    }).select().single();
    if(error) throw new Error(error.message);
    res.json({ ok:true, order:data, agentAddress });
  } catch(e) { res.status(400).json({ ok:false, error:e.message }); }
});

// Get user's orders
app.get('/limit/orders/:wallet', async (req,res) => {
  try {
    const { data, error } = await supabase.from('limit_orders').select('*').eq('user_wallet',req.params.wallet).order('created_at',{ ascending:false }).limit(20);
    if(error) throw new Error(error.message);
    res.json({ ok:true, orders:data });
  } catch(e) { res.status(400).json({ ok:false, error:e.message }); }
});

// Cancel order
app.post('/limit/cancel/:id', async (req,res) => {
  try {
    const { error } = await supabase.from('limit_orders').update({ status:'cancelled' }).eq('id',req.params.id);
    if(error) throw new Error(error.message);
    res.json({ ok:true });
  } catch(e) { res.status(400).json({ ok:false, error:e.message }); }
});

// ── Price monitor loop ────────────────────────────────────
async function checkLimitOrders() {
  try {
    const { data:orders } = await supabase.from('limit_orders').select('*').eq('status','pending');
    if(!orders?.length) return;

    for(const order of orders) {
      try {
        const offerAddr = order.token_in==='ton'?TON_NATIVE:order.token_in;
        const askAddr   = order.token_out==='ton'?TON_NATIVE:order.token_out;
        const units = String(BigInt(Math.round(order.amount*1e9)));

        const su = new URL('https://api.ston.fi/v1/swap/simulate');
        su.searchParams.set('offer_address',offerAddr);
        su.searchParams.set('ask_address',askAddr);
        su.searchParams.set('units',units);
        su.searchParams.set('slippage_tolerance','0.02');
        const sr = await fetch(su.toString(),{ method:'POST' });
        if(!sr.ok) continue;
        const sim = await sr.json();
        if(!sim.ask_units||!sim.offer_units) continue;

        const currentPrice = parseFloat(sim.ask_units)/parseFloat(sim.offer_units);
        const shouldFill =
          (order.direction==='buy'  && currentPrice<=order.target_price)||
          (order.direction==='sell' && currentPrice>=order.target_price);
        if(!shouldFill) continue;

        console.log(`🎯 Order ${order.id} triggered! Price:${currentPrice} Target:${order.target_price}`);
        await supabase.from('limit_orders').update({ status:'executing' }).eq('id',order.id);

        // Get user's agent wallet and execute swap
        const { wallet, contract, keyPair } = await getUserWallet(order.user_wallet);
        const router = tonClient.open(new DEX.v1.Router());
        const proxyTon = new pTON.v1();
        const isTon = order.token_in==='ton';
        const isTonAsk = order.token_out==='ton';

        let txParams;
        if(isTon) {
          txParams = await router.getSwapTonToJettonTxParams({
            userWalletAddress: wallet.address.toString(),
            proxyTon, offerAmount:BigInt(Math.round(order.amount*1e9)),
            askJettonAddress:order.token_out,
            minAskAmount:BigInt(sim.min_ask_units||'1'), queryId:Date.now(),
          });
        } else if(isTonAsk) {
          txParams = await router.getSwapJettonToTonTxParams({
            userWalletAddress: wallet.address.toString(),
            offerJettonAddress:order.token_in, offerAmount:BigInt(Math.round(order.amount*1e9)),
            proxyTon, minAskAmount:BigInt(sim.min_ask_units||'1'), queryId:Date.now(),
          });
        } else {
          txParams = await router.getSwapJettonToJettonTxParams({
            userWalletAddress: wallet.address.toString(),
            offerJettonAddress:order.token_in, offerAmount:BigInt(Math.round(order.amount*1e9)),
            askJettonAddress:order.token_out,
            minAskAmount:BigInt(sim.min_ask_units||'1'), queryId:Date.now(),
          });
        }

        const seqno = await contract.getSeqno();
        await contract.sendTransfer({
          seqno, secretKey:keyPair.secretKey,
          messages:[internal({ to:txParams.to, value:txParams.value, body:txParams.body })],
        });

        // Wait 15s for swap to settle, then send output back to user's main wallet
        await new Promise(r => setTimeout(r, 15000));

        const isTonOutput = order.token_out === 'ton';
        const seqno2 = await contract.getSeqno();

        if(isTonOutput) {
          // Send TON back — get balance first, keep 0.05 TON for gas
          const balRes = await fetch(`https://tonapi.io/v2/accounts/${wallet.address.toString({ bounceable:false, urlSafe:true })}`);
          const balData = await balRes.json();
          const bal = BigInt(balData?.balance||0);
          const sendBack = bal - BigInt('50000000'); // keep 0.05 TON for gas
          if(sendBack > 0n) {
            await contract.sendTransfer({
              seqno: seqno2, secretKey: keyPair.secretKey,
              messages:[internal({ to: order.user_wallet, value: sendBack, body: '' })],
            });
          }
        } else {
          // Send jetton back to user's main wallet
          const jetRes = await fetch(`https://tonapi.io/v2/accounts/${wallet.address.toString({ bounceable:false, urlSafe:true })}/jettons?currencies=usd`);
          const jetData = await jetRes.json();
          const outJetton = (jetData?.balances||[]).find(j => j.jetton?.address === order.token_out);
          if(outJetton && BigInt(outJetton.balance) > 0n) {
            // Build jetton transfer back to user
            const sendBackRouter = tonClient.open(new DEX.v1.Router());
            // Use a simple jetton transfer (not a swap)
            const { Address, beginCell } = await import('@ton/ton');
            const jettonWalletRes = await fetch(`https://api.ston.fi/v1/jetton/${order.token_out}/address?owner_address=${wallet.address.toString({ bounceable:false, urlSafe:true })}`);
            const jettonWalletData = await jettonWalletRes.json();
            if(jettonWalletData?.address) {
              const transferBody = beginCell()
                .storeUint(0x0f8a7ea5, 32).storeUint(Date.now(), 64)
                .storeCoins(BigInt(outJetton.balance))
                .storeAddress(Address.parse(order.user_wallet))
                .storeAddress(Address.parse(wallet.address.toString()))
                .storeBit(0).storeCoins(BigInt('1')).storeBit(0)
                .endCell();
              await contract.sendTransfer({
                seqno: seqno2, secretKey: keyPair.secretKey,
                messages:[internal({ to: jettonWalletData.address, value: BigInt('50000000'), body: transferBody })],
              });
            }
          }
        }

        await supabase.from('limit_orders').update({
          status:'filled',
          filled_at: new Date().toISOString(),
          filled_price: currentPrice,
        }).eq('id',order.id);

        console.log(`✅ Order ${order.id} filled and funds sent back to user`);
      } catch(e) {
        console.error(`Order ${order.id} error:`,e.message);
        await supabase.from('limit_orders').update({ status:'failed' }).eq('id',order.id);
      }
    }
  } catch(e) { console.error('Monitor error:',e.message); }
}

setInterval(checkLimitOrders, 30000);
console.log('🤖 Limit order monitor running');

const PORT = process.env.PORT||3000;
app.listen(PORT, () => {
  console.log(`SAGE Swap on port ${PORT}`);
  // Railway marks the instance healthy once this callback fires.
  // Wait 35s AFTER the health check passes before connecting WhatsApp —
  // by then Railway has sent SIGTERM to the old instance and it has
  // fully exited (SIGTERM handler is fast now — no 3s WS wait).
  setTimeout(() => {
    supabase.from('pending_polls').select('*').then(({ data }) => {
      if (data?.length) {
        for (const row of data) {
          pendingPolls.set(row.jid, {
            msgKey: row.msg_key,
            encKey: Buffer.from(row.enc_key, 'base64'),
            options: typeof row.options === 'string' ? JSON.parse(row.options) : row.options,
            optionMap: typeof row.option_map === 'string' ? JSON.parse(row.option_map) : row.option_map,
          });
        }
        console.log(`📋 Loaded ${data.length} pending poll(s) from Supabase`);
      }
    }).catch(() => {});

    startWhatsApp().catch(console.error);
  }, 35000);
  console.log('⏳ Waiting 35s after health check before connecting WhatsApp...');
});


// ── WHATSAPP (Baileys) ────────────────────────────────────

let waSocket = null;
let currentQR = null;
let waConnected = false;
let isStarting = false;
let restartTimer = null;
let intentionalClose = false;
let lockHeartbeat = null;
let reconnect440Count = 0;
const INSTANCE_ID = Math.random().toString(36).substr(2, 9);
const userSessions = new Map();
const pendingImages = new Map(); // jid -> { buffer, caption }

async function acquireLock() {
  const now = new Date();
  const expiry = new Date(Date.now() + 40000).toISOString();
  const { data: existing } = await supabase.from('whatsapp_auth').select('value').eq('key', '_lock').single();
  if (existing?.value) {
    const lock = existing.value;
    const lockExpired = new Date(lock.expiry) <= now;
    if (!lockExpired && lock.instanceId !== INSTANCE_ID) {
      console.log(`Lock held by instance ${lock.instanceId}, waiting...`);
      return false;
    }
    if (lockExpired) {
      console.log(`Stale lock from ${lock.instanceId} expired, taking over...`);
    }
  }
  await supabase.from('whatsapp_auth').upsert({ key: '_lock', value: { instanceId: INSTANCE_ID, expiry }, updated_at: new Date().toISOString() });
  await new Promise(r => setTimeout(r, 500));
  const { data: check } = await supabase.from('whatsapp_auth').select('value').eq('key', '_lock').single();
  return check?.value?.instanceId === INSTANCE_ID;
}

async function renewLock() {
  const expiry = new Date(Date.now() + 40000).toISOString();
  await supabase.from('whatsapp_auth').upsert({ key: '_lock', value: { instanceId: INSTANCE_ID, expiry }, updated_at: new Date().toISOString() });
}

async function releaseLock() {
  await supabase.from('whatsapp_auth').delete().eq('key', '_lock');
}

// Visit /qr?secret=YOUR_SECRET in browser to scan and connect WhatsApp
app.get('/qr', async (req, res) => {
  const QR_SECRET = process.env.QR_SECRET || '';
  if (!QR_SECRET || req.query.secret !== QR_SECRET) {
    return res.status(401).send('<html><body style="text-align:center;font-family:sans-serif;padding:40px;background:#0a0a0a;color:#fff"><h1>🔒 Unauthorized</h1></body></html>');
  }
  if (waConnected) {
    return res.send('<html><body style="text-align:center;font-family:sans-serif;padding:40px;background:#0a0a0a;color:#fff"><h1>✅ SAGE is connected to WhatsApp!</h1><p>The bot is active and ready.</p></body></html>');
  }
  if (!currentQR) {
    const { data: stored } = await supabase.from('whatsapp_auth').select('value').eq('key', '_qr').single();
    if (stored?.value?.data) currentQR = stored.value.data;
  }
  if (!currentQR) {
    return res.send('<html><body style="text-align:center;font-family:sans-serif;padding:40px;background:#0a0a0a;color:#fff"><h1>⏳ Generating QR Code...</h1><p>Refresh this page in a few seconds.</p></body></html>');
  }
  res.send(`<!DOCTYPE html>
<html>
<head><title>SAGE - Scan QR</title><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="text-align:center;font-family:sans-serif;padding:40px;background:#0a0a0a;color:#fff">
  <h1 style="color:#00C2FF">SAGE</h1>
  <p style="color:#aaa">Open WhatsApp → Linked Devices → Link a Device → scan below</p>
  <div style="position:relative;display:inline-block;margin:16px auto">
    <img src="${currentQR}" style="width:260px;height:260px;border-radius:12px;display:block;border:3px solid #00C2FF" />
    <div id="overlay" style="display:none;position:absolute;inset:0;background:rgba(0,0,0,0.75);border-radius:12px;display:flex;align-items:center;justify-content:center;font-size:18px;color:#fff;font-weight:bold">Refreshing...</div>
  </div>
  <p id="timer" style="color:#00C2FF;font-size:18px;font-weight:bold;margin:8px">⏱ Scan within <span id="sec">15</span>s</p>
  <p style="color:#555;font-size:12px">Page refreshes automatically to keep QR fresh</p>
  <script>
    var t = 15;
    var iv = setInterval(function(){
      t--;
      document.getElementById('sec').textContent = t;
      if(t <= 0){
        clearInterval(iv);
        document.getElementById('timer').textContent = '🔄 Getting fresh QR...';
        document.getElementById('overlay').style.display='flex';
        location.reload();
      }
    }, 1000);
  </script>
</body>
</html>`);
});

async function sendWhatsAppMessage(jid, text) {
  if (!waSocket || !waConnected) {
    console.error('❌ WhatsApp not connected');
    return;
  }
  await waSocket.sendMessage(jid, { text });
}

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY || '' });

// ── WhatsApp Wallet Helpers ───────────────────────────────

async function getWhatsAppWallet(jid) {
  const { data } = await supabase
    .from('agent_wallets')
    .select('*')
    .eq('user_wallet', `wa:${jid}`)
    .single();
  return data || null;
}

async function createWalletForUser(jid) {
  const mnemonic = await mnemonicNew(24);
  const keyPair = await mnemonicToPrivateKey(mnemonic);
  const wallet = WalletContractV4.create({ workchain: 0, publicKey: keyPair.publicKey });
  const address = wallet.address.toString({ bounceable: false, urlSafe: true });
  await supabase.from('agent_wallets').insert({
    user_wallet: `wa:${jid}`,
    agent_address: address,
    encrypted_mnemonic: encrypt(mnemonic.join(' ')),
    created_at: new Date().toISOString(),
  });
  return { address, mnemonic };
}

async function importWalletForUser(jid, mnemonicWords) {
  const keyPair = await mnemonicToPrivateKey(mnemonicWords);
  const wallet = WalletContractV4.create({ workchain: 0, publicKey: keyPair.publicKey });
  const address = wallet.address.toString({ bounceable: false, urlSafe: true });
  const key = `wa:${jid}`;
  const { data: existing } = await supabase.from('agent_wallets').select('id').eq('user_wallet', key).single();
  if (existing) {
    await supabase.from('agent_wallets').update({
      agent_address: address,
      encrypted_mnemonic: encrypt(mnemonicWords.join(' ')),
    }).eq('user_wallet', key);
  } else {
    await supabase.from('agent_wallets').insert({
      user_wallet: key,
      agent_address: address,
      encrypted_mnemonic: encrypt(mnemonicWords.join(' ')),
      created_at: new Date().toISOString(),
    });
  }
  return { address };
}

async function handleOnboarding(trimmed, lower, userJid) {
  const session = userSessions.get(userJid);

  // Waiting for seed phrase import
  if (session?.step === 'awaiting_seed') {
    const words = trimmed.trim().split(/\s+/);
    if (words.length !== 24) {
      return { text: `❌ That doesn't look right — a seed phrase is exactly *24 words*.\n\nPaste all 24 words separated by spaces, or type *cancel* to go back.` };
    }
    if (lower === 'cancel') {
      userSessions.set(userJid, { step: 'onboarding' });
      return { text: `↩️ Cancelled. Type *generate* to create a new wallet or *import* to try again.` };
    }
    const valid = await mnemonicValidate(words);
    if (!valid) {
      return { text: `❌ Invalid seed phrase. Please check your words and try again, or type *cancel* to go back.` };
    }
    try {
      const { address } = await importWalletForUser(userJid, words);
      userSessions.set(userJid, { step: 'ready' });
      return {
        pin: true,
        text: `✅ *Wallet imported successfully!*\n\n` +
              `📬 Your TON address:\n${address}\n\n` +
              `📌 Pinning this message so you can always find your address.\n\n` +
              `You're all set! Ask me anything — swap, check prices, limit orders, and more.`
      };
    } catch (e) {
      return { text: `❌ Failed to import wallet: ${e.message}\n\nTry again or type *cancel*.` };
    }
  }

  // Handle generate/import choice
  if (lower === 'generate' || lower === '1') {
    try {
      const { address, mnemonic } = await createWalletForUser(userJid);
      userSessions.set(userJid, { step: 'ready' });
      return {
        pin: true,
        text: `✅ *Wallet created!*\n\n` +
              `📬 Your TON address:\n${address}\n\n` +
              `🔑 *Your seed phrase:*\n${mnemonic.join(' ')}\n\n` +
              `✍️ Write these 24 words down somewhere safe — this message will be unrecoverable after 24 hours.\n` +
              `⚠️ Never share your seed phrase with anyone.\n\n` +
              `💡 Type *seed phrase* within 24hrs if you need to see it again.\n\n` +
              `📌 Pinning this message so you can always find your address.`
      };
    } catch (e) {
      return { text: `❌ Failed to create wallet: ${e.message}. Try again.` };
    }
  }

  if (lower === 'import' || lower === '2') {
    userSessions.set(userJid, { step: 'awaiting_seed' });
    return {
      text: `📥 *Import Wallet*\n\nPaste your *24-word seed phrase* (all words separated by spaces):\n\n⚠️ Make sure you're in a private chat. Your seed phrase gives full wallet access.`
    };
  }

  // Default welcome for new users
  userSessions.set(userJid, { step: 'onboarding' });
  return {
    text: `👋 Welcome to *SAGE*!\n\nYour autonomous DeFi agent on STON.fi. To get started, set up your wallet:\n\nReply *generate* to create a new wallet\nReply *import* to import an existing one`,
  };
}
const conversationHistory = new Map(); // per-user message history

const SAGE_SYSTEM_PROMPT = `You are SAGE, an autonomous DeFi AI agent on WhatsApp powered by STON.fi. You execute trades, swaps, staking, and limit orders on behalf of the user using their SAGE wallet.

Tools available:
- get_wallet_balance: check TON and token balances
- lookup_token: get live price and info for any token
- get_swap_quote: simulate a swap before executing
- execute_swap: execute a real swap using the user's wallet
- place_limit_order: set auto-trade at a target price
- get_limit_orders: list active orders
- get_token_chart: send a real price chart image for any timeframe (1h, 4h, 1d, 1w, 1m) — always use this when user asks for a chart
- get_trending_tokens: top pools on STON.fi by 24h volume
- cancel_limit_order: cancel an order by ID
- stake_ton: stake TON for ~5.2% APY

Tone: direct, clean, professional. No hype, no emojis unless the user uses them first. Use WhatsApp formatting (*bold* for numbers/amounts, _italic_ sparingly). Keep replies short and structured.

NEVER ASSUME OR GUESS — this is absolute:
- If ANY detail is unclear, missing, or ambiguous — ask. Do not fill in gaps yourself.
- Never assume a token symbol, amount, direction, price, or intent. If the user says "buy some tokens" with no amount — ask for the amount. If they say "swap" with no tokens — ask which tokens.
- Never round numbers. Use exact calculated values (e.g. 0.662 TON, not 1 TON).
- Never proceed with a transaction based on inferred intent. Always confirm the exact details with the user before executing.
- When in doubt, ask one short clarifying question. One question at a time, not a list.

STRICT RULES — follow exactly:

SWAPS:
1. When user names a token (e.g. "NOT", "STON", "DOGS"), immediately call lookup_token to resolve it — NEVER ask the user for the contract address. You have a lookup tool, use it.
2. If user says "$X worth of TOKEN", call lookup_token for TON to get TON's USD price, then calculate fromAmount = X / TON_price_usd. NEVER round this to a whole number — use the exact decimal (e.g. $1 at $1.51/TON = 0.662 TON, not 1 TON).
3. Call get_swap_quote with that exact decimal fromAmount
4. Show the quote clearly: "Swap *X TON* → *Y TOKEN* at rate Z. Confirm?"
5. Call execute_swap ONLY after user replies yes/confirm/ok
6. If the quote fails due to no liquidity, say so clearly in one line — don't ask for the CA

LIMIT ORDERS:
1. If the request is ambiguous (e.g. "$20 worth", unclear token, unclear direction), ask for clarification FIRST. Do NOT guess.
2. Understand: "buy TOKEN" = spend TON to get TOKEN. "sell TOKEN" = spend TOKEN to get TON. fromToken is what user spends, toToken is what user receives.
3. "amount" is always in units of fromToken (the token being spent), not USD. If user says "$20 worth", you must first call lookup_token to get the current price, then calculate the equivalent token amount. Ask the user to confirm the calculated amount.
4. Call get_wallet_balance to verify the user has enough fromToken before placing.
5. Show the full order summary: "Limit order: Buy *X TOKEN* spending *Y TON* when price hits *Z*. You have *W TON* available. Confirm?"
6. Call place_limit_order ONLY after user explicitly says yes/confirm/ok. NEVER call it immediately — always wait for confirmation.

GENERAL:
- Always pass userJid from context when tools need it
- Never add filler phrases like "Time to load up" or motivational fluff
- Format balances clearly: *2.5 TON* ($3.20), not paragraphs
- If balance is insufficient for a trade, tell the user and do not proceed
- When get_trending_tokens returns pre-formatted text, send it exactly as-is — do not reformat, do not add tables, do not add extra headers
- Never use markdown tables (pipes |) — WhatsApp does not render them. Use numbered lists or line breaks instead
- $TICKER notation is standard web3 — $NOT means the NOT token, $STON means STON, $DOGS means DOGS. Strip the $ and treat it as the token symbol
- lookup_token works for ALL tokens including TON itself. ALWAYS call it for any price question — never tell the user to check Binance/CoinGecko/external sites`;

const sageTools = [
  {
    name: 'get_wallet_balance',
    description: "Get the user's SAGE wallet TON balance and all token holdings with USD values.",
    input_schema: { type: 'object', properties: { address: { type: 'string' } }, required: ['address'] },
  },
  {
    name: 'lookup_token',
    description: 'Look up a TON token by symbol or contract address. Returns price, 24h change, volume, liquidity, TVL, CA, and chart link.',
    input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  },
  {
    name: 'get_token_chart',
    description: 'Generate and send a price chart image for a token. Supports timeframes: 1h, 4h, 1d, 1w, 1m.',
    input_schema: {
      type: 'object',
      properties: {
        tokenAddress: { type: 'string', description: 'Token contract address' },
        symbol: { type: 'string', description: 'Token symbol for the caption' },
        timeframe: { type: 'string', description: 'Timeframe: 1h, 4h, 1d, 1w, 1m (default: 1d)' },
        userJid: { type: 'string' },
      },
      required: ['tokenAddress', 'symbol', 'userJid'],
    },
  },
  {
    name: 'get_trending_tokens',
    description: 'Get the top trending tokens on STON.fi sorted by TVL. Returns name, price, TVL, and CA.',
    input_schema: { type: 'object', properties: { limit: { type: 'number', description: 'Number of tokens to return (default 10)' } }, required: [] },
  },
  {
    name: 'get_swap_quote',
    description: 'Get a swap quote between two tokens before executing.',
    input_schema: {
      type: 'object',
      properties: {
        fromToken: { type: 'string' },
        toToken: { type: 'string' },
        amount: { type: 'number' },
      },
      required: ['fromToken', 'toToken', 'amount'],
    },
  },
  {
    name: 'execute_swap',
    description: 'Execute a real token swap using the user\'s SAGE wallet. Always get a quote first and confirm with user before calling this.',
    input_schema: {
      type: 'object',
      properties: {
        fromToken: { type: 'string', description: 'Symbol or address to swap from (TON for native)' },
        toToken: { type: 'string', description: 'Symbol or address to swap to (TON for native)' },
        amount: { type: 'number', description: 'Amount of fromToken to swap' },
        userJid: { type: 'string', description: 'User WhatsApp JID for wallet lookup' },
      },
      required: ['fromToken', 'toToken', 'amount', 'userJid'],
    },
  },
  {
    name: 'place_limit_order',
    description: 'Place a limit order to auto-buy or auto-sell when price hits a target. IMPORTANT: Only call this AFTER the user has explicitly confirmed (yes/confirm/ok). fromToken = token being spent, toToken = token being received. amount = quantity of fromToken to spend (not USD). For a "buy TOKEN" order, fromToken=TON and toToken=TOKEN address. Always verify balance before calling.',
    input_schema: {
      type: 'object',
      properties: {
        fromToken: { type: 'string', description: 'Token address or symbol being SPENT (e.g. TON when buying, token address when selling)' },
        toToken: { type: 'string', description: 'Token address or symbol being RECEIVED' },
        amount: { type: 'number', description: 'Amount of fromToken to spend (in token units, not USD)' },
        targetPrice: { type: 'number', description: 'Price ratio (toToken per fromToken) at which to trigger' },
        direction: { type: 'string', enum: ['buy', 'sell'] },
        userJid: { type: 'string' },
      },
      required: ['fromToken', 'toToken', 'amount', 'targetPrice', 'direction', 'userJid'],
    },
  },
  {
    name: 'get_limit_orders',
    description: "Get the user's active limit orders.",
    input_schema: { type: 'object', properties: { userJid: { type: 'string' } }, required: ['userJid'] },
  },
  {
    name: 'cancel_limit_order',
    description: 'Cancel a limit order by ID.',
    input_schema: { type: 'object', properties: { orderId: { type: 'string' } }, required: ['orderId'] },
  },
  {
    name: 'stake_ton',
    description: 'Stake TON via TON Stakers to earn ~5.2% APY. Executes using the SAGE wallet.',
    input_schema: {
      type: 'object',
      properties: {
        amount: { type: 'number', description: 'Amount of TON to stake' },
        userJid: { type: 'string' },
      },
      required: ['amount', 'userJid'],
    },
  },
];

async function runSageTool(name, input) {
  if (name === 'get_wallet_balance') {
    try {
      const { address } = input;
      const [balRes, jetRes] = await Promise.all([
        fetch(`https://tonapi.io/v2/accounts/${address}`),
        fetch(`https://tonapi.io/v2/accounts/${address}/jettons?currencies=usd`),
      ]);
      const balData = await balRes.json();
      const jetData = await jetRes.json();
      const tonBalance = balData.balance ? (Number(balData.balance) / 1e9).toFixed(4) : '0';
      const tokens = (jetData.balances || [])
        .filter(j => Number(j.balance) > 0)
        .map(j => ({
          symbol: j.jetton?.symbol || 'Unknown',
          balance: (Number(j.balance) / Math.pow(10, j.jetton?.decimals || 9)).toFixed(4),
          usd_value: j.price?.prices?.USD ? `$${(Number(j.balance) / Math.pow(10, j.jetton?.decimals || 9) * j.price.prices.USD).toFixed(2)}` : null,
        }));
      return JSON.stringify({ ton_balance: tonBalance, tokens });
    } catch (e) {
      return `Error fetching balance: ${e.message}`;
    }
  }

  if (name === 'lookup_token') {
    try {
      const rawQuery = input.query;
      const query = (rawQuery.startsWith('$') ? rawQuery.slice(1) : rawQuery).trim();

      // TON native — use tonapi.io rates (same source as mini app portfolio)
      if (query.toUpperCase() === 'TON') {
        const ratesRes = await fetch('https://tonapi.io/v2/rates?tokens=ton&currencies=usd');
        const ratesData = await ratesRes.json();
        const price = ratesData?.rates?.TON?.prices?.USD;
        const diff24h = ratesData?.rates?.TON?.diff_24h?.USD;
        return JSON.stringify({ symbol: 'TON', name: 'Toncoin', price_usd: price ? String(price) : null, price_change_24h: diff24h || null });
      }

      const isAddress = /^[EUkf][Q_A-Za-z0-9\-]{46,48}$/.test(query);
      let asset;
      if (isAddress) {
        const res = await fetch(`https://api.ston.fi/v1/assets/${query}`);
        asset = await res.json();
        if (asset?.asset) asset = asset.asset;
      } else {
        asset = await findAssetBySymbol(query);
      }
      if (!asset) return `No token found for "${query}"`;

      return JSON.stringify({
        symbol: asset.symbol,
        name: asset.display_name,
        address: asset.contract_address,
        decimals: asset.decimals ?? 9,
        price_usd: asset.dex_usd_price || null,
      });
    } catch (e) {
      return `Error looking up token: ${e.message}`;
    }
  }

  if (name === 'get_token_chart') {
    try {
      const { tokenAddress, symbol, timeframe = '1d', userJid } = input;

      const tfMap = {
        '1h': { interval: 'hour', limit: 24 },
        '4h': { interval: 'hour', limit: 96 },
        '1d': { interval: 'day', limit: 30 },
        '1w': { interval: 'day', limit: 7 },
        '1m': { interval: 'day', limit: 30 },
      };
      const { interval, limit } = tfMap[timeframe] || tfMap['1d'];

      // Get pool directly from GeckoTerminal (avoids address format mismatch with STON.fi)
      const tokenPoolsRes = await fetch(
        `https://api.geckoterminal.com/api/v2/networks/ton/tokens/${tokenAddress}/pools?page=1`,
        { headers: { 'Accept': 'application/json' } }
      );
      const tokenPoolsData = await tokenPoolsRes.json();
      const topPool = tokenPoolsData?.data?.[0];
      if (!topPool) return `No trading pool found for ${symbol} on GeckoTerminal.`;

      const poolAddress = topPool.attributes?.address;
      const baseTokenId = topPool.relationships?.base_token?.data?.id || '';
      // base_token id format: "ton_0:rawaddress" — check if our token is base or quote
      const normalizedAddr = tokenAddress.replace(/^0:/, '').toLowerCase();
      const isBase = baseTokenId.toLowerCase().includes(normalizedAddr);

      // Fetch OHLCV using GeckoTerminal's own pool address
      const geckoRes = await fetch(
        `https://api.geckoterminal.com/api/v2/networks/ton/pools/${poolAddress}/ohlcv/${interval}?limit=${limit}`,
        { headers: { 'Accept': 'application/json' } }
      );
      const geckoData = await geckoRes.json();
      const ohlcv = geckoData?.data?.attributes?.ohlcv_list;
      if (!ohlcv?.length) return `No price history available for ${symbol}.`;

      const sorted = [...ohlcv].reverse();

      // If our token is the quote token (not base), invert prices
      const price = (raw) => {
        const p = parseFloat(raw);
        return isBase ? p : (p !== 0 ? 1 / p : 0);
      };

      const labels = sorted.map(([ts]) => {
        const d = new Date(ts * 1000);
        if (interval === 'hour') {
          return `${d.getHours().toString().padStart(2,'0')}:00`;
        }
        return `${d.getMonth()+1}/${d.getDate()}`;
      });

      const closes = sorted.map(([,,,, c]) => price(c));
      const firstOpen = price(sorted[0][1]);
      const lastClose = closes[closes.length - 1];
      const isUp = lastClose >= firstOpen;

      // Smart y-axis formatting
      const maxPrice = Math.max(...closes);
      const decimalPlaces = maxPrice < 0.0001 ? 8 : maxPrice < 0.01 ? 6 : maxPrice < 1 ? 4 : 2;

      const chartConfig = {
        type: 'line',
        data: {
          labels,
          datasets: [{
            label: symbol,
            data: closes.map(v => parseFloat(v.toFixed(decimalPlaces))),
            fill: true,
            borderColor: isUp ? '#00e676' : '#ff5252',
            backgroundColor: isUp ? 'rgba(0,230,118,0.07)' : 'rgba(255,82,82,0.07)',
            tension: 0.3,
            pointRadius: 0,
            borderWidth: 2,
          }],
        },
        options: {
          legend: { display: false },
          scales: {
            xAxes: [{
              ticks: { maxTicksLimit: 6, fontColor: '#888', fontSize: 10 },
              gridLines: { color: '#222' },
            }],
            yAxes: [{
              ticks: { fontColor: '#888', fontSize: 10 },
              gridLines: { color: '#222' },
            }],
          },
        },
      };

      const chartUrl = `https://quickchart.io/chart?v=2&c=${encodeURIComponent(JSON.stringify(chartConfig))}&width=700&height=320&backgroundColor=%230d0d0d`;
      const imgRes = await fetch(chartUrl);
      if (!imgRes.ok) return `Failed to generate chart image.`;
      const buffer = Buffer.from(await imgRes.arrayBuffer());

      const changePct = firstOpen !== 0 ? ((lastClose - firstOpen) / firstOpen * 100).toFixed(2) : '0.00';
      const caption = `📊 *${symbol}* · ${timeframe.toUpperCase()} · ${isUp ? '▲' : '▼'} ${changePct}%`;
      pendingImages.set(userJid, { buffer, caption });
      return `Chart ready for ${symbol} (${timeframe}). Current price: ${lastClose.toFixed(decimalPlaces)}`;
    } catch (e) {
      return `Chart error: ${e.message}`;
    }
  }

  if (name === 'get_trending_tokens') {
    try {
      const limit = input.limit || 10;
      const [poolsRes, assetsRes] = await Promise.all([
        fetch('https://api.ston.fi/v1/pools?limit=100'),
        fetch('https://api.ston.fi/v1/assets?limit=200'),
      ]);
      const poolsData = await poolsRes.json();
      const assetsData = await assetsRes.json();
      const assetMap = {};
      for (const a of (assetsData?.asset_list || [])) {
        assetMap[a.contract_address] = a;
      }
      const pools = (poolsData?.pool_list || [])
        .filter(p => p.volume_24h_usd && Number(p.volume_24h_usd) > 0 && !p.deprecated)
        .sort((a, b) => Number(b.volume_24h_usd) - Number(a.volume_24h_usd))
        .slice(0, limit);

      const lines = pools.map((p, i) => {
        const t0 = assetMap[p.token0_address];
        const t1 = assetMap[p.token1_address];
        const pair = `${t0?.symbol || '?'}/${t1?.symbol || '?'}`;
        const vol = `$${Number(p.volume_24h_usd).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
        const tvl = `$${Number(p.lp_total_supply_usd).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
        const apy = p.apy_7d ? ` | APY ${(Number(p.apy_7d) * 100).toFixed(1)}%` : '';
        return `${i+1}. *${pair}*\n   Vol: ${vol} | TVL: ${tvl}${apy}`;
      });
      return `*Top ${pools.length} on STON.fi by 24h Volume*\n\n${lines.join('\n\n')}`;

    } catch (e) {
      return `Error fetching trending tokens: ${e.message}`;
    }
  }

  if (name === 'execute_swap') {
    const { fromToken, toToken, amount, userJid } = input;

    // Live progress message — edit in place as swap progresses
    let progressKey = null;
    const steps = [
      '⏳ *Preparing swap...*\n▓░░░░░░░░░ 10%',
      '🔑 *Loading wallet...*\n▓▓▓░░░░░░░ 30%',
      '📡 *Simulating swap...*\n▓▓▓▓▓░░░░░ 50%',
      '✍️ *Signing transaction...*\n▓▓▓▓▓▓▓░░░ 70%',
      '🚀 *Broadcasting to STON.fi...*\n▓▓▓▓▓▓▓▓▓░ 90%',
    ];
    const setProgress = async (step) => {
      try {
        if (!waSocket || !userJid) return;
        if (!progressKey) {
          const sent = await waSocket.sendMessage(userJid, { text: steps[step] });
          progressKey = sent?.key;
        } else {
          await waSocket.sendMessage(userJid, { text: steps[step], edit: progressKey });
        }
      } catch {}
    };

    try {
      await setProgress(0);
      const walletData = await getWhatsAppWallet(userJid);
      if (!walletData) return 'No wallet found for this user.';
      const mnemonic = decrypt(walletData.encrypted_mnemonic).split(' ');
      const keyPair = await mnemonicToPrivateKey(mnemonic);
      const wallet = WalletContractV4.create({ workchain: 0, publicKey: keyPair.publicKey });
      const contract = tonClient.open(wallet);
      await setProgress(1);

      const resolveAddr = async (rawSym) => {
        const sym = rawSym.startsWith('$') ? rawSym.slice(1) : rawSym;
        if (sym.toUpperCase() === 'TON') return TON_NATIVE;
        if (/^[EUkf][Q_A-Za-z0-9\-]{46,48}$/.test(sym)) return sym;
        const match = await findAssetBySymbol(sym);
        if (!match) throw new Error(`Token "${sym}" not found on STON.fi`);
        return match.contract_address;
      };
      const [fromAddr, toAddr] = await Promise.all([resolveAddr(fromToken), resolveAddr(toToken)]);
      const offerUnits = BigInt(Math.round(amount * 1e9));
      await setProgress(2);

      // Get best quote via Omniston aggregator
      const quote = await getOmnistonQuote(fromAddr, toAddr, offerUnits);
      if (!isSwapQuote(quote)) throw new Error('No swap quote available');
      await setProgress(3);

      // Build transaction messages from Omniston
      const walletAddrStr = wallet.address.toString({ bounceable: false, urlSafe: true });
      const traderAddr = { chain: { $case: 'ton', value: walletAddrStr } };
      const swapTx = await omniston.tonBuildSwap({
        quoteId: quote.quoteId,
        transferSrcAddress: traderAddr,
        refundSrcAddress: traderAddr,
        gasExcessAddress: traderAddr,
        traderDstAddress: traderAddr,
      });
      if (!swapTx?.messages?.length) throw new Error('Failed to build swap transaction');

      const seqno = await contract.getSeqno();
      await setProgress(4);

      await contract.sendTransfer({
        seqno,
        secretKey: keyPair.secretKey,
        messages: swapTx.messages.map(msg => internal({
          to: msg.targetAddress,
          value: BigInt(msg.sendAmount),
          body: Cell.fromBoc(Buffer.from(msg.payload, 'hex'))[0],
        })),
      });

      if (waSocket && userJid && progressKey) {
        await waSocket.sendMessage(userJid, { text: '✅ *Swap submitted!*\n▓▓▓▓▓▓▓▓▓▓ 100%', edit: progressKey });
      }

      const outUnits = quote.outputUnits ?? quote.askUnits ?? '0';
      const toAmount = Number(outUnits) / 1e9;

      // Send transaction card image
      try {
        const cardBuf = await generateTxCard({ fromAmount: amount, fromToken, toAmount, toToken });
        if (waSocket && userJid) {
          await waSocket.sendMessage(userJid, { image: cardBuf, caption: '' });
        }
      } catch (imgErr) { console.error('Tx card error:', imgErr.message); }

      return JSON.stringify({ success: true, swapped: amount, from: fromToken, to: toToken, expected_out: toAmount.toFixed(6) });
    } catch (e) {
      if (waSocket && userJid && progressKey) {
        await waSocket.sendMessage(userJid, { text: `❌ *Swap failed*\n${e.message}`, edit: progressKey }).catch(() => {});
      }
      return `Swap failed: ${e.message}`;
    }
  }

  if (name === 'get_swap_quote') {
    try {
      const { fromToken, toToken, amount } = input;
      const resolveAddr = async (rawSym) => {
        const sym = rawSym.startsWith('$') ? rawSym.slice(1) : rawSym;
        if (sym.toUpperCase() === 'TON') return TON_NATIVE;
        if (/^[EUkf][Q_A-Za-z0-9\-]{46,48}$/.test(sym)) return sym;
        const match = await findAssetBySymbol(sym);
        if (!match) throw new Error(`Token "${sym}" not found on STON.fi`);
        return match.contract_address;
      };
      const [fromAddr, toAddr] = await Promise.all([resolveAddr(fromToken), resolveAddr(toToken)]);
      const offerUnits = BigInt(Math.round(amount * 1e9));
      const quote = await getOmnistonQuote(fromAddr, toAddr, offerUnits);
      const outUnits = quote.outputUnits ?? quote.askUnits ?? '0';
      const outAmount = (Number(outUnits) / 1e9).toFixed(6);
      const rate = amount > 0 ? (Number(outUnits) / 1e9 / amount).toFixed(4) : '0';
      return JSON.stringify({
        from: fromToken, to: toToken,
        input_amount: amount, output_amount: outAmount,
        swap_rate: rate,
        min_received: outAmount,
        source: 'Omniston (aggregated)',
      });
    } catch (e) {
      return `Error getting swap quote: ${e.message}`;
    }
  }

  if (name === 'place_limit_order') {
    try {
      const { fromToken, toToken, amount, targetPrice, direction, userJid } = input;
      const walletData = await getWhatsAppWallet(userJid);
      if (!walletData) return 'No wallet found.';

      // Balance check before placing
      const isTonFrom = !fromToken || fromToken.toUpperCase() === 'TON';
      try {
        const balRes = await fetch(`https://tonapi.io/v2/accounts/${walletData.agent_address}`);
        const balData = await balRes.json();
        const tonBalance = Number(balData.balance || 0) / 1e9;

        if (isTonFrom) {
          if (tonBalance < parseFloat(amount)) {
            return JSON.stringify({ success: false, error: `Insufficient balance. You need ${amount} TON but only have ${tonBalance.toFixed(4)} TON. Fund your wallet first.` });
          }
        } else {
          // Check jetton balance
          const jetRes = await fetch(`https://tonapi.io/v2/accounts/${walletData.agent_address}/jettons?currencies=usd`);
          const jetData = await jetRes.json();
          const resolveAddr = async (sym) => {
            if (/^[EUkf][Q_A-Za-z0-9\-]{46,48}$/.test(sym)) return sym;
            const results = await apiClient.queryAssets({ searchString: sym, limit: 5 });
            const match = results.find(a => a.symbol?.toUpperCase() === sym.toUpperCase()) || results[0];
            return match?.contractAddress || null;
          };
          const fromAddr = await resolveAddr(fromToken);
          const jetton = fromAddr && (jetData.balances || []).find(j => j.jetton?.address === fromAddr);
          const jetBal = jetton ? Number(jetton.balance) / Math.pow(10, jetton.jetton?.decimals || 9) : 0;
          if (jetBal < parseFloat(amount)) {
            return JSON.stringify({ success: false, error: `Insufficient balance. You need ${amount} ${fromToken} but only have ${jetBal.toFixed(4)}. Fund your wallet first.` });
          }
        }
      } catch (balErr) {
        console.warn('Balance check failed (non-blocking):', balErr.message);
      }

      // Resolve token symbols to addresses for storage
      const resolveAddr = async (sym) => {
        if (!sym || sym.toUpperCase() === 'TON') return 'ton';
        if (/^[EUkf][Q_A-Za-z0-9\-]{46,48}$/.test(sym)) return sym;
        const match = await findAssetBySymbol(sym);
        return match?.contract_address || sym;
      };
      const [fromAddr, toAddr] = await Promise.all([resolveAddr(fromToken), resolveAddr(toToken)]);

      const { data, error } = await supabase.from('limit_orders').insert({
        user_wallet: `wa:${userJid}`, agent_wallet: walletData.agent_address,
        token_in: fromAddr, token_out: toAddr,
        token_in_symbol: fromToken.toUpperCase(), token_out_symbol: toToken.toUpperCase(),
        amount: parseFloat(amount), target_price: parseFloat(targetPrice), direction, status: 'pending',
        created_at: new Date().toISOString(),
      }).select().single();
      if (error) throw new Error(error.message);
      return JSON.stringify({ success: true, order_id: data.id, message: `Order placed: ${direction} ${amount} ${fromToken.toUpperCase()} → ${toToken.toUpperCase()} when price hits ${targetPrice}` });
    } catch (e) { return `Failed to place order: ${e.message}`; }
  }

  if (name === 'get_limit_orders') {
    try {
      const { userJid } = input;
      const { data, error } = await supabase.from('limit_orders').select('*').eq('user_wallet', `wa:${userJid}`).order('created_at', { ascending: false }).limit(10);
      if (error) throw new Error(error.message);
      return JSON.stringify(data?.map(o => ({ id: o.id, from: o.token_in_symbol, to: o.token_out_symbol, amount: o.amount, target_price: o.target_price, direction: o.direction, status: o.status })) || []);
    } catch (e) { return `Failed to get orders: ${e.message}`; }
  }

  if (name === 'cancel_limit_order') {
    try {
      const { orderId } = input;
      const { error } = await supabase.from('limit_orders').update({ status: 'cancelled' }).eq('id', orderId);
      if (error) throw new Error(error.message);
      return JSON.stringify({ success: true, message: 'Order cancelled.' });
    } catch (e) { return `Failed to cancel: ${e.message}`; }
  }

  if (name === 'stake_ton') {
    try {
      const { amount, userJid } = input;
      const walletData = await getWhatsAppWallet(userJid);
      if (!walletData) return 'No wallet found.';
      const mnemonic = decrypt(walletData.encrypted_mnemonic).split(' ');
      const keyPair = await mnemonicToPrivateKey(mnemonic);
      const wallet = WalletContractV4.create({ workchain: 0, publicKey: keyPair.publicKey });
      const contract = tonClient.open(wallet);
      const { beginCell } = await import('@ton/ton');
      const body = beginCell().storeUint(0x47d54391, 32).storeUint(0, 64).storeUint(0, 32).endCell();
      const nanoAmount = BigInt(Math.round(amount * 1e9));
      const seqno = await contract.getSeqno();
      await contract.sendTransfer({ seqno, secretKey: keyPair.secretKey, messages: [internal({ to: TONSTAKERS_POOL, value: nanoAmount + BigInt('100000000'), body })] });
      return JSON.stringify({ success: true, staked: amount, message: `${amount} TON staked via TON Stakers (~5.2% APY)` });
    } catch (e) { return `Staking failed: ${e.message}`; }
  }

  return 'Unknown tool';
}

async function handleWhatsAppUserInput(input, userJid) {
  if (!userSessions.has(userJid)) userSessions.set(userJid, { step: 'onboarding' });

  // Wallet gate — check Supabase first
  const walletRecord = await getWhatsAppWallet(userJid);
  if (!walletRecord) {
    return handleOnboarding(input.trim(), input.trim().toLowerCase(), userJid);
  }

  // User has a wallet — mark session ready and proceed to Claude
  if (userSessions.get(userJid)?.step !== 'ready') {
    userSessions.set(userJid, { step: 'ready' });
  }

  // Wallet shortcuts — always available
  const lower = input.trim().toLowerCase();
  if (['wallet', 'my wallet', 'address', 'my address'].includes(lower)) {
    return { text: `📬 *Your TON Wallet*\n\n${walletRecord.agent_address}` };
  }

  if (['seed phrase', 'seed', 'my seed', 'show seed'].includes(lower)) {
    const createdAt = new Date(walletRecord.created_at);
    const hoursElapsed = (Date.now() - createdAt.getTime()) / (1000 * 60 * 60);
    if (hoursElapsed > 24) {
      return { text: `🔒 Your seed phrase is no longer retrievable — it's been over 24 hours.\n\nIf you wrote it down you're safe. If not, you can *import* a new wallet or *generate* a fresh one.\n\n⚠️ Generating a new wallet will replace your current one.` };
    }
    const mnemonic = decrypt(walletRecord.encrypted_mnemonic);
    return { text: `🔑 *Your seed phrase (write this down):*\n\n${mnemonic}\n\n⚠️ This will stop being accessible in ${Math.floor(24 - hoursElapsed)} hours. Never share these words.` };
  }

  // Load history from Supabase (persists across redeploys)
  if (!conversationHistory.has(userJid)) {
    try {
      const { data } = await supabase.from('conversation_history').select('messages').eq('jid', userJid).single();
      conversationHistory.set(userJid, data?.messages || []);
    } catch {
      conversationHistory.set(userJid, []);
    }
  }
  const history = conversationHistory.get(userJid);

  history.push({ role: 'user', content: input });

  // Keep last 20 messages — but never orphan a tool_use/tool_result pair
  if (history.length > 20) {
    history.splice(0, history.length - 20);
    // If first message is a tool_result (orphaned), drop it too
    while (history.length > 0) {
      const first = history[0];
      const isToolResult = Array.isArray(first.content) && first.content[0]?.type === 'tool_result';
      if (first.role === 'user' && isToolResult) { history.shift(); }
      else break;
    }
  }

  try {
    const systemWithWallet = `${SAGE_SYSTEM_PROMPT}\n\nUser context:\n- Wallet address: ${walletRecord.agent_address}\n- userJid: ${userJid} (use this when tools require userJid)`;

    let response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 500,
      system: systemWithWallet,
      tools: sageTools,
      messages: history,
    });

    // Agentic tool use loop
    while (response.stop_reason === 'tool_use') {
      const toolUses = response.content.filter(b => b.type === 'tool_use');
      const toolResults = await Promise.all(
        toolUses.map(async (tu) => ({
          type: 'tool_result',
          tool_use_id: tu.id,
          content: await runSageTool(tu.name, tu.input),
        }))
      );

      history.push({ role: 'assistant', content: response.content });
      history.push({ role: 'user', content: toolResults });

      response = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 500,
        system: systemWithWallet,
        tools: sageTools,
        messages: history,
      });
    }

    const textBlock = response.content.find(b => b.type === 'text');
    const reply = textBlock?.text || "I couldn't process that. Try again.";

    history.push({ role: 'assistant', content: reply });

    // Persist to Supabase (fire and forget)
    supabase.from('conversation_history').upsert({
      jid: userJid,
      messages: history,
      updated_at: new Date().toISOString(),
    }).then(() => {}).catch(() => {});

    return { text: reply };
  } catch (e) {
    console.error('Claude error:', e.message, e.status, JSON.stringify(e.error || ''));
    if (e.status === 400) {
      // Malformed history — wipe it and let user retry cleanly
      conversationHistory.set(userJid, []);
      supabase.from('conversation_history').delete().eq('jid', userJid).then(() => {}).catch(() => {});
      return { text: `Something went wrong with my memory. I've reset our chat — please repeat your last request.` };
    }
    if (e.status === 401) {
      return { text: `API key error. Contact support.` };
    }
    if (e.status === 429) {
      return { text: `I'm a bit overloaded right now. Give it a few seconds and try again.` };
    }
    if (e.status >= 500) {
      return { text: `Service is having issues. Try again shortly.` };
    }
    return { text: `Something went wrong. Try again.` };
  }
}

async function useSupabaseAuthState() {
  const readData = async (key) => {
    const { data } = await supabase.from('whatsapp_auth').select('value').eq('key', key).single();
    if (!data?.value) return null;
    return JSON.parse(JSON.stringify(data.value), BufferJSON.reviver);
  };
  const writeData = async (key, value) => {
    await supabase.from('whatsapp_auth').upsert({ key, value: JSON.parse(JSON.stringify(value, BufferJSON.replacer)), updated_at: new Date().toISOString() });
  };
  const removeData = async (key) => {
    await supabase.from('whatsapp_auth').delete().eq('key', key);
  };

  const savedCreds = await readData('creds');
  if (savedCreds) {
    console.log('🔑 Loaded saved WhatsApp creds from Supabase — skipping QR');
  } else {
    console.log('⚠️  No saved creds found — QR scan required');
  }
  const creds = savedCreds || initAuthCreds();
  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          await Promise.all(ids.map(async (id) => {
            let val = await readData(`${type}-${id}`);
            if (type === 'app-state-sync-key' && val) val = proto.Message.AppStateSyncKeyData.fromObject(val);
            data[id] = val;
          }));
          return data;
        },
        set: async (data) => {
          const tasks = [];
          for (const category in data) {
            for (const id in data[category]) {
              const val = data[category][id];
              tasks.push(val ? writeData(`${category}-${id}`, val) : removeData(`${category}-${id}`));
            }
          }
          await Promise.all(tasks);
        },
      },
    },
    saveCreds: () => writeData('creds', creds),
  };
}

async function startWhatsApp() {
  if (isStarting) return;

  const hasLock = await acquireLock();
  if (!hasLock) {
    if (restartTimer) clearTimeout(restartTimer);
    restartTimer = setTimeout(startWhatsApp, 20000);
    return;
  }

  isStarting = true;
  if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
  if (lockHeartbeat) { clearInterval(lockHeartbeat); lockHeartbeat = null; }

  if (waSocket) {
    intentionalClose = true;
    try { waSocket.end(undefined); } catch (e) {}
    waSocket = null;
  }

  const { state, saveCreds } = await useSupabaseAuthState();
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: true,
    logger: Pino({ level: 'silent' }),
    browser: ['SAGE Bot', 'Chrome', '120.0.0'],
    keepAliveIntervalMs: 15000,
    connectTimeoutMs: 60000,
    retryRequestDelayMs: 2000,
  });

  waSocket = sock;
  isStarting = false;
  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      try {
        currentQR = await QRCode.toDataURL(qr);
        waConnected = false;
        await supabase.from('whatsapp_auth').upsert({ key: '_qr', value: { data: currentQR }, updated_at: new Date().toISOString() });
        console.log('📱 QR ready — visit /qr to scan');
      } catch (e) { console.error('QR error:', e.message); }
    }

    if (connection === 'close') {
      waConnected = false;
      currentQR = null;
      isStarting = false;
      if (lockHeartbeat) { clearInterval(lockHeartbeat); lockHeartbeat = null; }
      if (intentionalClose) { intentionalClose = false; return; }
      const code = lastDisconnect?.error?.output?.statusCode;
      console.log(`WhatsApp closed — code: ${code}, intentional: ${intentionalClose}, error: ${lastDisconnect?.error?.message}`);
      if (code === DisconnectReason.loggedOut) {
        console.log('🔄 Logged out — clearing session...');
        await supabase.from('whatsapp_auth').delete().not('key', 'eq', '_lock');
      }
      await releaseLock();
      if (restartTimer) clearTimeout(restartTimer);
      if (code === 440) {
        reconnect440Count++;
        const delay = Math.min(5000 * Math.pow(2, reconnect440Count), 120000) + Math.random() * 3000;
        console.log(`440 conflict — backing off ${Math.round(delay/1000)}s`);
        restartTimer = setTimeout(startWhatsApp, delay);
      } else {
        reconnect440Count = 0;
        restartTimer = setTimeout(startWhatsApp, 5000);
      }
    } else if (connection === 'open') {
      intentionalClose = false;
      waConnected = true;
      setTimeout(() => { reconnect440Count = 0; }, 30000); // only reset if stable for 30s
      currentQR = null;
      await supabase.from('whatsapp_auth').delete().eq('key', '_qr');
      lockHeartbeat = setInterval(renewLock, 20000);
      console.log('✅ WhatsApp connected!');
    }
  });

  async function sendResponse(sock, jid, response) {
    // Always use the live global socket — the local `sock` ref can go stale on reconnect
    const s = waSocket || sock;
    if (!s) return;
    let sent;
    try { sent = await s.sendMessage(jid, { text: response.text }); }
    catch (e) { console.error('sendResponse text error:', e.message); return; }

    // Send chart image if queued
    if (pendingImages.has(jid)) {
      const { buffer, caption } = pendingImages.get(jid);
      pendingImages.delete(jid);
      try { await s.sendMessage(jid, { image: buffer, caption }); } catch {}
    }

    // Pin wallet address messages
    if (response.pin && sent?.key) {
      try { await s.pinMessage(jid, sent.key, 1); } catch {}
    }

  }

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      if (msg.key.fromMe || !msg.message) continue;
      const jid = msg.key.remoteJid;
      if (!jid) continue;


      // ── Regular text message ───────────────────────────────
      const text = msg.message?.conversation ||
                   msg.message?.extendedTextMessage?.text || '';
      if (!text.trim()) continue;
      console.log(`💬 ${jid}: ${text}`);
      try {
        const response = await handleWhatsAppUserInput(text, jid);
        await sendResponse(sock, jid, response);
      } catch (e) {
        console.error('Handler error:', e.message);
        if (e.message?.includes('Connection Closed') || e.message?.includes('Connection Terminated')) return;
        try { await (waSocket || sock).sendMessage(jid, { text: '❌ Something went wrong. Try again.' }); } catch {}
      }
    }
  });
}

// Clean shutdown on redeploy — close WhatsApp before dying so new instance can connect cleanly
async function gracefulShutdown() {
  console.log('🛑 Shutting down — releasing lock...');
  intentionalClose = true;
  if (lockHeartbeat) clearInterval(lockHeartbeat);
  if (restartTimer) clearTimeout(restartTimer);
  // Do NOT call waSocket.end() — a proper WS close frame causes WhatsApp to
  // invalidate the session. A raw TCP drop (process exit) is treated as a
  // network disconnect, so the saved Supabase creds stay valid for next boot.
  await releaseLock();
  console.log('✅ Lock released, exiting.');
  process.exit(0);
}
process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

// Reconnect endpoint — restores session from Supabase without QR
app.post('/reconnect', async (req, res) => {
  const secret = req.headers['x-secret'] || req.query.secret;
  if (secret !== (process.env.QR_SECRET || '')) return res.status(401).json({ ok: false });
  console.log('🔄 Manual reconnect triggered');
  isStarting = false;
  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = setTimeout(() => startWhatsApp().catch(console.error), 1000);
  res.json({ ok: true, message: 'Reconnecting...' });
});


