import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import makeWASocket, { DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion, initAuthCreds, BufferJSON, proto } from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import Pino from 'pino';
import Anthropic from '@anthropic-ai/sdk';
import { mnemonicToPrivateKey, mnemonicNew, mnemonicValidate } from '@ton/crypto';
import { WalletContractV4, internal } from '@ton/ton';
import { createClient } from '@supabase/supabase-js';
import { DEX, pTON, FARM, Client } from '@ston-fi/sdk';
import { StonApiClient } from '@ston-fi/api';

const app = express();
app.use(cors());
app.use(express.json());

const apiClient = new StonApiClient();
const tonClient = new Client({ endpoint: 'https://toncenter.com/api/v2/jsonRPC' });
const supabase = createClient(process.env.SUPABASE_URL||'', process.env.SUPABASE_KEY||'');
const TON_NATIVE = 'EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c';

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
app.get('/debug', (req,res) => res.json({ instanceId: INSTANCE_ID, waConnected, hasQR: !!currentQR, reconnect440Count }));

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
app.listen(PORT, () => console.log(`SAGE Swap on port ${PORT}`));


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

async function acquireLock() {
  const expiry = new Date(Date.now() + 40000).toISOString();
  const { data: existing } = await supabase.from('whatsapp_auth').select('value').eq('key', '_lock').single();
  if (existing?.value) {
    const lock = existing.value;
    if (new Date(lock.expiry) > new Date() && lock.instanceId !== INSTANCE_ID) {
      console.log(`Lock held by instance ${lock.instanceId}, waiting...`);
      return false;
    }
  }
  await supabase.from('whatsapp_auth').upsert({ key: '_lock', value: { instanceId: INSTANCE_ID, expiry }, updated_at: new Date().toISOString() });
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
  <h1>🤖 Connect SAGE to WhatsApp</h1>
  <p>Scan this QR code with your WhatsApp</p>
  <img src="${currentQR}" style="width:280px;height:280px;border-radius:12px;margin:20px auto;display:block" />
  <p style="color:#aaa;font-size:14px">WhatsApp → Settings → Linked Devices → Link a Device</p>
  <p style="color:#555;font-size:12px">QR expires in ~30s — refresh if needed</p>
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
    text: `👋 Welcome to *SAGE*! 🤖\n\nYour DeFi assistant on TON blockchain.\n\nTo get started, you need a TON wallet:\n\n` +
          `1️⃣ *Generate* — create a new wallet (recommended)\n` +
          `2️⃣ *Import* — use your existing wallet\n\n` +
          `Reply *1* or *generate* / *2* or *import*`
  };
}
const conversationHistory = new Map(); // per-user message history

const SAGE_SYSTEM_PROMPT = `You are SAGE, an autonomous DeFi AI agent on WhatsApp for the TON blockchain. You don't just answer questions — you actually execute trades, swaps, staking, and limit orders on behalf of the user using their SAGE wallet.

You have full access to:
- get_wallet_balance: check the user's TON and token balances
- lookup_token: get live price and info for any token
- get_swap_quote: simulate a swap to show rates before executing
- execute_swap: ACTUALLY execute a swap using the user's wallet
- place_limit_order: set auto-trade when price hits a target
- get_limit_orders: list active orders
- cancel_limit_order: cancel an order
- stake_ton: ACTUALLY stake TON to earn ~5.2% APY

Personality: confident, concise, action-oriented. You are an agent, not a chatbot. Use WhatsApp formatting (*bold*, _italic_). Keep replies tight.

Flow for swaps: get quote first → confirm with user → execute. Never execute without user confirmation.
Flow for limit orders: confirm details → place immediately.
Always pass the userJid from context when tools require it.`;

