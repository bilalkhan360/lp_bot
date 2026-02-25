import './polyfill.js'; // Node 16 fetch polyfill — must be first
import express    from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import cors         from 'cors';
import dotenv       from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import db           from './db.js';
import { fetchAllMetrics } from './blockchain.js';
import { startScheduler }  from './scheduler.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '../.env') });

const app    = express();
const server = createServer(app);
const wss    = new WebSocketServer({ server });

app.use(cors());
app.use(express.json());

// ── WebSocket ────────────────────────────────────────────────────────────────

const clients = new Set();
let latestMetrics = null;

wss.on('connection', (ws) => {
  clients.add(ws);
  // Send latest snapshot immediately on connect
  if (latestMetrics) {
    ws.send(JSON.stringify({ type: 'snapshot', data: latestMetrics }));
  }
  ws.on('close', () => clients.delete(ws));
  ws.on('error', () => clients.delete(ws));
});

function broadcast(data) {
  const msg = JSON.stringify(data);
  for (const ws of clients) {
    if (ws.readyState === 1) ws.send(msg);
  }
}

function setLatestMetrics(metrics) {
  latestMetrics = metrics;
}

// ── REST endpoints ───────────────────────────────────────────────────────────

app.get('/api/status', (req, res) => {
  res.json({
    status:     'ok',
    clients:    clients.size,
    lastUpdate: latestMetrics?.timestamp || null,
    wallet:     latestMetrics?.walletAddress || null,
  });
});

