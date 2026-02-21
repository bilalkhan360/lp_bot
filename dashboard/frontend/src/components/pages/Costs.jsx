import { useFetch }    from '../../hooks/useFetch.jsx';
import { useDashboard } from '../../App.jsx';
import MetricCard     from '../ui/MetricCard.jsx';
import ChartTooltip  from '../ui/ChartTooltip.jsx';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  AreaChart, Area,
} from 'recharts';

function SectionHeader({ title }) {
  return (
    <div className="section-header">
      <span className="section-title">{title}</span>
      <div className="section-line" />
    </div>
  );
}

function tsToDate(ts) {
  if (!ts) return '—';
  return new Date(ts * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function tsToDateTime(ts) {
  if (!ts) return '—';
  return new Date(ts * 1000).toLocaleString('en-US', {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

export default function Costs() {
  const { liveData } = useDashboard();
  const { data: gasData, loading }     = useFetch('/api/gas');
  const { data: claimsData }           = useFetch('/api/rewards/claims?limit=1');
  const { data: swapsData }            = useFetch('/api/swaps?limit=1');

  const prices   = liveData?.prices || {};
  const ethPrice = prices.ETH || 0;

  const totals        = gasData?.totals || { total_eth: 0, total_usd: 0, count: 0, success_count: 0 };
  const txns          = gasData?.transactions || [];
  const claimsTotals  = claimsData?.totals || { total_aero_claimed: 0, total_usd_claimed: 0 };
  const swapTotals    = swapsData?.totals  || { total_slippage_usd: 0, total_gas_usd: 0, total_cost_usd: 0 };

  const successRate = totals.count > 0
    ? ((totals.success_count / totals.count) * 100).toFixed(0)
    : '—';

  // Average gas per tx
  const avgGasEth = totals.count > 0 ? (totals.total_eth / totals.count) : 0;

  // Group by day for bar chart
  const dailyChart = (() => {
    if (!txns.length) return [];
    const byDay = {};
    for (const tx of txns) {
      if (!tx.timestamp) continue;
      const day = new Date(tx.timestamp * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      byDay[day] = (byDay[day] || 0) + (tx.gas_cost_eth || 0);
    }
    return Object.entries(byDay)
      .map(([day, eth]) => ({ day, eth: parseFloat(eth.toFixed(6)), usd: eth * ethPrice }))
      .reverse();
  })();

  // Cumulative gas chart
  const cumulChart = (() => {
    if (!txns.length) return [];
    let cum = 0;
    return txns
      .slice()
      .reverse()
      .map((tx) => {
        cum += tx.gas_cost_eth || 0;
        return { day: tsToDate(tx.timestamp), cumEth: parseFloat(cum.toFixed(6)) };
      });
  })();

  return (
    <div>
      {/* ── Summary cards ─────────────────────────────── */}
      <div className="metric-grid">
        <MetricCard
          label="Total Gas Spent"
          value={totals.total_eth > 0 ? parseFloat(totals.total_eth).toFixed(6) + ' ETH' : '—'}
          sub={totals.total_usd > 0 ? '$' + parseFloat(totals.total_usd).toFixed(2) + ' USD' : 'Syncing…'}
          accent="warning"
          animDelay={0}
        />
        <MetricCard
          label="Total Transactions"
          value={String(totals.count || 0)}
          sub={`${totals.success_count || 0} successful · ${successRate}% success rate`}
          accent="primary"
          animDelay={60}
        />
        <MetricCard
          label="Avg Gas / Tx"
          value={avgGasEth > 0 ? avgGasEth.toFixed(6) + ' ETH' : '—'}
          sub={avgGasEth > 0 ? '$' + (avgGasEth * ethPrice).toFixed(3) + ' USD' : ''}
          accent="warning"
          animDelay={120}
        />
        <MetricCard
          label="ETH Price"
          value={ethPrice > 0 ? '$' + ethPrice.toLocaleString('en-US', { maximumFractionDigits: 0 }) : '—'}
          sub="Live via CoinGecko"
          accent="primary"
          animDelay={180}
        />
      </div>

      {/* ── Charts ────────────────────────────────────── */}
      <div className="page-grid">
        <div className="chart-card">
          <SectionHeader title="Daily Gas Cost (ETH)" />
          {dailyChart.length > 0 ? (
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={dailyChart} margin={{ top: 4, right: 4, bottom: 0, left: -10 }}>
                <defs>
                  <linearGradient id="barGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%"  stopColor="#ffb020" stopOpacity={0.9} />
                    <stop offset="95%" stopColor="#ffb020" stopOpacity={0.3} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(0,170,255,0.05)" />
                <XAxis dataKey="day" tick={{ fontSize: 10 }} interval="preserveStartEnd" />
                <YAxis tick={{ fontSize: 10 }} />
                <Tooltip content={<ChartTooltip formatter={(v) => v.toFixed(6) + ' ETH'} />} />
                <Bar dataKey="eth" name="ETH" fill="url(#barGrad)" radius={[2, 2, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="empty-state">No gas transaction data yet — syncs every 5 minutes.</div>
          )}
        </div>

        <div className="chart-card">
          <SectionHeader title="Cumulative Gas Spent" />
          {cumulChart.length > 1 ? (
            <ResponsiveContainer width="100%" height={200}>
              <AreaChart data={cumulChart} margin={{ top: 4, right: 4, bottom: 0, left: -10 }}>
                <defs>
                  <linearGradient id="cumGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%"  stopColor="#ffb020" stopOpacity={0.25} />
                    <stop offset="95%" stopColor="#ffb020" stopOpacity={0}    />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(0,170,255,0.05)" />
                <XAxis dataKey="day" tick={{ fontSize: 10 }} interval="preserveStartEnd" />
                <YAxis tick={{ fontSize: 10 }} />
                <Tooltip content={<ChartTooltip formatter={(v) => v.toFixed(6) + ' ETH'} />} />
                <Area
                  type="monotone"
                  dataKey="cumEth"
                  name="Cumulative ETH"
                  stroke="var(--warning)"
                  fill="url(#cumGrad)"
                  strokeWidth={2}
                  dot={false}
                />
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <div className="empty-state">No transaction history yet.</div>
          )}
        </div>
      </div>

      {/* ── Transaction table ─────────────────────────── */}
      <SectionHeader title="Recent Bot Transactions" />
      <div className="chart-card">
        {loading ? (
          <div className="loading">
            <div className="loading-dot"/><div className="loading-dot"/><div className="loading-dot"/>
          </div>
        ) : txns.length === 0 ? (
          <div className="empty-state">
            No transactions found yet.<br />
            Gas data syncs every 5 minutes from on-chain events.
          </div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Method</th>
                <th>Gas (ETH)</th>
                <th>Gas (USD)</th>
                <th>Status</th>
                <th>Tx Hash</th>
              </tr>
            </thead>
            <tbody>
              {txns.map((tx) => (
                <tr key={tx.tx_hash}>
                  <td>
                    <span className="mono text-muted" style={{ fontSize: 11 }}>
                      {tsToDateTime(tx.timestamp)}
                    </span>
                  </td>
                  <td>
                    <span className="mono" style={{ fontSize: 11 }}>
                      {tx.method_name || <span className="text-muted">—</span>}
                    </span>
                  </td>
                  <td>
                    <span className="mono text-warning" style={{ fontSize: 12 }}>
                      {(tx.gas_cost_eth || 0).toFixed(6)}
                    </span>
                  </td>
                  <td>
                    <span className="mono" style={{ fontSize: 11 }}>
                      ${(tx.gas_cost_usd || 0).toFixed(3)}
                    </span>
                  </td>
                  <td>
                    {tx.is_success
                      ? <span className="badge badge-success">OK</span>
                      : <span className="badge badge-danger">Failed</span>
                    }
                  </td>
                  <td>
                    <a
                      href={`https://basescan.org/tx/${tx.tx_hash}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="mono text-primary"
                      style={{ fontSize: 11, textDecoration: 'none' }}
                    >
                      {tx.tx_hash.slice(0, 10)}…
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* ── P&L summary ───────────────────────────────── */}
      <>
        <SectionHeader title="All-Time P&L Summary" />
        <div className="chart-card">
          {(() => {
            // All-time rewards = historically claimed + currently claimable
            const rewards        = liveData?.rewards || [];
            const claimableUsd   = rewards.reduce((s, r) => s + (r.earnedUsd || 0), 0);
            const totalRewardUsd = (claimsTotals.total_usd_claimed || 0) + claimableUsd;
            const gasUsd         = totals.total_usd || 0;
            const swapCostUsd    = swapTotals.total_cost_usd || 0;
            const netUsd         = totalRewardUsd - gasUsd - swapCostUsd;
            const positive       = netUsd >= 0;

            return (
              <div style={{ display: 'flex', gap: 40, flexWrap: 'wrap' }}>
                {[
                  { label: 'All-Time AERO (USD)', value: '$' + totalRewardUsd.toFixed(2), color: 'var(--success)' },
                  { label: 'Bot Gas (USD)',        value: '$' + gasUsd.toFixed(2),         color: 'var(--warning)' },
                  { label: 'Swap Costs (USD)',     value: '$' + swapCostUsd.toFixed(2),    color: 'var(--danger)'  },
                  { label: 'Net P&L',              value: (positive ? '+' : '') + '$' + netUsd.toFixed(2), color: positive ? 'var(--success)' : 'var(--danger)' },
                ].map(({ label, value, color }) => (
                  <div key={label}>
                    <div style={{ fontFamily: 'var(--font-display)', fontSize: 9, letterSpacing: 2, color: 'var(--text-muted)', marginBottom: 6, textTransform: 'uppercase' }}>
                      {label}
                    </div>
                    <div style={{ fontFamily: 'var(--font-mono)', fontSize: 26, color }}>
                      {value}
                    </div>
                  </div>
                ))}
              </div>
            );
          })()}
        </div>
      </>
    </div>
  );
}
