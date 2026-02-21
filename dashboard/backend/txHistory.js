import './polyfill.js';
import { createPublicClient, http } from 'viem';
import { base } from 'viem/chains';
import db from './db.js';
import { fetchPrices } from './priceService.js';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '../../.env') });
dotenv.config({ path: join(__dirname, '../.env'), override: true });

const RPC_URL         = process.env.BASE_RPC_URL || 'https://mainnet.base.org';
const ALCHEMY_API_KEY = process.env.ALCHEMY_API_KEY || (RPC_URL.includes('alchemy.com') ? RPC_URL.split('/v2/')[1] : null);
const ALCHEMY_RPC_URL = ALCHEMY_API_KEY ? `https://base-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}` : null;
const IS_ALCHEMY      = !!ALCHEMY_API_KEY;

const client = createPublicClient({
  chain: base,
  transport: http(RPC_URL, { timeout: 30_000 }),
});

// Contract addresses
const AERO_TOKEN = '0x940181a94a35a4569e4529a3cdfb74e38fd98631';
const GAUGE_ADDR = '0xc6e211ff1d04a1728ab011406ad42ef529cb3886';

// Bot-related contracts (used to filter gas transactions)
const BOT_CONTRACTS = new Set([
  '0x827922686190790b37229fd06084350e74485b72',
  '0xa990c6a764b73bf43cee5bb40339c3322fb9d55f',
  '0x6df1c91424f79e40e33b1a48f0687b666be71075',
  '0xc6e211ff1d04a1728ab011406ad42ef529cb3886',
  '0xade65c38cd4849adba595a4323a8c7ddfe89716a',
]);

// Swap router contracts — each entry: [address, display name]
const SWAP_ROUTERS = new Map([
  ['0x19ceead7105607cd444f5ad10dd51356436095a1', 'Odos'],
  ['0x6df1c91424f79e40e33b1a48f0687b666be71075', 'Aerodrome Router'],
  ['0x6131b5fae19ea4f9d964eac0408e4408b66337b5', 'Kyber'],
]);

// Contract address → price_cache symbol mapping
const TOKEN_SYMBOLS = new Map([
  ['0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', 'USDC'],   // USDC on Base
  ['0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca', 'USDC'],   // USDbC (legacy)
  ['0x4200000000000000000000000000000000000006', 'ETH'],    // WETH on Base
  ['0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf', 'cbBTC'],  // cbBTC on Base
  ['0x311935cd80b76769bf2ecc9d8ab7635b2139cf82', 'SOL'],   // Wrapped SOL on Base
  ['0x940181a94a35a4569e4529a3cdfb74e38fd98631', 'AERO'],   // AERO
]);

// Decode normalized amount from Alchemy rawContract
function decodeAmount(rawValue, rawDecimal) {
  const raw = BigInt(rawValue || '0x0');
  const dec = parseInt(rawDecimal || '0x12', 16);
  if (dec <= 9) return Number(raw) / 10 ** dec;
  const shift = BigInt(10 ** (dec - 9));
  return Number(raw / shift) / 1e9;
}

// Token addresses to include in swap tracking. Add more addresses here to expand coverage.
const SUPPORTED_SWAP_TOKENS = new Set([
  '0x311935cd80b76769bf2ecc9d8ab7635b2139cf82', // SOL on Base
]);

/**
 * Fetch the USD price of a token at a specific Unix timestamp via Alchemy's
 * historical token prices endpoint.
 *
 * Uses 5-minute candles which is the finest resolution available.
 * Caches results in price_cache so repeated lookups for the same swap are free.
 */
