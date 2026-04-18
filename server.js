import express from 'express';
import cors from 'cors';
import { DEX, pTON } from '@ston-fi/sdk';
import { FARM } from '@ston-fi/sdk';
import { StonApiClient } from '@ston-fi/api';
import { Client } from '@ston-fi/sdk';

const app = express();
app.use(cors());
app.use(express.json());

const apiClient = new StonApiClient();
const tonClient = new Client({ endpoint: 'https://toncenter.com/api/v2/jsonRPC' });

app.get('/ping', (req, res) => res.json({ ok: true, service: 'SAGE Swap v1' }));

// Test swap build — GET for easy browser testing
app.get('/test/swap', async (req, res) => {
  try {
    const router = tonClient.open(new DEX.v1.Router());
    const proxyTon = new pTON.v1();
    const txParams = await router.getSwapTonToJettonTxParams({
      userWalletAddress: 'UQDnWz8mfNx3NEdBWYqLLXUQ7oPp6fAg5jvs-Yt7LHUrJURh',
      proxyTon,
      offerAmount: BigInt('71000000'),
      askJettonAddress: 'EQAvlWFDxGF2lXm67y4yzC17wYKD9A0guwPkMs1gOsM__NOT',
      minAskAmount: BigInt('1'),
      queryId: 12345,
    });
    const toStr = txParams.to.toString({ bounceable: true, urlSafe: true });
    const toRaw = txParams.to.toRawString();
    res.json({
      ok: true,
      to_friendly: toStr,
      to_raw: toRaw,
      value: txParams.value.toString(),
      has_payload: !!txParams.body,
    });
  } catch(e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

app.post('/build/swap', async (req, res) => {
  try {
    const { fromToken, toToken, fromAmount, walletAddress, slippage } = req.body;
    const isTon    = !fromToken || fromToken === 'ton';
    const isTonAsk = !toToken   || toToken   === 'ton';
    const slip = parseFloat(slippage ?? 0.01);

    const TON_NATIVE = 'EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c';
    const sim = await apiClient.simulateSwap({
      offerAddress: isTon    ? TON_NATIVE : fromToken,
      askAddress:   isTonAsk ? TON_NATIVE : toToken,
      offerUnits:   String(BigInt(Math.round(parseFloat(fromAmount) * 1e9))),
      slippageTolerance: String(slip),
    });

    if (!sim.askUnits) throw new Error('No liquidity for this pair');

    const router = tonClient.open(new DEX.v1.Router());
    const proxyTon = new pTON.v1();

    let txParams;
    if (isTon) {
      txParams = await router.getSwapTonToJettonTxParams({
        userWalletAddress: walletAddress,
        proxyTon,
        offerAmount: BigInt(sim.offerUnits),
        askJettonAddress: toToken,
        minAskAmount: BigInt(sim.minAskUnits),
        queryId: Date.now(),
      });
    } else if (isTonAsk) {
      txParams = await router.getSwapJettonToTonTxParams({
        userWalletAddress: walletAddress,
        offerJettonAddress: fromToken,
        offerAmount: BigInt(sim.offerUnits),
        proxyTon,
        minAskAmount: BigInt(sim.minAskUnits),
        queryId: Date.now(),
      });
    } else {
      txParams = await router.getSwapJettonToJettonTxParams({
        userWalletAddress: walletAddress,
        offerJettonAddress: fromToken,
        offerAmount: BigInt(sim.offerUnits),
        askJettonAddress: toToken,
        minAskAmount: BigInt(sim.minAskUnits),
        queryId: Date.now(),
      });
    }

    // toString() with bounceable=true, urlSafe=true gives EQ... format
    // which is what TON Connect expects
    const toAddress = txParams.to.toString({ bounceable: true, urlSafe: true });
    const payload = txParams.body?.toBoc().toString('base64');

    res.json({
      ok: true,
      debug: { toAddress, toRaw: txParams.to.toRawString() },
      simulation: {
        offerUnits: sim.offerUnits,
        askUnits: sim.askUnits,
        minAskUnits: sim.minAskUnits,
        swapRate: sim.swapRate,
        priceImpact: sim.priceImpact,
      },
      transaction: {
        validUntil: Math.floor(Date.now() / 1000) + 300,
        messages: [{
          address: toAddress,
          amount:  txParams.value.toString(),
          payload: payload ?? '',
        }]
      }
    });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message, stack: e.stack?.split('\n').slice(0,3) });
  }
});

app.post('/search/token', async (req, res) => {
  try {
    const { symbol } = req.body;
    const assets = await apiClient.queryAssets({ searchString: symbol, limit: 10 });
    const match = assets.find(a => a.symbol?.toUpperCase() === symbol.toUpperCase() && a.dexUsdPrice && !a.blacklisted)
      || assets.find(a => a.symbol?.toUpperCase() === symbol.toUpperCase())
      || assets[0];
    if (!match) return res.status(404).json({ ok: false, error: `"${symbol}" not found` });
    res.json({ ok: true, symbol: match.symbol, address: match.contractAddress, decimals: match.decimals ?? 9, price: match.dexUsdPrice });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// ── Stake LP tokens in farm ──────────────────────────────
// farmAddress = the specific farm contract address from STON.fi API
// lpTokenAddress = the LP token jetton address for that farm
app.post('/build/stake', async (req, res) => {
  try {
    const { walletAddress, farmAddress, lpTokenAddress, lpAmount } = req.body;
    if (!walletAddress || !farmAddress || !lpTokenAddress || !lpAmount) {
      return res.status(400).json({ ok: false, error: 'Missing walletAddress, farmAddress, lpTokenAddress, or lpAmount' });
    }

    const farm = tonClient.open(FARM.v3.NftMinter.create(farmAddress));
    const stakeTxParams = await farm.getStakeTxParams({
      userWalletAddress: walletAddress,
      jettonAddress: lpTokenAddress,
      jettonAmount: BigInt(Math.round(parseFloat(lpAmount) * 1e9)),
      queryId: Date.now(),
    });

    res.json({
      ok: true,
      transaction: {
        validUntil: Math.floor(Date.now() / 1000) + 300,
        messages: [{
          address: stakeTxParams.to.toString({ bounceable: true, urlSafe: true }),
          amount:  stakeTxParams.value.toString(),
          payload: stakeTxParams.body?.toBoc().toString('base64') ?? '',
        }]
      }
    });
  } catch(e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// ── Get available farms ───────────────────────────────────
app.get('/farms', async (req, res) => {
  try {
    const farms = await apiClient.getFarms();
    res.json({ ok: true, farms: farms.slice(0, 20).map(f => ({
      address: f.address,
      poolAddress: f.poolAddress,
      apr: f.apr,
      tvl: f.tvl,
      rewardToken: f.rewardTokenSymbol,
      lpToken: f.lpTokenAddress,
      name: f.poolName,
    }))});
  } catch(e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

// ── Add Liquidity ─────────────────────────────────────────
app.post('/build/liquidity', async (req, res) => {
  try {
    const { tokenA, tokenB, amountA, walletAddress } = req.body;
    const isTonA = !tokenA || tokenA === 'ton';

    const sim = await apiClient.simulateLiquidityProvision({
      provisionType: 'Balanced',
      tokenA: isTonA ? 'EQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAM9c' : tokenA,
      tokenB,
      tokenAUnits: String(BigInt(Math.round(parseFloat(amountA) * 1e9))),
      slippageTolerance: '0.01',
    });

    const routerInfo = sim.router || await apiClient.getRouter(sim.routerAddress);
    const dex = DEX.v1;
    const router = tonClient.open(new dex.Router());
    const proxyTon = new pTON.v1();

    let txParams;
    if (isTonA) {
      txParams = await router.getProvideLiquidityTonTxParams({
        userWalletAddress: walletAddress,
        proxyTon,
        otherTokenAddress: tokenB,
        sendAmount: BigInt(sim.tokenAUnits || Math.round(parseFloat(amountA) * 1e9)),
        minLpOut: BigInt(sim.minLpOut || '1'),
        queryId: Date.now(),
      });
    } else {
      txParams = await router.getProvideLiquidityJettonTxParams({
        userWalletAddress: walletAddress,
        sendTokenAddress: tokenA,
        sendAmount: BigInt(sim.tokenAUnits || Math.round(parseFloat(amountA) * 1e9)),
        otherTokenAddress: tokenB,
        minLpOut: BigInt(sim.minLpOut || '1'),
        queryId: Date.now(),
      });
    }

    res.json({
      ok: true,
      simulation: sim,
      transaction: {
        validUntil: Math.floor(Date.now() / 1000) + 300,
        messages: [{
          address: txParams.to.toString({ bounceable: true, urlSafe: true }),
          amount: txParams.value.toString(),
          payload: txParams.body?.toBoc().toString('base64') ?? '',
        }]
      }
    });
  } catch(e) {
    res.status(400).json({ ok: false, error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`SAGE Swap on port ${PORT}`));
