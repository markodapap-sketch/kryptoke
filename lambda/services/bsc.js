const { ethers } = require('ethers');

const BSC_RPC = process.env.BSC_RPC_URL || 'https://bsc-dataseed1.binance.org';

// ── Contracts ────────────────────────────────────────────────────────────────
const PANCAKE_ROUTER_V2   = '0x10ED43C718714eb63d5aA57B78B54704E256024E';
const PANCAKE_FACTORY_V2  = '0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73';
const PANCAKE_FACTORY_V3  = '0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865';
const BISWAP_ROUTER       = '0x3a6d8cA21D1CF76F653A67577FA0D27453350dD8';
const BISWAP_FACTORY      = '0x858E3312ed3A876947EA49d572A7C42DE08af7EE';
const WBNB  = '0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c';
const BUSD  = '0xe9e7CEA3DedcA5984780Bafc599bD69ADd087D56';
const USDT  = '0x55d398326f99059fF775485246999027B3197955';

// ── ABIs ─────────────────────────────────────────────────────────────────────
const ERC20_ABI = [
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
];
const PAIR_ABI = [
  'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
];
const FACTORY_ABI = [
  'function getPair(address tokenA, address tokenB) view returns (address pair)',
];
const ROUTER_ABI = [
  'function getAmountsOut(uint amountIn, address[] memory path) view returns (uint[] memory amounts)',
  'function swapExactTokensForTokens(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) returns (uint[] memory amounts)',
  'function swapExactETHForTokens(uint amountOutMin, address[] calldata path, address to, uint deadline) payable returns (uint[] memory amounts)',
  'function swapExactTokensForETH(uint amountIn, uint amountOutMin, address[] calldata path, address to, uint deadline) returns (uint[] memory amounts)',
];

function getProvider() {
  return new ethers.JsonRpcProvider(BSC_RPC);
}

// ── Token info ────────────────────────────────────────────────────────────────
async function getTokenInfo(tokenAddress) {
  try {
    const provider = getProvider();
    const contract = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
    const [name, symbol, decimals, totalSupply] = await Promise.all([
      contract.name(), contract.symbol(), contract.decimals(), contract.totalSupply(),
    ]);
    return {
      address: tokenAddress, name, symbol,
      decimals: Number(decimals),
      totalSupply: ethers.formatUnits(totalSupply, decimals),
    };
  } catch (e) {
    throw new Error(`Failed to fetch token info: ${e.message}`);
  }
}

// ── Price from a V2-style factory/router pair ─────────────────────────────────
async function priceFromV2Factory(factoryAddress, tokenAddress, stableAddress, provider) {
  const factory = new ethers.Contract(factoryAddress, FACTORY_ABI, provider);
  const pairAddress = await factory.getPair(tokenAddress, stableAddress);
  if (pairAddress === ethers.ZeroAddress) return null;

  const pair = new ethers.Contract(pairAddress, PAIR_ABI, provider);
  const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
  const stableContract = new ethers.Contract(stableAddress, ERC20_ABI, provider);

  const [reserves, token0, tokenDecimals, stableDecimals] = await Promise.all([
    pair.getReserves(), pair.token0(), tokenContract.decimals(), stableContract.decimals(),
  ]);

  const isToken0 = token0.toLowerCase() === tokenAddress.toLowerCase();
  const tokenReserve  = isToken0 ? reserves[0] : reserves[1];
  const stableReserve = isToken0 ? reserves[1] : reserves[0];

  const tRes = Number(ethers.formatUnits(tokenReserve, tokenDecimals));
  const sRes = Number(ethers.formatUnits(stableReserve, stableDecimals));
  if (tRes === 0) return null;

  return {
    price: sRes / tRes,
    liquidity: sRes * 2,
    pairAddress,
  };
}

