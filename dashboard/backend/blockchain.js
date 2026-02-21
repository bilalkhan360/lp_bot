import './polyfill.js';
import { createPublicClient, http, formatUnits, isAddress } from 'viem';
import { base } from 'viem/chains';
import db from './db.js';
import { fetchPrices } from './priceService.js';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '../../.env') });
dotenv.config({ path: join(__dirname, '../.env'), override: true });

const RPC_URL = process.env.BASE_RPC_URL || 'https://mainnet.base.org';
export const WALLET_ADDRESS = process.env.WALLET_ADDRESS;

const client = createPublicClient({
  chain: base,
  transport: http(RPC_URL, { timeout: 30_000 }),
});

// ── Contract addresses (mirrors src/config.js) ───────────────────────────────

// Bot only uses PositionManager for reading position data
const POSITION_MANAGER = '0xa990C6a764b73BF43cee5Bb40339c3322FB9D55F';

// Multiple factories to try (from src/monitor.js findPool logic)
const FACTORIES = [
  '0xaDe65c38CD4849aDBA595a4323a8C7DdfE89716a',
  '0x420DD381b31aEf6683db6B902084cB0FFECe40Da',
];

// Fee tiers to try when finding a pool (from src/monitor.js)
const FEE_TIERS = [10, 20, 35, 40, 100, 500, 3000, 10000];

const GAUGES    = ['0xC6e211fF1D04A1728ab011406AD42EF529Cb3886'];
const ZERO_ADDR = '0x0000000000000000000000000000000000000000';

// ── ABIs ─────────────────────────────────────────────────────────────────────

const POSITION_MANAGER_ABI = [
  {
    inputs: [{ name: 'owner', type: 'address' }],
    name: 'balanceOf',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ name: 'owner', type: 'address' }, { name: 'index', type: 'uint256' }],
    name: 'tokenOfOwnerByIndex',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [{ name: 'tokenId', type: 'uint256' }],
    name: 'positions',
    outputs: [
      { name: 'nonce',                    type: 'uint96'  },
      { name: 'operator',                 type: 'address' },
      { name: 'token0',                   type: 'address' },
      { name: 'token1',                   type: 'address' },
      { name: 'tickSpacing',              type: 'int24'   },
      { name: 'tickLower',                type: 'int24'   },
      { name: 'tickUpper',                type: 'int24'   },
      { name: 'liquidity',                type: 'uint128' },
      { name: 'feeGrowthInside0LastX128', type: 'uint256' },
      { name: 'feeGrowthInside1LastX128', type: 'uint256' },
      { name: 'tokensOwed0',              type: 'uint128' },
      { name: 'tokensOwed1',              type: 'uint128' },
    ],
    stateMutability: 'view',
    type: 'function',
  },
];