async function fetchHistoricalPrice(symbol, timestamp) {
  if (symbol === 'USDC') return 1.0;
  if (!ALCHEMY_API_KEY) return 0;

  // Check DB cache within ±30 min of the requested timestamp
  const cached = db.prepare(
    'SELECT price_usd FROM price_cache WHERE symbol = ? AND timestamp BETWEEN ? AND ? ORDER BY ABS(timestamp - ?) LIMIT 1'
  ).get(symbol, timestamp - 1800, timestamp + 1800, timestamp);
  if (cached?.price_usd) return cached.price_usd;

  // ±1 hour window around the swap to guarantee we get candles
  const startTime = new Date((timestamp - 3600) * 1000).toISOString();
  const endTime   = new Date((timestamp + 3600) * 1000).toISOString();

  try {
    const res = await fetch(
      `https://api.g.alchemy.com/prices/v1/${ALCHEMY_API_KEY}/tokens/historical`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol, startTime, endTime, interval: '5m' }),
        signal: AbortSignal.timeout(15_000),
      }
    );
    const json = await res.json();
    const pts  = json?.data; // [{ value: "123.45", timestamp: "2024-..." }, ...]
    if (!pts?.length) return 0;

    // Find the candle closest to the swap timestamp
    let bestPrice = Number(pts[0].value), minDiff = Infinity;
    for (const pt of pts) {
      const ptTs = Math.floor(new Date(pt.timestamp).getTime() / 1000);
      const diff = Math.abs(ptTs - timestamp);
      if (diff < minDiff) { minDiff = diff; bestPrice = Number(pt.value); }
    }

    // Cache at the requested timestamp so future lookups hit within ±30 min
    db.prepare('INSERT OR IGNORE INTO price_cache (timestamp, symbol, price_usd) VALUES (?, ?, ?)')
      .run(timestamp, symbol, bestPrice);

    console.log(
      `[TxHistory] Alchemy price: ${symbol} @ ${new Date(timestamp * 1000).toISOString()}` +
      ` = $${bestPrice.toFixed(4)} (closest candle ${Math.round(minDiff / 60)}min away)`
    );
    return bestPrice;
  } catch (e) {
    console.warn(`[TxHistory] Alchemy price failed (${symbol} @ ${new Date(timestamp * 1000).toISOString()}):`, e.message);
    return 0;
  }
}

// ── Alchemy helper ────────────────────────────────────────────────────────────

async function alchemyGetAssetTransfers(params) {
  const res = await fetch(ALCHEMY_RPC_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id: 1,
      jsonrpc: '2.0',
      method: 'alchemy_getAssetTransfers',
      params: [{ withMetadata: true, excludeZeroValue: false, order: 'asc', ...params }],
    }),
    signal: AbortSignal.timeout(20_000),
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return data.result;
}

// Collect all pages from alchemy_getAssetTransfers
async function alchemyGetAllTransfers(params) {
  const allTransfers = [];
  let pageKey;
  do {
    const result = await alchemyGetAssetTransfers({ ...params, ...(pageKey ? { pageKey } : {}) });
    if (!result) break;
    allTransfers.push(...(result.transfers || []));
    pageKey = result.pageKey;
  } while (pageKey);
  return allTransfers;
}

// ── Reward claims ─────────────────────────────────────────────────────────────

/**
 * Sync historical AERO reward claims.
 * Uses Alchemy's alchemy_getAssetTransfers — full history with timestamps, no block range limits.
 * Falls back to a best-effort RPC getLogs approach for non-Alchemy endpoints.
 */
export async function syncRewardClaims(walletAddress) {
  if (!walletAddress) return;

  try {
    if (IS_ALCHEMY) {
      await _claimsViaAlchemy(walletAddress);
    } else {
      console.log('[TxHistory] AERO claim sync: Alchemy RPC recommended for full history');
    }
  } catch (e) {
    console.warn('[TxHistory] AERO claim sync error:', e.message);
  }
}

