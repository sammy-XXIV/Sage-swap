import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import { mnemonicToPrivateKey, mnemonicNew } from '@ton/crypto';
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


// ── WHATSAPP WEBHOOK ──────────────────────────────────────

const WHATSAPP_TOKEN = process.env.WHATSAPP_ACCESS_TOKEN || '';
const PHONE_NUMBER_ID = process.env.WHATSAPP_PHONE_NUMBER_ID || '';
const WEBHOOK_VERIFY_TOKEN = process.env.WHATSAPP_WEBHOOK_VERIFY_TOKEN || 'sage_webhook_secret_123';

// Webhook verification (GET)
app.get('/webhook/whatsapp', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode === 'subscribe' && token === WEBHOOK_VERIFY_TOKEN) {
    console.log('✅ WhatsApp webhook verified');
    res.status(200).send(challenge);
  } else {
    console.log('❌ WhatsApp webhook verification failed');
    res.status(403).json({ ok: false, error: 'Verification failed' });
  }
});

// Send WhatsApp message
async function sendWhatsAppMessage(recipientPhone, message, buttons = null) {
  try {
    const url = `https://graph.instagram.com/v18.0/${PHONE_NUMBER_ID}/messages`;
    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: recipientPhone.replace(/\D/g, ''),
      type: buttons ? 'interactive' : 'text',
    };

    if (buttons) {
      payload.interactive = {
        type: 'button',
        body: { text: message },
        action: {
          buttons: buttons.map((btn, i) => ({
            type: 'reply',
            reply: { id: `btn_${i}`, title: btn.label },
          })),
        },
      };
    } else {
      payload.text = { body: message };
    }

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${WHATSAPP_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error?.message || 'Failed to send');
    console.log(`📤 WhatsApp message sent to ${recipientPhone}`);
    return data;
  } catch (e) {
    console.error('❌ WhatsApp send error:', e.message);
    throw e;
  }
}

// Webhook message receiver (POST)
app.post('/webhook/whatsapp', async (req, res) => {
  try {
    const body = req.body;

    if (!body.object || body.object !== 'whatsapp_business_account') {
      return res.status(400).json({ ok: false, error: 'Invalid webhook object' });
    }

    const changes = body.entry?.[0]?.changes?.[0];
    if (!changes) return res.status(200).json({ ok: true });

    const messages = changes.value?.messages || [];
    const statuses = changes.value?.statuses || [];

    // Handle message delivery/read status
    for (const status of statuses) {
      console.log(`📊 Message ${status.id} status: ${status.status}`);
    }

    // Handle incoming messages
    for (const message of messages) {
      const senderPhone = message.from;
      const msgType = message.type;
      let userInput = '';

      if (msgType === 'text') {
        userInput = message.text?.body || '';
      } else if (msgType === 'button') {
        userInput = message.button?.text || '';
      } else {
        // Handle other types (image, document, etc.)
        console.log(`📎 Received ${msgType} from ${senderPhone}`);
        await sendWhatsAppMessage(senderPhone, `Thanks for the ${msgType}! I currently support text commands.`);
        continue;
      }

      console.log(`💬 Message from ${senderPhone}: ${userInput}`);

      // Process user input (integrate with Claude AI or your logic)
      const response = await handleWhatsAppUserInput(userInput, senderPhone);

      // Send response with buttons
      await sendWhatsAppMessage(senderPhone, response.text, response.buttons);
    }

    res.status(200).json({ ok: true });
  } catch (e) {
    console.error('Webhook error:', e.message);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Handle user input (TODO: integrate with Claude AI)
async function handleWhatsAppUserInput(input, userPhone) {
  const trimmed = input.trim().toLowerCase();

  // Check if it's a contract address (CA)
  if (trimmed.match(/^[EUkf][Q_A-Za-z0-9\-]{46,48}$/)) {
    // Looks like a TON address
    return {
      text: `🔍 Looking up token CA: ${trimmed}\n\n⏳ This feature is coming soon!`,
      buttons: [
        { label: '🔄 Refresh' },
        { label: '⬅️ Back' },
      ],
    };
  }

  // Default response with menu
  return {
    text: 'Welcome to SAGE! 🤖\n\nWhat would you like to do?',
    buttons: [
      { label: '🔄 Swap Tokens' },
      { label: '📊 Portfolio' },
      { label: '⏱️ Limit Orders' },
      { label: '💰 Stake' },
    ],
  };
}