const ERC20_ABI = [
  {
    inputs: [],
    name: 'symbol',
    outputs: [{ name: '', type: 'string' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'decimals',
    outputs: [{ name: '', type: 'uint8' }],
    stateMutability: 'view',
    type: 'function',
  },
];

// Factory uses uint24 fee (NOT int24 tickSpacing) for getPool
const FACTORY_ABI = [
  {
    inputs: [
      { name: 'tokenA', type: 'address' },
      { name: 'tokenB', type: 'address' },
      { name: 'fee',    type: 'uint24'  },
    ],
    name: 'getPool',
    outputs: [{ name: '', type: 'address' }],
    stateMutability: 'view',
    type: 'function',
  },
];

// Aerodrome pool slot0 has 6 return values (no feeProtocol field)
const POOL_ABI = [
  {
    inputs: [],
    name: 'slot0',
    outputs: [
      { name: 'sqrtPriceX96',              type: 'uint160' },
      { name: 'tick',                       type: 'int24'   },
      { name: 'observationIndex',           type: 'uint16'  },
      { name: 'observationCardinality',     type: 'uint16'  },
      { name: 'observationCardinalityNext', type: 'uint16'  },
      { name: 'unlocked',                   type: 'bool'    },
    ],
    stateMutability: 'view',
    type: 'function',
  },
];

// Gauge ABI — mirrors src/web3.js getUserPositions gauge interactions
const GAUGE_ABI = [
  {
    inputs: [],
    name: 'pool',
    outputs: [{ name: '', type: 'address' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'token0',
    outputs: [{ name: '', type: 'address' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    inputs: [],
    name: 'token1',
    outputs: [{ name: '', type: 'address' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    // Number of NFTs staked by this account
    inputs: [{ name: 'account', type: 'address' }],
    name: 'stakedLength',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    // Get staked tokenId at index
    inputs: [{ name: 'account', type: 'address' }, { name: 'index', type: 'uint256' }],
    name: 'stakedByIndex',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    // Get all staked tokenIds as array (preferred over looping stakedByIndex)
    inputs: [{ name: 'account', type: 'address' }],
    name: 'stakedValues',
    outputs: [{ name: '', type: 'uint256[]' }],
    stateMutability: 'view',
    type: 'function',
  },
  {
    // AERO rewards earned — needs BOTH account AND tokenId (per src/blockchain.js user note)
    inputs: [
      { name: 'account', type: 'address' },
      { name: 'tokenId', type: 'uint256' },
    ],
    name: 'earned',
    outputs: [{ name: '', type: 'uint256' }],
    stateMutability: 'view',
    type: 'function',
  },
];

// ── Token info cache ──────────────────────────────────────────────────────────

const tokenCache = new Map();

async function getTokenInfo(address) {
  if (!address) return { symbol: 'UNKNOWN', decimals: 18 };
  if (tokenCache.has(address)) return tokenCache.get(address);
  try {
    const [symbol, decimals] = await Promise.all([
      client.readContract({ address, abi: ERC20_ABI, functionName: 'symbol'   }),
      client.readContract({ address, abi: ERC20_ABI, functionName: 'decimals' }),
    ]);
    const info = { symbol, decimals: Number(decimals) };
    tokenCache.set(address, info);
    return info;
  } catch {
    return { symbol: typeof address === 'string' ? address.slice(0, 6) + '…' : 'ERR', decimals: 18 };
  }
}

// ── Pool finding — tries multiple factories + fee tiers (src/monitor.js logic) ─

async function findPool(token0, token1) {
  for (const factory of FACTORIES) {
    for (const fee of FEE_TIERS) {
      try {
        const pool = await client.readContract({
          address: factory,
          abi: FACTORY_ABI,
          functionName: 'getPool',
          args: [token0, token1, fee],
        });
        if (pool && pool !== ZERO_ADDR) {
          console.log(`[blockchain] Found pool ${pool} (factory ${factory.slice(0,10)}… fee ${fee})`);
          return pool;
        }
      } catch { /* try next fee/factory */ }
    }
  }
  return null;
}

// ── Current tick from pool ────────────────────────────────────────────────────

async function getCurrentTick(poolAddress) {
  try {
    const slot0 = await client.readContract({
      address: poolAddress,
      abi: POOL_ABI,
      functionName: 'slot0',
    });
    // slot0 returned as positional tuple — slot0[1] is tick (same as bot's slot0.tick)
    const tick = slot0.tick ?? slot0[1];
    const tickNum = tick !== undefined ? Number(tick) : null;
    console.log(`[blockchain] Pool ${poolAddress.slice(0, 10)}… currentTick: ${tickNum}`);
    return tickNum;
  } catch (e) {
    console.warn(`[blockchain] slot0 error for ${poolAddress}:`, e.message);
    return null;
  }
}

// ── Read position data from PositionManager ────────────────────────────────

async function readPosition(tokenId) {
  return client.readContract({
    address: POSITION_MANAGER,
    abi: POSITION_MANAGER_ABI,
    functionName: 'positions',
    args: [tokenId],
  });
}

// ── Build a full position object ──────────────────────────────────────────────

async function buildPosition(tokenId, pos, isStaked, gaugeAddress, gaugePoolAddress, gaugeToken0, gaugeToken1) {
  // viem returns positions() as a positional tuple — mirrors how bot accesses it in web3.js
  // pos[0]=nonce, pos[1]=operator, pos[2]=token0, pos[3]=token1, pos[4]=tickSpacing,
  // pos[5]=tickLower, pos[6]=tickUpper, pos[7]=liquidity, pos[10]=tokensOwed0, pos[11]=tokensOwed1
  const token0      = pos.token0      ?? pos[2];
  const token1      = pos.token1      ?? pos[3];
  const tickSpacing = pos.tickSpacing ?? pos[4];
  const tickLower_r = pos.tickLower   ?? pos[5];
  const tickUpper_r = pos.tickUpper   ?? pos[6];
  const liquidity   = pos.liquidity   ?? pos[7];
  const tokensOwed0 = pos.tokensOwed0 ?? pos[10];
  const tokensOwed1 = pos.tokensOwed1 ?? pos[11];

  if (!liquidity || liquidity === 0n) return null;

  const [token0Info, token1Info] = await Promise.all([
    getTokenInfo(token0),
    getTokenInfo(token1),
  ]);

  // Use gauge pool directly when tokens match — avoids factory search
  let poolAddress = null;
  if (
    gaugePoolAddress &&
    gaugeToken0 &&
    token0?.toLowerCase() === gaugeToken0.toLowerCase() &&
    token1?.toLowerCase() === gaugeToken1.toLowerCase()
  ) {
    poolAddress = gaugePoolAddress;
  } else {
    poolAddress = await findPool(token0, token1);
  }

  const currentTick = poolAddress ? await getCurrentTick(poolAddress) : null;
  const tickLower   = Number(tickLower_r);
  const tickUpper   = Number(tickUpper_r);
  const isInRange   = currentTick !== null
    ? (currentTick >= tickLower && currentTick < tickUpper)
    : null;

  return {
    tokenId:        tokenId.toString(),
    managerAddress: POSITION_MANAGER,
    token0,
    token1,
    token0Symbol:   token0Info.symbol,
    token1Symbol:   token1Info.symbol,
    token0Decimals: token0Info.decimals,
    token1Decimals: token1Info.decimals,
    tickSpacing:    Number(tickSpacing),
    tickLower,
    tickUpper,
    liquidity:      liquidity.toString(),
    tokensOwed0:    formatUnits(tokensOwed0 ?? 0n, token0Info.decimals),
    tokensOwed1:    formatUnits(tokensOwed1 ?? 0n, token1Info.decimals),
    currentTick,
    isInRange,
    poolAddress,
    isStaked,
    gaugeAddress: gaugeAddress || null,
  };
}

// ── Fetch all positions (unstaked + staked) ───────────────────────────────────

async function getPositions(walletAddress) {
  const positions = [];

  // ── Step 1: Get gauge metadata (pool, token0, token1) ────────────────────
  let gaugePoolAddress = null;
  let gaugeToken0      = null;
  let gaugeToken1      = null;

  for (const gaugeAddress of GAUGES) {
    try {
      const [pool, t0, t1] = await Promise.all([
        client.readContract({ address: gaugeAddress, abi: GAUGE_ABI, functionName: 'pool'   }).catch(() => null),
        client.readContract({ address: gaugeAddress, abi: GAUGE_ABI, functionName: 'token0' }).catch(() => null),
        client.readContract({ address: gaugeAddress, abi: GAUGE_ABI, functionName: 'token1' }).catch(() => null),
      ]);
      if (pool && pool !== ZERO_ADDR) {
        gaugePoolAddress = pool;
        gaugeToken0      = t0;
        gaugeToken1      = t1;
        console.log(`[blockchain] Gauge pool: ${pool} | token0: ${t0} | token1: ${t1}`);
        break;
      }
    } catch (e) {
      console.warn('[blockchain] Gauge metadata error:', e.message);
    }
  }

  // ── Step 2: Unstaked positions in PositionManager ─────────────────────
  try {
    const balance = await client.readContract({
      address: POSITION_MANAGER,
      abi: POSITION_MANAGER_ABI,
      functionName: 'balanceOf',
      args: [walletAddress],
    });

    console.log(`[blockchain] PositionManager balance: ${balance}`);

    for (let i = 0n; i < balance; i++) {
      try {
        const tokenId = await client.readContract({
          address: POSITION_MANAGER,
          abi: POSITION_MANAGER_ABI,
          functionName: 'tokenOfOwnerByIndex',
          args: [walletAddress, i],
        });

        const pos   = await readPosition(tokenId);
        const built = await buildPosition(tokenId, pos, false, null, gaugePoolAddress, gaugeToken0, gaugeToken1);
        if (built) {
          positions.push(built);
          console.log(`[blockchain] Unstaked #${tokenId} ${built.token0Symbol}/${built.token1Symbol} inRange=${built.isInRange}`);
        }
      } catch (e) {
        console.warn(`[blockchain] Unstaked position ${i} error:`, e.message);
      }
    }
  } catch (e) {
    console.warn('[blockchain] PositionManager balanceOf error:', e.message);
  }

  // ── Step 3: Staked positions in gauges ───────────────────────────────────
  for (const gaugeAddress of GAUGES) {
    try {
      // Try stakedValues first (returns full array at once)
      let stakedIds = [];

      try {
        const vals = await client.readContract({
          address: gaugeAddress,
          abi: GAUGE_ABI,
          functionName: 'stakedValues',
          args: [walletAddress],
        });
        if (Array.isArray(vals) && vals.length > 0) {
          stakedIds = vals;
          console.log(`[blockchain] stakedValues: [${vals.map(v => v.toString()).join(', ')}]`);
        }
      } catch { /* fall back to stakedByIndex */ }

      if (stakedIds.length === 0) {
        const stakedLen = await client.readContract({
          address: gaugeAddress,
          abi: GAUGE_ABI,
          functionName: 'stakedLength',
          args: [walletAddress],
        }).catch(() => 0n);

        const numStaked = Number(stakedLen);
        console.log(`[blockchain] Gauge stakedLength: ${numStaked}`);

        for (let i = 0; i < numStaked; i++) {
          try {
            const tokenId = await client.readContract({
              address: gaugeAddress,
              abi: GAUGE_ABI,
              functionName: 'stakedByIndex',
              args: [walletAddress, BigInt(i)],
            });
            stakedIds.push(tokenId);
          } catch (e) {
            console.warn(`[blockchain] stakedByIndex[${i}] error:`, e.message);
          }
        }
      }

      for (const tokenId of stakedIds) {
        try {
          const pos   = await readPosition(tokenId);
          const built = await buildPosition(tokenId, pos, true, gaugeAddress, gaugePoolAddress, gaugeToken0, gaugeToken1);
          if (built) {
            positions.push(built);
            console.log(`[blockchain] Staked #${tokenId} ${built.token0Symbol}/${built.token1Symbol} inRange=${built.isInRange}`);
          }
        } catch (e) {
          console.warn(`[blockchain] Staked position ${tokenId} error:`, e.message);
        }
      }
    } catch (e) {
      console.warn(`[blockchain] Gauge ${gaugeAddress} error:`, e.message);
    }
  }

  return positions;
}

// ── Gauge rewards — earned(account, tokenId) per staked position ──────────────

async function getGaugeRewards(walletAddress, positions, prices) {
  const aeroPrice = prices?.AERO || 0;
  const rewards   = [];

  for (const gaugeAddress of GAUGES) {
    const stakedTokenIds = positions
      .filter(p => p.isStaked && p.gaugeAddress?.toLowerCase() === gaugeAddress.toLowerCase())
      .map(p => BigInt(p.tokenId));

    if (stakedTokenIds.length === 0) {
      console.log(`[blockchain] No staked positions for gauge ${gaugeAddress}`);
      continue;
    }

    let totalEarned = 0n;
    const perPosition = [];

    for (const tokenId of stakedTokenIds) {
      try {
        const earned = await client.readContract({
          address: gaugeAddress,
          abi: GAUGE_ABI,
          functionName: 'earned',
          args: [walletAddress, tokenId],
        });
        totalEarned += earned;
        const formatted = formatUnits(earned, 18);
        perPosition.push({ tokenId: tokenId.toString(), earned: formatted });
        console.log(`[blockchain] earned(wallet, #${tokenId}) = ${formatted} AERO`);
      } catch (e) {
        console.warn(`[blockchain] earned() error for #${tokenId}:`, e.message);
      }
    }

    const earnedFormatted = formatUnits(totalEarned, 18);
    const earnedUsd       = parseFloat(earnedFormatted) * aeroPrice;

    rewards.push({ gaugeAddress, earnedAmount: earnedFormatted, earnedUsd, aeroPrice, perPosition });
  }

  return rewards;
}

// ── Main entry point ──────────────────────────────────────────────────────────

export async function fetchAllMetrics() {
  if (!WALLET_ADDRESS || !isAddress(WALLET_ADDRESS)) {
    throw new Error('WALLET_ADDRESS not set — add it to dashboard/.env');
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const prices    = await fetchPrices();

  const insertPrice = db.prepare(
    'INSERT INTO price_cache (timestamp, symbol, price_usd) VALUES (?, ?, ?)'
  );
  for (const [symbol, price] of Object.entries(prices)) {
    insertPrice.run(timestamp, symbol, price);
  }

  const allPositions = await getPositions(WALLET_ADDRESS);

  const insertPos = db.prepare(`
    INSERT INTO position_snapshots
      (timestamp, token_id, manager_address, token0, token1, token0_symbol, token1_symbol,
       liquidity, tick_lower, tick_upper, current_tick, is_in_range, tokens_owed0, tokens_owed1,
       is_staked, pool_address)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const pos of allPositions) {
    insertPos.run(
      timestamp, pos.tokenId, pos.managerAddress,
      pos.token0, pos.token1, pos.token0Symbol, pos.token1Symbol,
      pos.liquidity, pos.tickLower, pos.tickUpper, pos.currentTick,
      pos.isInRange ? 1 : 0,
      pos.tokensOwed0, pos.tokensOwed1,
      pos.isStaked ? 1 : 0, pos.poolAddress
    );
  }

  // earned() requires knowing which tokenIds are staked — pass positions list
  const rewards = await getGaugeRewards(WALLET_ADDRESS, allPositions, prices);

  const insertReward = db.prepare(`
    INSERT INTO reward_snapshots (timestamp, gauge_address, earned_amount, earned_usd, aero_price)
    VALUES (?, ?, ?, ?, ?)
  `);
  for (const r of rewards) {
    insertReward.run(timestamp, r.gaugeAddress, r.earnedAmount, r.earnedUsd, r.aeroPrice);
  }

  return { timestamp, positions: allPositions, rewards, prices, walletAddress: WALLET_ADDRESS };
}