async function _claimsViaAlchemy(walletAddress) {
  const prices    = await fetchPrices();
  const aeroPrice = prices.AERO || 0;

  // Only query blocks we haven't seen yet
  const lastBlock = db.prepare('SELECT MAX(block_number) as b FROM reward_claims').get()?.b;
  const fromBlock = lastBlock ? '0x' + (lastBlock + 1).toString(16) : '0x0';

  const transfers = await alchemyGetAllTransfers({
    fromBlock,
    toBlock:           'latest',
    fromAddress:       GAUGE_ADDR,
    toAddress:         walletAddress,
    contractAddresses: [AERO_TOKEN],
    category:          ['erc20'],
    withMetadata:      true,
    excludeZeroValue:  true,
  });

  if (transfers.length === 0) {
    console.log('[TxHistory] AERO claims: 0 new (none found on-chain)');
    return;
  }

  const insert = db.prepare(`
    INSERT OR IGNORE INTO reward_claims
      (timestamp, tx_hash, amount_raw, amount, amount_usd, aero_price, from_address, block_number)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let inserted = 0;
  for (const t of transfers) {
    const blockNumber = parseInt(t.blockNum, 16);
    const timestamp   = t.metadata?.blockTimestamp
      ? Math.floor(new Date(t.metadata.blockTimestamp).getTime() / 1000)
      : 0;

    const rawHex = t.rawContract?.value || '0x0';
    const raw    = BigInt(rawHex).toString();
    const whole  = BigInt(rawHex) / BigInt(1e9);
    const amount = Number(whole) / 1e9;

    insert.run(timestamp, t.hash, raw, amount, amount * aeroPrice, aeroPrice, t.from, blockNumber);
    inserted++;
  }

  console.log(`[TxHistory] Synced ${inserted} AERO reward claims (${transfers.length} total on-chain)`);
}

// ── Gas transactions ──────────────────────────────────────────────────────────

/**
 * Sync bot gas transactions using Alchemy asset transfers.
 * Tracks:
 *   1. ERC-721 transfers from wallet to gauge (staking LP NFTs)
 *   2. ERC-721 transfers from gauge to wallet (unstaking)
 *   3. Outgoing ETH from wallet to bot contracts (any ETH-value calls)
 *   4. Gas for reward claim txs (derived from reward_claims table)
 *
 * Fetches receipts for each discovered tx hash to get exact gas cost.
 */
export async function syncTxHistory(walletAddress) {
  if (!walletAddress) return;

  try {
    const prices   = await fetchPrices();
    const ethPrice = prices.ETH || 0;

    const txHashesToProcess = new Set();

    if (IS_ALCHEMY) {
      const lastBlock = db.prepare('SELECT MAX(block_number) as b FROM gas_transactions').get()?.b;
      const fromBlock = lastBlock ? '0x' + (lastBlock + 1).toString(16) : '0x0';

      // 1. ERC-721 transfers from wallet (staking/position operations)
      const nftOut = await alchemyGetAllTransfers({
        fromBlock,
        toBlock:      'latest',
        fromAddress:  walletAddress,
        category:     ['erc721'],
        withMetadata: true,
        excludeZeroValue: false,
      });
      for (const t of nftOut) {
        if (BOT_CONTRACTS.has((t.to || '').toLowerCase())) {
          txHashesToProcess.add(t.hash);
        }
      }

      // 2. ERC-721 transfers to wallet (unstaking)
      const nftIn = await alchemyGetAllTransfers({
        fromBlock,
        toBlock:      'latest',
        toAddress:    walletAddress,
        category:     ['erc721'],
        withMetadata: true,
        excludeZeroValue: false,
      });
      for (const t of nftIn) {
        if (BOT_CONTRACTS.has((t.from || '').toLowerCase())) {
          txHashesToProcess.add(t.hash);
        }
      }

      // 3. External (ETH) transfers from wallet to bot contracts
      const ethOut = await alchemyGetAllTransfers({
        fromBlock,
        toBlock:      'latest',
        fromAddress:  walletAddress,
        category:     ['external'],
        withMetadata: true,
        excludeZeroValue: false,
      });
      for (const t of ethOut) {
        if (BOT_CONTRACTS.has((t.to || '').toLowerCase())) {
          txHashesToProcess.add(t.hash);
        }
      }
    }

    // 4. Always: pick up gas for reward claim transactions (zero-value calls to gauge)
    //    These are stored in reward_claims with their tx_hash
    const claimHashes = db.prepare('SELECT tx_hash FROM reward_claims').all();
    for (const c of claimHashes) txHashesToProcess.add(c.tx_hash);

    if (txHashesToProcess.size === 0) {
      console.log('[TxHistory] Gas txs: nothing new to process');
      return;
    }

    // Remove hashes already in gas_transactions
    const hashes = [...txHashesToProcess];

    // SQLite IN clause - handle in batches to avoid too-long queries
    const BATCH = 50;
    const known = new Set();
    for (let i = 0; i < hashes.length; i += BATCH) {
      const slice = hashes.slice(i, i + BATCH);
      const rows  = db.prepare(
        `SELECT tx_hash FROM gas_transactions WHERE tx_hash IN (${slice.map(() => '?').join(',')})`
      ).all(...slice);
      for (const r of rows) known.add(r.tx_hash);
    }

    const newHashes = hashes.filter(h => !known.has(h));
    if (newHashes.length === 0) {
      console.log('[TxHistory] Gas txs: already up to date');
      return;
    }

    // Fetch receipts for new hashes
    const receipts = await Promise.all(
      newHashes.map(hash => client.getTransactionReceipt({ hash }).catch(() => null))
    );

    // Fetch block timestamps for each unique block
    const blockNums = [...new Set(receipts.filter(Boolean).map(r => r.blockNumber))];
    const blocks    = await Promise.all(
      blockNums.map(bn => client.getBlock({ blockNumber: bn }).catch(() => null))
    );
    const tsMap = new Map(blocks.filter(Boolean).map(b => [b.number, Number(b.timestamp)]));

    const insert = db.prepare(`
      INSERT OR IGNORE INTO gas_transactions
        (timestamp, tx_hash, gas_used, gas_price, gas_cost_eth, gas_cost_usd, block_number, method_name, is_success)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    let inserted = 0;
    for (const receipt of receipts.filter(Boolean)) {
      if (!receipt.gasUsed || !receipt.effectiveGasPrice) continue;
      const gasCostEth = Number(receipt.gasUsed * receipt.effectiveGasPrice) / 1e18;
      const gasCostUsd = gasCostEth * ethPrice;
      const timestamp  = tsMap.get(receipt.blockNumber) || 0;

      insert.run(
        timestamp,
        receipt.transactionHash,
        receipt.gasUsed.toString(),
        receipt.effectiveGasPrice.toString(),
        gasCostEth,
        gasCostUsd,
        Number(receipt.blockNumber),
        '',
        receipt.status === 'success' ? 1 : 0
      );
      inserted++;
    }

    if (inserted > 0) {
      console.log(`[TxHistory] Synced ${inserted} bot gas transactions`);
    } else {
      console.log('[TxHistory] Gas txs: 0 new');
    }
  } catch (e) {
    console.warn('[TxHistory] Gas sync error:', e.message);
  }
}

