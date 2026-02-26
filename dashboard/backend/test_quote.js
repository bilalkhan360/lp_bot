import './polyfill.js';
import { createPublicClient, http, encodeFunctionData, decodeFunctionResult } from 'viem';
import { base } from 'viem/chains';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '../../.env') });
dotenv.config({ path: join(__dirname, '../.env'), override: true });

const RPC_URL = process.env.BASE_RPC_URL || 'https://mainnet.base.org';

const client = createPublicClient({
  chain: base,
  transport: http(RPC_URL, { timeout: 30_000 }),
});

const POOL   = '0xb30540172F1B37d1eE1d109e49F883E935E69219';
const QUOTER = '0x3d4C22254F86f64B7eC90ab8F7aeC1FBFD271c6C';
const SOL    = '0x311935Cd80B76769bF2ecC9D8Ab7635b2139cf82';
const USDC   = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

const SOL_DECIMALS  = 9;
const USDC_DECIMALS = 6;
const CHAIN_ID      = 8453; // Base

const SHARED_ABI = [
  { name: 'token0',      outputs: [{ type: 'address' }], stateMutability: 'view', type: 'function', inputs: [] },
  { name: 'token1',      outputs: [{ type: 'address' }], stateMutability: 'view', type: 'function', inputs: [] },
  { name: 'tickSpacing', outputs: [{ type: 'int24'   }], stateMutability: 'view', type: 'function', inputs: [] },
  { name: 'factory',     outputs: [{ type: 'address' }], stateMutability: 'view', type: 'function', inputs: [] },
];

const QUOTER_ABI = [{
  name: 'quoteExactInputSingle',
  type: 'function',
  stateMutability: 'nonpayable',
  inputs: [{
    name: 'params',
    type: 'tuple',
    components: [
      { name: 'tokenIn',           type: 'address' },
      { name: 'tokenOut',          type: 'address' },
      { name: 'amountIn',          type: 'uint256' },
      { name: 'tickSpacing',       type: 'int24'   },
      { name: 'sqrtPriceLimitX96', type: 'uint160' },
    ],
  }],
  outputs: [
    { name: 'amountOut',               type: 'uint256' },
    { name: 'sqrtPriceX96After',       type: 'uint160' },
    { name: 'initializedTicksCrossed', type: 'uint32'  },
    { name: 'gasEstimate',             type: 'uint256' },
  ],
}];

// ── Aerodrome on-chain quote ──────────────────────────────────────────────────
async function quoteAerodrome(amountIn) {
  const tickSpacing = await client.readContract({
    address: POOL, abi: SHARED_ABI, functionName: 'tickSpacing',
  });

  const callData = encodeFunctionData({
    abi: QUOTER_ABI,
    functionName: 'quoteExactInputSingle',
    args: [{ tokenIn: SOL, tokenOut: USDC, amountIn, tickSpacing, sqrtPriceLimitX96: 0n }],
  });

  const raw = await client.call({ to: QUOTER, data: callData });

  const [amountOut, , ticksCrossed, gasEstimate] = decodeFunctionResult({
    abi: QUOTER_ABI,
    functionName: 'quoteExactInputSingle',
    data: raw.data,
  });

  return {
    amountOut: Number(amountOut) / 10 ** USDC_DECIMALS,
    ticksCrossed,
    gasEstimate: Number(gasEstimate),
  };
}

// ── Odos v3 quote ─────────────────────────────────────────────────────────────
async function quoteOdos(amountIn) {
  const res = await fetch('https://api.odos.xyz/sor/quote/v3', {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chainId:            CHAIN_ID,
      inputTokens:        [{ tokenAddress: SOL,  amount: amountIn.toString() }],
      outputTokens:       [{ tokenAddress: USDC, proportion: 1 }],
      slippageLimitPercent: 0.5,
      userAddr:           '0x0000000000000000000000000000000000000001',
      compact:            true,
    }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Odos v3 HTTP ${res.status}: ${text}`);
  }

  const data = await res.json();
  console.log('\n[Odos raw response]', JSON.stringify(data, null, 2));

  const amountOut = Number(data.outAmounts?.[0]) / 10 ** USDC_DECIMALS;
  return {
    amountOut,
    priceImpact:  data.priceImpact,
    percentDiff:  data.percentDiff,
    gasEstimate:  data.gasEstimate,
    pathId:       data.pathId,
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  const amountIn = 10n ** BigInt(SOL_DECIMALS); // 1 SOL
  console.log(`Quoting 1 SOL (${amountIn}) → USDC on Base...\n`);

  const [aero, odos] = await Promise.allSettled([
    quoteAerodrome(amountIn),
    quoteOdos(amountIn),
  ]);

  console.log('\n════════════════════════════════');
  console.log('       QUOTE COMPARISON         ');
  console.log('════════════════════════════════');

  if (aero.status === 'fulfilled') {
    const a = aero.value;
    console.log(`Aerodrome (direct): ${a.amountOut.toFixed(4)} USDC`);
    console.log(`  ticks crossed:    ${a.ticksCrossed}`);
    console.log(`  gas estimate:     ${a.gasEstimate.toLocaleString()}`);
  } else {
    console.log(`Aerodrome: FAILED — ${aero.reason.message}`);
  }

  console.log('');

  if (odos.status === 'fulfilled') {
    const o = odos.value;
    console.log(`Odos v3:            ${o.amountOut.toFixed(4)} USDC`);
    console.log(`  price impact:     ${o.priceImpact}%`);
    console.log(`  vs reference:     ${o.percentDiff}%`);
    console.log(`  gas estimate:     ${o.gasEstimate?.toLocaleString()}`);
  } else {
    console.log(`Odos v3: FAILED — ${odos.reason.message}`);
  }

  if (aero.status === 'fulfilled' && odos.status === 'fulfilled') {
    const diff = odos.value.amountOut - aero.value.amountOut;
    const pct  = (diff / aero.value.amountOut * 100).toFixed(4);
    console.log('');
    console.log(`Difference: Odos gives ${diff >= 0 ? '+' : ''}${diff.toFixed(4)} USDC (${pct}%) vs Aerodrome direct`);
  }

  console.log('════════════════════════════════');
}

main().catch(console.error);
