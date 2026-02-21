import { fetchAllMetrics, WALLET_ADDRESS } from './blockchain.js';
import { syncTxHistory, syncRewardClaims, syncSwapHistory, recomputeSwapUsd } from './txHistory.js';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '../.env') });

const POLL_INTERVAL   = parseInt(process.env.POLL_INTERVAL  || '30000');
const TX_SYNC_INTERVAL = 5 * 60 * 1000; // every 5 minutes

export function startScheduler(broadcast, setLatestMetrics) {
  let running = false; // prevent overlapping runs

  async function runMetrics() {
    if (running) {
      console.log('[Scheduler] Skipping — previous run still in progress');
      return;
    }
    running = true;
    try {
      console.log('[Scheduler] Fetching on-chain metrics...');
      const metrics = await fetchAllMetrics();
      setLatestMetrics(metrics);
      broadcast({ type: 'snapshot', data: metrics });
      console.log(
        `[Scheduler] Updated — ${metrics.positions.length} positions, ` +
        `${metrics.rewards.length} gauges, ` +
        `AERO price: $${metrics.prices.AERO?.toFixed(3)}`
      );
    } catch (e) {
      console.error('[Scheduler] Metrics error:', e.message);
      broadcast({ type: 'error', message: e.message });
    } finally {
      running = false;
    }
  }

  async function runTxSync() {
    if (!WALLET_ADDRESS) return;
    await syncTxHistory(WALLET_ADDRESS);
    await syncRewardClaims(WALLET_ADDRESS);
    await syncSwapHistory(WALLET_ADDRESS);
  }

  // Stagger initial runs so they don't overlap
  setTimeout(runMetrics, 2_000);
  setTimeout(runTxSync,  8_000);
  // One-time backfill: fix any swap records stored with current-price USD values
  setTimeout(() => WALLET_ADDRESS && recomputeSwapUsd(), 12_000);

  setInterval(runMetrics, POLL_INTERVAL);
  setInterval(runTxSync,  TX_SYNC_INTERVAL);

  console.log(`[Scheduler] Started — polling every ${POLL_INTERVAL / 1000}s`);
}