// ── Swap transactions ──────────────────────────────────────────────────────────

/**
 * Sync historical swap transactions from known routers.
 * Detects swaps by finding txs where wallet both sends and receives ERC-20 tokens
 * and the tx.to is a known swap router. Records net USD (received - sent) to capture
 * slippage + swap fees, plus the gas cost.
 */
export async function syncSwapHistory(walletAddress) {
  if (!walletAddress || !IS_ALCHEMY) {
    if (!IS_ALCHEMY) console.log('[TxHistory] Swap sync: Alchemy RPC required');
    return;
  }

  try {
    const prices = await fetchPrices();

    const lastBlock = db.prepare('SELECT MAX(block_number) as b FROM swap_transactions').get()?.b;
    const fromBlock = lastBlock ? '0x' + (lastBlock + 1).toString(16) : '0x0';

    // Fetch ALL ERC-20 outflows and inflows — we filter by supported token AFTER grouping
    // so that swaps like USDC→SOL (USDC out, SOL in) are correctly detected.
    const [erc20Out, erc20In] = await Promise.all([
      alchemyGetAllTransfers({
        fromBlock, toBlock: 'latest',
        fromAddress:      walletAddress,
        category:         ['erc20'],
        withMetadata:     true,
        excludeZeroValue: true,
      }),
      alchemyGetAllTransfers({
        fromBlock, toBlock: 'latest',
        toAddress:        walletAddress,
        category:         ['erc20'],
        withMetadata:     true,
        excludeZeroValue: true,
      }),
    ]);

    // Group ALL transfers by tx hash
    const byTx = new Map();
    for (const t of erc20Out) {
      if (!byTx.has(t.hash)) byTx.set(t.hash, { outs: [], ins: [], blockNum: parseInt(t.blockNum, 16), ts: t.metadata?.blockTimestamp });
      byTx.get(t.hash).outs.push(t);
    }
    for (const t of erc20In) {
      if (!byTx.has(t.hash)) byTx.set(t.hash, { outs: [], ins: [], blockNum: parseInt(t.blockNum, 16), ts: t.metadata?.blockTimestamp });
      byTx.get(t.hash).ins.push(t);
    }

    // Keep txs that have both sends and receives, and involve at least one SUPPORTED_SWAP_TOKEN
    const isSupported = (t) => SUPPORTED_SWAP_TOKENS.has((t.rawContract?.address || '').toLowerCase());
    const candidates = [...byTx.entries()].filter(([, d]) =>
      d.outs.length > 0 && d.ins.length > 0 &&
      [...d.outs, ...d.ins].some(isSupported)
    );
    if (candidates.length === 0) {
      console.log('[TxHistory] Swaps: 0 new');
      return;
    }

    // Remove already-stored hashes
    const candidateHashes = candidates.map(([h]) => h);
    const BATCH = 50;
    const known = new Set();
    for (let i = 0; i < candidateHashes.length; i += BATCH) {
      const slice = candidateHashes.slice(i, i + BATCH);
      const rows = db.prepare(
        `SELECT tx_hash FROM swap_transactions WHERE tx_hash IN (${slice.map(() => '?').join(',')})`
      ).all(...slice);
      for (const r of rows) known.add(r.tx_hash);
    }

    const newCandidates = candidates.filter(([h]) => !known.has(h));
    if (newCandidates.length === 0) {
      console.log('[TxHistory] Swaps: already up to date');
      return;
    }

    // Verify each tx calls a known swap router
    const txDetails = await Promise.all(
      newCandidates.map(([hash]) => client.getTransaction({ hash }).catch(() => null))
    );

    const swapTxs = [];
    for (let i = 0; i < newCandidates.length; i++) {
      const [hash, data] = newCandidates[i];
      const tx = txDetails[i];
      if (!tx) continue;
      const toAddr = (tx.to || '').toLowerCase();
      if (!SWAP_ROUTERS.has(toAddr)) continue;
      swapTxs.push({ hash, data, router: SWAP_ROUTERS.get(toAddr) });
    }

    if (swapTxs.length === 0) {
      console.log('[TxHistory] Swaps: 0 router transactions found');
      return;
    }

    // Pre-fetch historical prices from CoinGecko for each unique (symbol, date) pair.
    // Sequential with a small delay to stay within free-tier rate limits.
    // Results are stored in price_cache so subsequent syncs hit the DB instead.
    const pendingPrices = new Map(); // `${symbol}_${timestamp}` → price
    for (const { data } of swapTxs) {
      const ts = data.ts ? Math.floor(new Date(data.ts).getTime() / 1000) : 0;
      if (!ts) continue;
      for (const t of [...data.outs, ...data.ins]) {
        const addr   = (t.rawContract?.address || '').toLowerCase();
        const symbol = TOKEN_SYMBOLS.get(addr);
        if (!symbol || symbol === 'USDC') continue;
        const key = `${symbol}_${ts}`;
        if (!pendingPrices.has(key)) pendingPrices.set(key, null);
      }
    }
    for (const [key] of pendingPrices) {
      const [symbol, tsStr] = key.split('_');
      const price = await fetchHistoricalPrice(symbol, parseInt(tsStr));
      pendingPrices.set(key, price);
    }

    // Fetch receipts for gas costs in batches of 20 to avoid concurrent request timeouts
    const receiptMap = new Map();
    const RECEIPT_BATCH = 20;
    for (let i = 0; i < swapTxs.length; i += RECEIPT_BATCH) {
      const slice = swapTxs.slice(i, i + RECEIPT_BATCH);
      const batch = await Promise.all(
        slice.map(({ hash }) => client.getTransactionReceipt({ hash }).catch(() => null))
      );
      for (const r of batch.filter(Boolean)) receiptMap.set(r.transactionHash, r);
    }

    const insert = db.prepare(`
      INSERT OR IGNORE INTO swap_transactions
        (timestamp, tx_hash, token_in, token_in_address, amount_in, amount_in_usd,
         token_out, token_out_address, amount_out, amount_out_usd,
         net_usd, gas_cost_eth, gas_cost_usd, total_cost_usd, router, block_number)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const getHistPrice = (symbol, ts) => {
      if (symbol === 'USDC') return 1.0;
      return pendingPrices.get(`${symbol}_${ts}`) ?? (prices[symbol] || 0);
    };

    let inserted = 0;
    for (const { hash, data, router } of swapTxs) {
      const timestamp = data.ts
        ? Math.floor(new Date(data.ts).getTime() / 1000)
        : 0;

      // Sum outflows; pick the primary token (largest USD value)
      let sentUsd = 0;
      let tokenIn = null, tokenInAddr = null, amountIn = 0, maxSentUsd = 0;
      for (const t of data.outs) {
        const addr   = (t.rawContract?.address || '').toLowerCase();
        const symbol = TOKEN_SYMBOLS.get(addr);
        const amount = decodeAmount(t.rawContract?.value, t.rawContract?.decimal);
        const price  = getHistPrice(symbol, timestamp);
        const usd    = amount * price;
        sentUsd += usd;
        if (usd > maxSentUsd) {
          maxSentUsd  = usd;
          tokenIn     = symbol || addr.slice(0, 10);
          tokenInAddr = addr;
          amountIn    = amount;
        }
      }

      // Sum inflows; pick the primary token (largest USD value)
      let receivedUsd = 0;
      let tokenOut = null, tokenOutAddr = null, amountOut = 0, maxReceivedUsd = 0;
      for (const t of data.ins) {
        const addr   = (t.rawContract?.address || '').toLowerCase();
        const symbol = TOKEN_SYMBOLS.get(addr);
        const amount = decodeAmount(t.rawContract?.value, t.rawContract?.decimal);
        const price  = getHistPrice(symbol, timestamp);
        const usd    = amount * price;
        receivedUsd += usd;
        if (usd > maxReceivedUsd) {
          maxReceivedUsd = usd;
          tokenOut       = symbol || addr.slice(0, 10);
          tokenOutAddr   = addr;
          amountOut      = amount;
        }
      }

      const netUsd = receivedUsd - sentUsd; // negative = net cost (slippage + DEX fees)

      const receipt = receiptMap.get(hash);
      let gasCostEth = 0, gasCostUsd = 0;
      if (receipt?.gasUsed && receipt?.effectiveGasPrice) {
        gasCostEth = Number(receipt.gasUsed * receipt.effectiveGasPrice) / 1e18;
        gasCostUsd = gasCostEth * (prices.ETH || 0);
      }

      const totalCostUsd = -netUsd + gasCostUsd; // positive = total loss on this swap

      insert.run(
        timestamp, hash,
        tokenIn, tokenInAddr, amountIn, sentUsd,
        tokenOut, tokenOutAddr, amountOut, receivedUsd,
        netUsd, gasCostEth, gasCostUsd, totalCostUsd,
        router, data.blockNum || 0
      );
      inserted++;
    }

    if (inserted > 0) {
      console.log(`[TxHistory] Synced ${inserted} swap transactions`);
    } else {
      console.log('[TxHistory] Swaps: 0 inserted');
    }
  } catch (e) {
    console.warn('[TxHistory] Swap sync error:', e.message);
  }
}

// ── Backfill historical swap USD values ───────────────────────────────────────

/**
 * Re-computes amount_in_usd, amount_out_usd, net_usd, and total_cost_usd for
 * every row in swap_transactions using CoinGecko historical prices at the exact
 * swap date. Run once at startup to fix records that were stored with current
 * prices by older code.
 */
export async function recomputeSwapUsd() {
  const rows = db.prepare('SELECT * FROM swap_transactions ORDER BY timestamp ASC').all();
  if (!rows.length) return;

  console.log(`[TxHistory] Recomputing historical USD for ${rows.length} swap record(s)...`);

  // Collect unique (symbol, timestamp) pairs that need a price lookup
  const pending = new Map(); // key `SYMBOL_ts` → price (null until fetched)
  for (const row of rows) {
    for (const addr of [row.token_in_address, row.token_out_address]) {
      const sym = TOKEN_SYMBOLS.get((addr || '').toLowerCase());
      if (!sym || sym === 'USDC' || !row.timestamp) continue;
      const key = `${sym}_${row.timestamp}`;
      if (!pending.has(key)) pending.set(key, null);
    }
  }

  // Fetch all unique prices (Alchemy has no free-tier rate limit concerns)
  for (const [key] of pending) {
    const [sym, tsStr] = key.split('_');
    const price = await fetchHistoricalPrice(sym, parseInt(tsStr));
    pending.set(key, price);
  }

  const getPrice = (addr, ts) => {
    const sym = TOKEN_SYMBOLS.get((addr || '').toLowerCase());
    if (!sym || sym === 'USDC') return 1.0;
    return pending.get(`${sym}_${ts}`) || 0;
  };

  const update = db.prepare(`
    UPDATE swap_transactions
    SET amount_in_usd = ?, amount_out_usd = ?, net_usd = ?, total_cost_usd = ?
    WHERE id = ?
  `);

  for (const row of rows) {
    const inUsd  = (row.amount_in  || 0) * getPrice(row.token_in_address,  row.timestamp);
    const outUsd = (row.amount_out || 0) * getPrice(row.token_out_address, row.timestamp);
    const netUsd = outUsd - inUsd;
    update.run(inUsd, outUsd, netUsd, -netUsd + (row.gas_cost_usd || 0), row.id);
  }

  console.log(`[TxHistory] Done — recomputed USD values for ${rows.length} swap record(s)`);
}