app.post('/api/refresh', async (req, res) => {
  try {
    const metrics = await fetchAllMetrics();
    setLatestMetrics(metrics);
    broadcast({ type: 'snapshot', data: metrics });
    res.json({ success: true, timestamp: metrics.timestamp });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Current positions (latest snapshot)
app.get('/api/positions', (req, res) => {
  const rows = db.prepare(`
    SELECT * FROM position_snapshots
    WHERE timestamp = (SELECT MAX(timestamp) FROM position_snapshots)
    ORDER BY token_id ASC
  `).all();
  res.json(rows);
});

// Historical snapshots for a specific token ID
app.get('/api/positions/history', (req, res) => {
  const { tokenId, limit = 100 } = req.query;
  if (!tokenId) return res.status(400).json({ error: 'tokenId required' });
  const rows = db.prepare(`
    SELECT * FROM position_snapshots
    WHERE token_id = ?
    ORDER BY timestamp DESC
    LIMIT ?
  `).all(tokenId, parseInt(limit));
  res.json(rows);
});

// Current gauge rewards
app.get('/api/rewards', (req, res) => {
  const latest = db.prepare(`
    SELECT * FROM reward_snapshots
    ORDER BY timestamp DESC
    LIMIT 1
  `).get();
  res.json(latest || { earned_amount: '0', earned_usd: 0, aero_price: 0 });
});

// Historical rewards for charting
app.get('/api/rewards/history', (req, res) => {
  const { limit = 200 } = req.query;
  const rows = db.prepare(`
    SELECT * FROM reward_snapshots
    ORDER BY timestamp ASC
    LIMIT ?
  `).all(parseInt(limit));
  res.json(rows);
});

// Historical AERO claims (from on-chain token transfers)
app.get('/api/rewards/claims', (req, res) => {
  const { limit = 200 } = req.query;
  const rows = db.prepare(`
    SELECT * FROM reward_claims ORDER BY timestamp DESC LIMIT ?
  `).all(parseInt(limit));

  const totals = db.prepare(`
    SELECT
      COUNT(*)        as claim_count,
      SUM(amount)     as total_aero_claimed,
      SUM(amount_usd) as total_usd_claimed
    FROM reward_claims
  `).get();

  res.json({ claims: rows, totals: totals || { claim_count: 0, total_aero_claimed: 0, total_usd_claimed: 0 } });
});

// Gas transaction list + totals
app.get('/api/gas', (req, res) => {
  const transactions = db.prepare(`
    SELECT * FROM gas_transactions
    ORDER BY timestamp DESC
    LIMIT 100
  `).all();
  const totals = db.prepare(`
    SELECT
      SUM(gas_cost_eth) as total_eth,
      SUM(gas_cost_usd) as total_usd,
      COUNT(*)          as count,
      COUNT(CASE WHEN is_success = 1 THEN 1 END) as success_count
    FROM gas_transactions
  `).get();
  res.json({ transactions, totals: totals || { total_eth: 0, total_usd: 0, count: 0, success_count: 0 } });
});

// Latest prices
app.get('/api/prices', (req, res) => {
  const rows = db.prepare(`
    SELECT * FROM price_cache
    WHERE timestamp = (SELECT MAX(timestamp) FROM price_cache)
  `).all();
  res.json(rows);
});

// Swap transactions list + totals
app.get('/api/swaps', (req, res) => {
  const { limit = 200 } = req.query;
  const transactions = db.prepare(`
    SELECT * FROM swap_transactions
    ORDER BY timestamp DESC
    LIMIT ?
  `).all(parseInt(limit));

  const totals = db.prepare(`
    SELECT
      COUNT(*)                            as count,
      SUM(amount_in_usd - amount_out_usd) as total_slippage_usd,
      SUM(gas_cost_eth)                   as total_gas_eth,
      SUM(gas_cost_usd)                   as total_gas_usd,
      SUM(total_cost_usd)                 as total_cost_usd
    FROM swap_transactions
  `).get();

  res.json({
    transactions,
    totals: totals || { count: 0, total_slippage_usd: 0, total_gas_eth: 0, total_gas_usd: 0, total_cost_usd: 0 },
  });
});

// Position value snapshots + P&L
app.get('/api/position-value', (req, res) => {
  const { limit = 500 } = req.query;

  const allSnapshots = db.prepare(`
    SELECT * FROM position_value_snapshots
    ORDER BY timestamp ASC
  `).all();

  // Sample: keep 1 row per 600s (10 min) window, plus always keep first and last
  const sampled = [];
  let lastKept = 0;
  for (let i = 0; i < allSnapshots.length; i++) {
    const row = allSnapshots[i];
    if (i === 0 || i === allSnapshots.length - 1 || row.timestamp - lastKept >= 600) {
      sampled.push(row);
      lastKept = row.timestamp;
    }
  }

  const snapshots = sampled.length > parseInt(limit)
    ? sampled.slice(sampled.length - parseInt(limit))
    : sampled;

  const firstSnapshot = allSnapshots.length > 0 ? allSnapshots[0] : null;
  const lastSnapshot = allSnapshots.length > 0 ? allSnapshots[allSnapshots.length - 1] : null;
  const currentValue = lastSnapshot?.total_value_usd || 0;
  const firstValue = firstSnapshot?.total_value_usd || 0;
  const pnl = currentValue - firstValue;
  const pnlPercent = firstValue > 0 ? (pnl / firstValue) * 100 : 0;

  res.json({
    snapshots,
    pnl: {
      currentValue,
      firstValue,
      pnl,
      pnlPercent,
      trackingSince: firstSnapshot?.timestamp || null,
    },
  });
});

// Aggregate summary for overview cards
app.get('/api/summary', (req, res) => {
  const latestTs = db.prepare(
    'SELECT MAX(timestamp) as ts FROM position_snapshots'
  ).get()?.ts;

  const posCount = latestTs
    ? db.prepare(`
        SELECT COUNT(DISTINCT token_id) as total,
               SUM(is_in_range) as in_range
        FROM position_snapshots
        WHERE timestamp = ?
      `).get(latestTs)
    : { total: 0, in_range: 0 };

  const latestReward = db.prepare(
    'SELECT * FROM reward_snapshots ORDER BY timestamp DESC LIMIT 1'
  ).get();

  const gasTotals = db.prepare(`
    SELECT
      SUM(gas_cost_eth) as total_eth,
      SUM(gas_cost_usd) as total_usd,
      COUNT(*)          as tx_count,
      MIN(timestamp)    as first_tx,
      MAX(timestamp)    as last_tx
    FROM gas_transactions
  `).get();

  // All-time AERO claimed from on-chain token transfers
  const claimTotals = db.prepare(`
    SELECT
      COUNT(*)        as claim_count,
      SUM(amount)     as total_aero_claimed,
      SUM(amount_usd) as total_usd_claimed
    FROM reward_claims
  `).get();

  // Daily gas for chart (last 30 days)
  const dailyGas = db.prepare(`
    SELECT
      date(timestamp, 'unixepoch') as day,
      SUM(gas_cost_eth) as eth,
      SUM(gas_cost_usd) as usd,
      COUNT(*) as tx_count
    FROM gas_transactions
    WHERE timestamp > strftime('%s', 'now', '-30 days')
    GROUP BY day
    ORDER BY day ASC
  `).all();

  // Daily AERO claims for chart
  const dailyClaims = db.prepare(`
    SELECT
      date(timestamp, 'unixepoch') as day,
      SUM(amount)     as aero,
      SUM(amount_usd) as usd,
      COUNT(*)        as claim_count
    FROM reward_claims
    GROUP BY day
    ORDER BY day ASC
  `).all();

  res.json({
    positions:   posCount  || { total: 0, in_range: 0 },
    rewards:     latestReward || { earned_amount: '0', earned_usd: 0, aero_price: 0 },
    claims:      claimTotals  || { claim_count: 0, total_aero_claimed: 0, total_usd_claimed: 0 },
    dailyClaims,
    gas:         gasTotals || { total_eth: 0, total_usd: 0, tx_count: 0 },
    dailyGas,
    lastUpdate:  latestMetrics?.timestamp || null,
  });
});

// ── Start ────────────────────────────────────────────────────────────────────

startScheduler(broadcast, setLatestMetrics);

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`\n  LP Dashboard backend →  http://localhost:${PORT}\n`);
});