const sageTools = [
  {
    name: 'get_wallet_balance',
    description: "Get the user's SAGE wallet TON balance and all token holdings with USD values.",
    input_schema: { type: 'object', properties: { address: { type: 'string' } }, required: ['address'] },
  },
  {
    name: 'lookup_token',
    description: 'Look up a TON token by symbol or contract address. Returns price, TVL, and contract address.',
    input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
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
    description: 'Place a limit order to auto-buy or auto-sell when price hits a target.',
    input_schema: {
      type: 'object',
      properties: {
        fromToken: { type: 'string' },
        toToken: { type: 'string' },
        amount: { type: 'number' },
        targetPrice: { type: 'number', description: 'Price at which to trigger the swap' },
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
      const { query } = input;
      const isAddress = /^[EUkf][Q_A-Za-z0-9\-]{46,48}$/.test(query);
      let asset;
      if (isAddress) {
        asset = await apiClient.getAsset(query);
      } else {
        const results = await apiClient.queryAssets({ searchString: query, limit: 5 });
        asset = results.find(a => a.symbol?.toUpperCase() === query.toUpperCase()) || results[0];
      }
      if (!asset) return `No token found for "${query}"`;
      return JSON.stringify({
        symbol: asset.symbol,
        address: asset.contractAddress,
        price_usd: asset.dexUsdPrice ? parseFloat(asset.dexUsdPrice).toFixed(8) : null,
        tvl_usd: asset.dexUsdTvl ? Number(asset.dexUsdTvl).toLocaleString() : null,
        blacklisted: asset.blacklisted,
      });
    } catch (e) {
      return `Error looking up token: ${e.message}`;
    }
  }

  if (name === 'get_swap_quote') {
    try {
      const { fromToken, toToken, amount } = input;
      const resolveAddr = async (sym) => {
        if (sym.toUpperCase() === 'TON') return TON_NATIVE;
        if (/^[EUkf][Q_A-Za-z0-9\-]{46,48}$/.test(sym)) return sym;
        const results = await apiClient.queryAssets({ searchString: sym, limit: 5 });
        const match = results.find(a => a.symbol?.toUpperCase() === sym.toUpperCase()) || results[0];
        if (!match) throw new Error(`Token "${sym}" not found`);
        return match.contractAddress;
      };
      const [fromAddr, toAddr] = await Promise.all([resolveAddr(fromToken), resolveAddr(toToken)]);
      const offerUnits = String(BigInt(Math.round(amount * 1e9)));
      const sim = await apiClient.simulateSwap({
        offerAddress: fromAddr,
        askAddress: toAddr,
        offerUnits,
        slippageTolerance: '0.01',
      });
      const outAmount = (Number(sim.askUnits) / 1e9).toFixed(6);
      return JSON.stringify({
        from: fromToken,
        to: toToken,
        input_amount: amount,
        output_amount: outAmount,
        swap_rate: sim.swapRate,
        price_impact: sim.priceImpact,
        min_received: (Number(sim.minAskUnits) / 1e9).toFixed(6),
      });
    } catch (e) {
      return `Error getting swap quote: ${e.message}`;
    }
  }

  if (name === 'execute_swap') {
    try {
      const { fromToken, toToken, amount, userJid } = input;
      const walletData = await getWhatsAppWallet(userJid);
      if (!walletData) return 'No wallet found for this user.';
      const mnemonic = decrypt(walletData.encrypted_mnemonic).split(' ');
      const keyPair = await mnemonicToPrivateKey(mnemonic);
      const wallet = WalletContractV4.create({ workchain: 0, publicKey: keyPair.publicKey });
      const contract = tonClient.open(wallet);
      const resolveAddr = async (sym) => {
        if (sym.toUpperCase() === 'TON') return TON_NATIVE;
        if (/^[EUkf][Q_A-Za-z0-9\-]{46,48}$/.test(sym)) return sym;
        const results = await apiClient.queryAssets({ searchString: sym, limit: 5 });
        const match = results.find(a => a.symbol?.toUpperCase() === sym.toUpperCase()) || results[0];
        if (!match) throw new Error(`Token "${sym}" not found`);
        return match.contractAddress;
      };
      const [fromAddr, toAddr] = await Promise.all([resolveAddr(fromToken), resolveAddr(toToken)]);
      const offerUnits = String(BigInt(Math.round(amount * 1e9)));
      const sim = await apiClient.simulateSwap({ offerAddress: fromAddr, askAddress: toAddr, offerUnits, slippageTolerance: '0.01' });
      if (!sim.askUnits) throw new Error('No liquidity for this pair');
      const router = tonClient.open(new DEX.v1.Router());
      const proxyTon = new pTON.v1();
      const isTon = fromAddr === TON_NATIVE;
      const isTonAsk = toAddr === TON_NATIVE;
      let txParams;
      if (isTon) txParams = await router.getSwapTonToJettonTxParams({ userWalletAddress: wallet.address.toString(), proxyTon, offerAmount: BigInt(offerUnits), askJettonAddress: toAddr, minAskAmount: BigInt(sim.minAskUnits), queryId: Date.now() });
      else if (isTonAsk) txParams = await router.getSwapJettonToTonTxParams({ userWalletAddress: wallet.address.toString(), offerJettonAddress: fromAddr, offerAmount: BigInt(offerUnits), proxyTon, minAskAmount: BigInt(sim.minAskUnits), queryId: Date.now() });
      else txParams = await router.getSwapJettonToJettonTxParams({ userWalletAddress: wallet.address.toString(), offerJettonAddress: fromAddr, offerAmount: BigInt(offerUnits), askJettonAddress: toAddr, minAskAmount: BigInt(sim.minAskUnits), queryId: Date.now() });
      const seqno = await contract.getSeqno();
      await contract.sendTransfer({ seqno, secretKey: keyPair.secretKey, messages: [internal({ to: txParams.to, value: txParams.value, body: txParams.body })] });
      return JSON.stringify({ success: true, swapped: amount, from: fromToken, to: toToken, expected_out: (Number(sim.askUnits) / 1e9).toFixed(6) });
    } catch (e) { return `Swap failed: ${e.message}`; }
  }

  if (name === 'place_limit_order') {
    try {
      const { fromToken, toToken, amount, targetPrice, direction, userJid } = input;
      const walletData = await getWhatsAppWallet(userJid);
      if (!walletData) return 'No wallet found.';
      const { data, error } = await supabase.from('limit_orders').insert({
        user_wallet: `wa:${userJid}`, agent_wallet: walletData.agent_address,
        token_in: fromToken, token_out: toToken, token_in_symbol: fromToken, token_out_symbol: toToken,
        amount: parseFloat(amount), target_price: parseFloat(targetPrice), direction, status: 'pending',
        created_at: new Date().toISOString(),
      }).select().single();
      if (error) throw new Error(error.message);
      return JSON.stringify({ success: true, order_id: data.id, message: `Limit order placed! Will ${direction} ${amount} ${fromToken} when price hits ${targetPrice}` });
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

  if (!conversationHistory.has(userJid)) conversationHistory.set(userJid, []);
  const history = conversationHistory.get(userJid);

  history.push({ role: 'user', content: input });

  // Keep last 10 messages to avoid token bloat
  if (history.length > 10) history.splice(0, history.length - 10);

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
    return { text: reply };
  } catch (e) {
    console.error('Claude error:', e.message, e.status, JSON.stringify(e.error || ''));
    return { text: '❌ Something went wrong on my end. Try again in a moment.' };
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

  const creds = (await readData('creds')) || initAuthCreds();
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
      console.log(`WhatsApp closed (${code})`);
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

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const msg of messages) {
      if (msg.key.fromMe || !msg.message) continue;
      const jid = msg.key.remoteJid;
      if (!jid) continue;
      const text = msg.message?.conversation ||
                   msg.message?.extendedTextMessage?.text || '';
      if (!text.trim()) continue;
      console.log(`💬 ${jid}: ${text}`);
      try {
        const response = await handleWhatsAppUserInput(text, jid);
        const sent = await sock.sendMessage(jid, { text: response.text });
        if (response.pin && sent?.key) {
          try {
            await sock.pinMessage(jid, sent.key, 1);
          } catch (e) {
            console.log('Pin not supported:', e.message);
          }
        }
      } catch (e) {
        console.error('Handler error:', e.message);
        await sock.sendMessage(jid, { text: '❌ Something went wrong. Try again.' });
      }
    }
  });
}

startWhatsApp().catch(console.error);

