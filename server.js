import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import makeWASocket, { DisconnectReason, useMultiFileAuthState, fetchLatestBaileysVersion } from '@whiskeysockets/baileys';
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
const userSessions = new Map();

// Visit /qr in browser to scan and connect WhatsApp
app.get('/qr', (req, res) => {
  if (waConnected) {
    return res.send('<html><body style="text-align:center;font-family:sans-serif;padding:40px;background:#0a0a0a;color:#fff"><h1>✅ SAGE is connected to WhatsApp!</h1><p>The bot is active and ready.</p></body></html>');
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
        text: `✅ *Wallet imported successfully!*\n\n` +
              `📬 Your TON address:\n\`${address}\`\n\n` +
              `You're all set! Ask me anything — swap tokens, check prices, set limit orders, and more.\n\n` +
              `What would you like to do?`
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
        text: `✅ *Wallet created!*\n\n` +
              `📬 Your TON address:\n\`${address}\`\n\n` +
              `🔑 *Seed phrase (save this somewhere safe — screenshot it now):*\n\n` +
              `${mnemonic.join(' ')}\n\n` +
              `⚠️ Anyone with these words can access your wallet. Never share them.\n\n` +
              `You're all set! What would you like to do?`
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

const SAGE_SYSTEM_PROMPT = `You are SAGE, a friendly and knowledgeable DeFi assistant running on WhatsApp for the TON blockchain. You help users with token lookups, swaps, staking, limit orders, and general DeFi questions.

You have access to these tools:
- lookup_token: fetch live price and info for a TON token by symbol or contract address
- get_swap_quote: simulate a swap between two tokens to show rates

Personality: concise, helpful, no fluff. Use WhatsApp formatting (*bold*, _italic_). Keep replies short — this is a chat, not a document. Use emojis sparingly but naturally.

Capabilities:
- Token price lookup by symbol (e.g. "price of STON") or by pasting a contract address
- Swap quotes (e.g. "how much USDT do I get for 5 TON?")
- Limit orders: users can set a target price to auto-buy or auto-sell (backend handles execution)
- Staking: TON Stakers pool, ~5.2% APY
- General TON/DeFi education

If a user asks to actually execute a swap or place a limit order, explain that they need to connect their wallet through the SAGE mini app, and that the WhatsApp bot handles info and monitoring.`;

const sageTools = [
  {
    name: 'lookup_token',
    description: 'Look up a TON token by symbol or contract address. Returns price, TVL, and contract address.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Token symbol (e.g. STON, USDT) or full contract address' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_swap_quote',
    description: 'Get a swap quote between two tokens. Returns expected output amount and price impact.',
    input_schema: {
      type: 'object',
      properties: {
        fromToken: { type: 'string', description: 'Symbol or address of token to swap from (use "TON" for native TON)' },
        toToken: { type: 'string', description: 'Symbol or address of token to swap to (use "TON" for native TON)' },
        amount: { type: 'number', description: 'Amount of fromToken to swap' },
      },
      required: ['fromToken', 'toToken', 'amount'],
    },
  },
];

async function runSageTool(name, input) {
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

  if (!conversationHistory.has(userJid)) conversationHistory.set(userJid, []);
  const history = conversationHistory.get(userJid);

  history.push({ role: 'user', content: input });

  // Keep last 10 messages to avoid token bloat
  if (history.length > 10) history.splice(0, history.length - 10);

  try {
    const systemWithWallet = `${SAGE_SYSTEM_PROMPT}\n\nThis user's TON wallet address: ${walletRecord.agent_address}`;

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
    console.error('Claude error:', e.message);
    return { text: '❌ Something went wrong on my end. Try again in a moment.' };
  }
}

async function startWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('./auth_info_baileys');
  const { version } = await fetchLatestBaileysVersion();

  const sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: true,
    logger: Pino({ level: 'silent' }),
    browser: ['SAGE Bot', 'Chrome', '120.0.0'],
  });

  waSocket = sock;
  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      try {
        currentQR = await QRCode.toDataURL(qr);
        waConnected = false;
        console.log('📱 QR ready — visit /qr to scan');
      } catch (e) { console.error('QR error:', e.message); }
    }

    if (connection === 'close') {
      waConnected = false;
      currentQR = null;
      const code = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = code !== DisconnectReason.loggedOut;
      console.log(`WhatsApp closed (${code}), reconnect: ${shouldReconnect}`);
      if (shouldReconnect) setTimeout(startWhatsApp, 5000);
    } else if (connection === 'open') {
      waConnected = true;
      currentQR = null;
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
        await sendWhatsAppMessage(jid, response.text);
      } catch (e) {
        console.error('Handler error:', e.message);
        await sendWhatsAppMessage(jid, '❌ Something went wrong. Try again.');
      }
    }
  });
}

startWhatsApp().catch(console.error);