// ── Aggregated price: best of PancakeSwap V2, BiSwap ─────────────────────────
async function getTokenPrice(tokenAddress) {
  try {
    const provider = getProvider();
    const stables = [BUSD, USDT];
    const factories = [
      { name: 'PancakeSwap V2', address: PANCAKE_FACTORY_V2 },
      { name: 'BiSwap',         address: BISWAP_FACTORY },
    ];

    const results = await Promise.allSettled(
      factories.flatMap(f => stables.map(s => priceFromV2Factory(f.address, tokenAddress, s, provider)))
    );

    const valid = results
      .filter(r => r.status === 'fulfilled' && r.value?.price)
      .map(r => r.value);

    if (valid.length > 0) {
      // Weighted average by liquidity
      const totalLiq = valid.reduce((a, b) => a + b.liquidity, 0);
      const weightedPrice = valid.reduce((a, b) => a + b.price * (b.liquidity / totalLiq), 0);
      const bestLiq = Math.max(...valid.map(v => v.liquidity));
      return { price: weightedPrice, liquidity: bestLiq, sources: valid.length };
    }

    // Fallback: BNB pair on PancakeSwap V2
    const factory = new ethers.Contract(PANCAKE_FACTORY_V2, FACTORY_ABI, provider);
    const bnbPair = await factory.getPair(tokenAddress, WBNB);
    if (bnbPair !== ethers.ZeroAddress) {
      const bnbPrice = await getBNBPrice();
      const pair = new ethers.Contract(bnbPair, PAIR_ABI, provider);
      const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
      const [reserves, token0, decimals] = await Promise.all([
        pair.getReserves(), pair.token0(), tokenContract.decimals(),
      ]);
      const isToken0 = token0.toLowerCase() === tokenAddress.toLowerCase();
      const tokenReserve = isToken0 ? reserves[0] : reserves[1];
      const bnbReserve   = isToken0 ? reserves[1] : reserves[0];
      const tokenPerBnb  = Number(ethers.formatUnits(tokenReserve, decimals)) / Number(ethers.formatEther(bnbReserve));
      const price = bnbPrice / tokenPerBnb;
      const liquidity = Number(ethers.formatEther(bnbReserve)) * bnbPrice * 2;
      return { price, liquidity, sources: 1 };
    }

    return { price: 0, liquidity: 0, sources: 0 };
  } catch (e) {
    console.error('Price fetch error:', e.message);
    return { price: 0, liquidity: 0, sources: 0 };
  }
}

// ── BNB price from BUSD pair ──────────────────────────────────────────────────
async function getBNBPrice() {
  try {
    const provider = getProvider();
    const factory = new ethers.Contract(PANCAKE_FACTORY_V2, FACTORY_ABI, provider);
    const pairAddr = await factory.getPair(WBNB, BUSD);
    const pair = new ethers.Contract(pairAddr, PAIR_ABI, provider);
    const [reserves, token0] = await Promise.all([pair.getReserves(), pair.token0()]);
    const isBNBToken0 = token0.toLowerCase() === WBNB.toLowerCase();
    const bnbReserve  = isBNBToken0 ? reserves[0] : reserves[1];
    const busdReserve = isBNBToken0 ? reserves[1] : reserves[0];
    return Number(ethers.formatUnits(busdReserve, 18)) / Number(ethers.formatEther(bnbReserve));
  } catch {
    return 600;
  }
}

// ── Quote: best route across PancakeSwap V2 + BiSwap ─────────────────────────
async function getQuote(tokenIn, tokenOut, amountIn, decimalsIn) {
  try {
    const provider = getProvider();
    const amountInWei = ethers.parseUnits(String(amountIn), decimalsIn);

    const routers = [
      { name: 'PancakeSwap V2', address: PANCAKE_ROUTER_V2 },
      { name: 'BiSwap',         address: BISWAP_ROUTER },
    ];
    const paths = [
      [tokenIn, tokenOut],
      [tokenIn, WBNB, tokenOut],
      [tokenIn, BUSD, tokenOut],
      [tokenIn, USDT, tokenOut],
    ];

    let bestAmount = BigInt(0);
    let bestPath   = null;
    let bestRouter = PANCAKE_ROUTER_V2;
    let bestDex    = 'PancakeSwap V2';

    const tokenOutContract = new ethers.Contract(tokenOut, ERC20_ABI, provider);
    const decimalsOut = await tokenOutContract.decimals();

    await Promise.allSettled(
      routers.flatMap(router =>
        paths.map(async path => {
          try {
            const contract = new ethers.Contract(router.address, ROUTER_ABI, provider);
            const amounts = await contract.getAmountsOut(amountInWei, path);
            const out = amounts[amounts.length - 1];
            if (out > bestAmount) {
              bestAmount = out;
              bestPath   = path;
              bestRouter = router.address;
              bestDex    = router.name;
            }
          } catch {}
        })
      )
    );

    if (!bestPath) throw new Error('No liquidity path found');

    return {
      amountOut: ethers.formatUnits(bestAmount, decimalsOut),
      path: bestPath,
      routerAddress: bestRouter,
      dex: bestDex,
      priceImpact: 0,
    };
  } catch (e) {
    throw new Error(`Quote failed: ${e.message}`);
  }
}

