import { useFetch }    from '../../hooks/useFetch.jsx';
import { useDashboard } from '../../App.jsx';
import MetricCard     from '../ui/MetricCard.jsx';
import ChartTooltip  from '../ui/ChartTooltip.jsx';
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  BarChart, Bar,
} from 'recharts';

function SectionHeader({ title }) {
  return (
    <div className="section-header">
      <span className="section-title">{title}</span>
      <div className="section-line" />
    </div>
  );
}

function tsToDateTime(ts) {
  if (!ts) return '—';
  return new Date(ts * 1000).toLocaleString('en-US', {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function tsToDate(ts) {
  if (!ts) return '—';
  return new Date(ts * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export default function Swaps() {
  const { liveData } = useDashboard();
  const { data: swapsData, loading } = useFetch('/api/swaps');

  const prices   = liveData?.prices || {};
  const ethPrice = prices.ETH || 0;

  const totals = swapsData?.totals || {
    count: 0,
    total_slippage_usd: 0,
    total_gas_eth: 0,
    total_gas_usd: 0,
    total_cost_usd: 0,
  };
  const txns = swapsData?.transactions || [];

  // Group by day for bar chart (slippage cost per day)
  const dailyChart = (() => {
    if (!txns.length) return [];
    const byDay = {};
    for (const tx of txns) {
      if (!tx.timestamp) continue;
      const day = tsToDate(tx.timestamp);
      if (!byDay[day]) byDay[day] = { day, slippage: 0, gas: 0 };
      byDay[day].slippage += Math.max(0, tx.amount_in_usd - tx.amount_out_usd);
      byDay[day].gas      += tx.gas_cost_usd || 0;
    }
    return Object.values(byDay).reverse().map(d => ({
      ...d,
      slippage: parseFloat(d.slippage.toFixed(3)),
      gas:      parseFloat(d.gas.toFixed(3)),
    }));
  })();

  // Cumulative total cost chart
  const cumulChart = (() => {
    if (!txns.length) return [];
    let cum = 0;
    return txns
      .slice()
      .reverse()
      .map((tx) => {
        cum += tx.total_cost_usd || 0;
        return { day: tsToDate(tx.timestamp), cumUsd: parseFloat(cum.toFixed(3)) };
      });
  })();

  const slippageUsd = totals.total_slippage_usd || 0;
  const gasUsd      = totals.total_gas_usd       || 0;
  const totalCost   = totals.total_cost_usd      || 0;

  return (
    <div>
      {/* ── Metric cards ─────────────────────────────────── */}
      <div className="metric-grid">
        <MetricCard
          label="Total Swaps"
          value={String(totals.count || 0)}
          sub="via Odos · Aerodrome · Kyber"
          accent="primary"
          animDelay={0}
        />
        <MetricCard
          label="Slippage + Fees"
          value={slippageUsd > 0 ? '$' + slippageUsd.toFixed(2) : '—'}
          sub="USD lost on swap execution"
          accent="danger"
          animDelay={60}
        />
        <MetricCard
          label="Swap Gas Cost"
          value={totals.total_gas_eth > 0 ? parseFloat(totals.total_gas_eth).toFixed(6) + ' ETH' : '—'}
          sub={gasUsd > 0 ? '$' + gasUsd.toFixed(2) + ' USD' : 'Syncing…'}
          accent="warning"
          animDelay={120}
        />
        <MetricCard
          label="Total Swap Cost"
          value={totalCost > 0 ? '$' + totalCost.toFixed(2) : '—'}
          sub="Slippage + fees + gas"
          accent="danger"
          animDelay={180}
        />
      </div>

      {/* ── Charts ───────────────────────────────────────── */}
      <div className="page-grid">
        <div className="chart-card">
          <SectionHeader title="Daily Swap Cost (USD)" />
          {dailyChart.length > 0 ? (
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={dailyChart} margin={{ top: 4, right: 4, bottom: 0, left: -10 }}>
                <defs>
                  <linearGradient id="slipGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%"  stopColor="#ff4d6d" stopOpacity={0.9} />
                    <stop offset="95%" stopColor="#ff4d6d" stopOpacity={0.3} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(0,170,255,0.05)" />
                <XAxis dataKey="day" tick={{ fontSize: 10 }} interval="preserveStartEnd" />
                <YAxis tick={{ fontSize: 10 }} />
                <Tooltip content={<ChartTooltip formatter={(v) => '$' + v.toFixed(3)} />} />
                <Bar dataKey="slippage" name="Slippage+Fees" fill="url(#slipGrad)" radius={[2, 2, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="empty-state">No swap data yet — syncs every 5 minutes.</div>
          )}
        </div>

        <div className="chart-card">
          <SectionHeader title="Cumulative Swap Cost (USD)" />
          {cumulChart.length > 1 ? (
            <ResponsiveContainer width="100%" height={200}>
              <AreaChart data={cumulChart} margin={{ top: 4, right: 4, bottom: 0, left: -10 }}>
                <defs>
                  <linearGradient id="cumSlipGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%"  stopColor="#ff4d6d" stopOpacity={0.25} />
                    <stop offset="95%" stopColor="#ff4d6d" stopOpacity={0}    />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(0,170,255,0.05)" />
                <XAxis dataKey="day" tick={{ fontSize: 10 }} interval="preserveStartEnd" />
                <YAxis tick={{ fontSize: 10 }} />
                <Tooltip content={<ChartTooltip formatter={(v) => '$' + v.toFixed(3)} />} />
                <Area
                  type="monotone"
                  dataKey="cumUsd"
                  name="Cumulative Cost"
                  stroke="var(--danger)"
                  fill="url(#cumSlipGrad)"
                  strokeWidth={2}
                  dot={false}
                />
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <div className="empty-state">No swap history yet.</div>
          )}
        </div>
      </div>

      {/* ── Swap table ───────────────────────────────────── */}
      <SectionHeader title="Swap History" />
      <div className="chart-card">
        {loading ? (
          <div className="loading">
            <div className="loading-dot"/><div className="loading-dot"/><div className="loading-dot"/>
          </div>
        ) : txns.length === 0 ? (
          <div className="empty-state">
            No swaps found yet.<br />
            Swap data syncs every 5 minutes using Alchemy.
          </div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Router</th>
                <th>Swap</th>
                <th>Sent (USD)</th>
                <th>Received (USD)</th>
                <th>Slippage+Fees</th>
                <th>Gas</th>
                <th>Tx</th>
              </tr>
            </thead>
            <tbody>
              {txns.map((tx) => {
                const slippage = (tx.amount_in_usd || 0) - (tx.amount_out_usd || 0);
                const slippagePct = tx.amount_in_usd > 0
                  ? ((slippage / tx.amount_in_usd) * 100).toFixed(2)
                  : '0.00';
                return (
                  <tr key={tx.tx_hash}>
                    <td>
                      <span className="mono text-muted" style={{ fontSize: 11 }}>
                        {tsToDateTime(tx.timestamp)}
                      </span>
                    </td>
                    <td>
                      <span className="badge badge-primary" style={{ fontSize: 10 }}>
                        {tx.router || '—'}
                      </span>
                    </td>
                    <td>
                      <span className="mono" style={{ fontSize: 11 }}>
                        {tx.token_in || '?'} → {tx.token_out || '?'}
                      </span>
                    </td>
                    <td>
                      <span className="mono" style={{ fontSize: 11 }}>
                        ${(tx.amount_in_usd || 0).toFixed(2)}
                      </span>
                    </td>
                    <td>
                      <span className="mono" style={{ fontSize: 11 }}>
                        ${(tx.amount_out_usd || 0).toFixed(2)}
                      </span>
                    </td>
                    <td>
                      <span className="mono text-danger" style={{ fontSize: 11 }}>
                        ${slippage.toFixed(3)}
                        <span className="text-muted" style={{ marginLeft: 4 }}>({slippagePct}%)</span>
                      </span>
                    </td>
                    <td>
                      <span className="mono text-warning" style={{ fontSize: 11 }}>
                        ${(tx.gas_cost_usd || 0).toFixed(3)}
                      </span>
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
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* ── Cost breakdown ───────────────────────────────── */}
      <SectionHeader title="Swap Cost Breakdown" />
      <div className="chart-card">
        <div style={{ display: 'flex', gap: 40, flexWrap: 'wrap' }}>
          {[
            { label: 'Slippage + DEX Fees', value: '$' + slippageUsd.toFixed(2), color: 'var(--danger)' },
            { label: 'Gas on Swaps',         value: (totals.total_gas_eth || 0).toFixed(6) + ' ETH', color: 'var(--warning)' },
            { label: 'Gas on Swaps (USD)',    value: '$' + gasUsd.toFixed(2),     color: 'var(--warning)' },
            { label: 'Total Swap Cost',       value: '$' + totalCost.toFixed(2),  color: 'var(--danger)' },
          ].map(({ label, value, color }) => (
            <div key={label}>
              <div style={{ fontFamily: 'var(--font-display)', fontSize: 9, letterSpacing: 2, color: 'var(--text-muted)', marginBottom: 6, textTransform: 'uppercase' }}>
                {label}
              </div>
              <div style={{ fontFamily: 'var(--font-mono)', fontSize: 22, color }}>
                {value}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