// ── Build swap tx ─────────────────────────────────────────────────────────────
async function buildSwapTx({ tokenIn, tokenOut, amountIn, decimalsIn, slippage = 0.5, userAddress }) {
  const { amountOut, path, routerAddress, dex } = await getQuote(tokenIn, tokenOut, amountIn, decimalsIn);
  const minOut = parseFloat(amountOut) * (1 - slippage / 100);
  const provider = getProvider();
  const tokenOutContract = new ethers.Contract(tokenOut, ERC20_ABI, provider);
  const decimalsOut = await tokenOutContract.decimals();
  const deadline = Math.floor(Date.now() / 1000) + 300;
  const iface = new ethers.Interface(ROUTER_ABI);
  let data;

  const minOutWei = ethers.parseUnits(minOut.toFixed(Number(decimalsOut)), decimalsOut);

  if (tokenIn === WBNB || tokenIn === ethers.ZeroAddress) {
    data = iface.encodeFunctionData('swapExactETHForTokens', [minOutWei, path, userAddress, deadline]);
  } else if (tokenOut === WBNB || tokenOut === ethers.ZeroAddress) {
    data = iface.encodeFunctionData('swapExactTokensForETH', [
      ethers.parseUnits(String(amountIn), decimalsIn), minOutWei, path, userAddress, deadline,
    ]);
  } else {
    data = iface.encodeFunctionData('swapExactTokensForTokens', [
      ethers.parseUnits(String(amountIn), decimalsIn), minOutWei, path, userAddress, deadline,
    ]);
  }

  return {
    to: routerAddress,
    data,
    value: tokenIn === WBNB ? ethers.parseUnits(String(amountIn), decimalsIn).toString() : '0',
    gasLimit: '300000',
    chainId: 56,
    amountOut,
    minOut: minOut.toFixed(8),
    path,
    dex,
  };
}

// ── Wallet balance ────────────────────────────────────────────────────────────
async function getWalletBalance(address, tokenAddress) {
  const provider = getProvider();
  if (!tokenAddress || tokenAddress === 'BNB') {
    return ethers.formatEther(await provider.getBalance(address));
  }
  const contract = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
  const [bal, decimals] = await Promise.all([contract.balanceOf(address), contract.decimals()]);
  return ethers.formatUnits(bal, decimals);
}

// ── HD Wallet: derive user deposit address from master seed ───────────────────
// Master seed stored in MASTER_SEED env var (BIP-39 mnemonic, 24 words)
// Each user gets index-derived address. index stored in Firestore user.hdIndex

function deriveUserWallet(hdIndex) {
  const seed = process.env.MASTER_SEED;
  if (!seed) throw new Error('MASTER_SEED env var not set');
  // fromPhrase with full derivation path — avoids depth conflict
  return ethers.HDNodeWallet.fromPhrase(seed, null, `m/44'/60'/0'/0/${hdIndex}`);
}

// Generate next HD index atomically — caller must store returned index in Firestore
async function generateDepositAddress(hdIndex) {
  const wallet = deriveUserWallet(hdIndex);
  return wallet.address;
}

// ── Sweep: move funds from all user HD addresses to hot wallet ────────────────
// Hot wallet address stored in HOT_WALLET env var
// This is called by the sweep Lambda or cron endpoint

async function sweepUserFunds({ hdIndex, tokenAddress, minUsdValue = 5 }) {
  const provider = getProvider();
  const userWallet = deriveUserWallet(hdIndex).connect(provider);
  const hotWallet  = process.env.HOT_WALLET;
  if (!hotWallet) throw new Error('HOT_WALLET env var not set');

  const results = [];

  // Check BNB balance for gas
  const bnbBal = await provider.getBalance(userWallet.address);
  const gasPrice = (await provider.getFeeData()).gasPrice;
  const gasNeeded = gasPrice * 21000n;

  if (tokenAddress === 'BNB') {
    const sendable = bnbBal - gasNeeded * 2n; // leave 2x gas buffer
    if (sendable > 0n) {
      const tx = await userWallet.sendTransaction({ to: hotWallet, value: sendable });
      results.push({ token: 'BNB', txHash: tx.hash, amount: ethers.formatEther(sendable) });
    }
    return results;
  }

  // ERC-20 token sweep
  const contract = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
  const [balance, decimals] = await Promise.all([
    contract.balanceOf(userWallet.address),
    contract.decimals(),
  ]);

  if (balance === 0n) return results;

  const amount = ethers.formatUnits(balance, decimals);

  // Ensure user wallet has BNB for gas — top it up from hot wallet if needed
  if (bnbBal < gasNeeded * 3n) {
    const hotSigner = new ethers.Wallet(process.env.HOT_WALLET_KEY, provider);
    const topUp = gasNeeded * 5n; // send 5x gas worth of BNB
    const topUpTx = await hotSigner.sendTransaction({ to: userWallet.address, value: topUp });
    await topUpTx.wait();
  }

  const tokenSigner = contract.connect(userWallet);
  const transferTx = await tokenSigner.transfer(hotWallet, balance);
  results.push({ token: tokenAddress, txHash: transferTx.hash, amount });

  return results;
}

// Generate random wallet (kept for legacy use during migration)
function generateWallet() {
  const wallet = ethers.Wallet.createRandom();
  return { address: wallet.address, privateKey: wallet.privateKey, mnemonic: wallet.mnemonic?.phrase };
}

module.exports = {
  getTokenInfo,
  getTokenPrice,
  getBNBPrice,
  getQuote,
  buildSwapTx,
  getWalletBalance,
  generateWallet,
  generateDepositAddress,
  deriveUserWallet,
  sweepUserFunds,
  WBNB, BUSD, USDT,
  PANCAKE_ROUTER_V2, BISWAP_ROUTER,
};