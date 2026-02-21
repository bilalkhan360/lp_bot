import { useDashboard }  from '../../App.jsx';
import { useFetch }       from '../../hooks/useFetch.jsx';
import MetricCard         from '../ui/MetricCard.jsx';
import ChartTooltip       from '../ui/ChartTooltip.jsx';
import {
  AreaChart, Area, BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine,
} from 'recharts';

function SectionHeader({ title, sub }) {
  return (
    <div className="section-header">
      <span className="section-title">{title}</span>
      {sub && <span style={{ fontFamily: 'var(--font-mono)', fontSize: 15, color: 'var(--text-muted)' }}>{sub}</span>}
      <div className="section-line" />
    </div>
  );
}

export default function Rewards() {
  const { liveData }                       = useDashboard();
  const { data: history, loading }         = useFetch('/api/rewards/history?limit=200');
  const { data: claimsData, loading: clL } = useFetch('/api/rewards/claims?limit=200');

  const rewards   = liveData?.rewards  || [];
  const prices    = liveData?.prices   || {};
  const aeroPrice = prices.AERO || 0;

  // Current claimable (unclaimed, from on-chain earned())
  const claimable    = rewards.reduce((s, r) => s + parseFloat(r.earnedAmount || 0), 0);
  const claimableUsd = rewards.reduce((s, r) => s + (r.earnedUsd || 0), 0);

  // Historical claimed (from token transfer events)
  const claimsTotals   = claimsData?.totals  || { claim_count: 0, total_aero_claimed: 0, total_usd_claimed: 0 };
  const claimsHistory  = claimsData?.claims  || [];
  const totalClaimed   = claimsTotals.total_aero_claimed || 0;
  const totalClaimedUsd = claimsTotals.total_usd_claimed || 0;

  // All-time total = claimed + currently sitting unclaimed
  const allTimeAero = totalClaimed + claimable;
  const allTimeUsd  = totalClaimedUsd + claimableUsd;

  // Claimable balance over time (from snapshots — shows accrual between claims)
  const accrualChart = (() => {
    if (!history?.length) return [];
    const byDay = {};
    for (const r of history) {
      const day = new Date(r.timestamp * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      const amt = parseFloat(r.earned_amount || 0);
      if (!byDay[day] || amt > byDay[day].aero) {
        byDay[day] = { day, aero: parseFloat(amt.toFixed(4)) };
      }
    }
    return Object.values(byDay).slice(-60);
  })();

  // Historical claims bar chart
  const claimsChart = claimsHistory.slice().reverse().map((c) => ({
    date:  new Date(c.timestamp * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
    aero:  parseFloat((c.amount || 0).toFixed(4)),
    usd:   parseFloat((c.amount_usd || 0).toFixed(2)),
  }));

  const maxAccrual = accrualChart.reduce((m, d) => Math.max(m, d.aero), 0);

  return (
    <div>
      {/* ── Summary cards ──────────────────────────────────── */}
      <div className="metric-grid">
        <MetricCard
          label="All-Time AERO Earned"
          value={allTimeAero > 0 ? allTimeAero.toFixed(4) : '—'}
          sub={`$${allTimeUsd.toFixed(2)} USD total`}
          accent="success"
          animDelay={0}
        />
        <MetricCard
          label="Currently Claimable"
          value={claimable > 0 ? claimable.toFixed(6) : '0'}
          sub={`$${claimableUsd.toFixed(2)} · ready to claim now`}
          accent="success"
          animDelay={60}
        />
        <MetricCard
          label="Total Claimed"
          value={totalClaimed > 0 ? totalClaimed.toFixed(4) : '—'}
          sub={`${claimsTotals.claim_count} claim tx · $${totalClaimedUsd.toFixed(2)} USD`}
          accent="primary"
          animDelay={120}
        />
        <MetricCard
          label="AERO Price"
          value={`$${aeroPrice.toFixed(4)}`}
          sub="Live via CoinGecko"
          accent="primary"
          animDelay={180}
        />
      </div>

      {/* ── Claim history (from on-chain token transfers) ────── */}
      <SectionHeader
        title="Claim History — On-Chain"
        sub="AERO token transfers from gauge to wallet"
      />
      <div className="chart-card">
        {clL ? (
          <div className="loading">
            <div className="loading-dot"/><div className="loading-dot"/><div className="loading-dot"/>
          </div>
        ) : claimsChart.length > 0 ? (
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={claimsChart} margin={{ top: 4, right: 4, bottom: 0, left: -8 }}>
              <defs>
                <linearGradient id="claimGrad" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%"  stopColor="#00e87a" stopOpacity={0.9} />
                  <stop offset="95%" stopColor="#00e87a" stopOpacity={0.3} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(0,170,255,0.05)" />
              <XAxis dataKey="date" tick={{ fontSize: 10 }} interval="preserveStartEnd" />
              <YAxis tick={{ fontSize: 10 }} />
              <Tooltip
                content={
                  <ChartTooltip
                    formatter={(v, name) =>
                      name === 'AERO Claimed' ? v.toFixed(4) + ' AERO' : '$' + v.toFixed(2)
                    }
                  />
                }
              />
              <Bar dataKey="aero" name="AERO Claimed" fill="url(#claimGrad)" radius={[2, 2, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        ) : (
          <div className="empty-state">
            No claim history found.<br />
            Claims appear here when AERO is transferred from the gauge to your wallet.<br />
            <span className="text-muted" style={{ fontSize: 15 }}>
              Requires BASESCAN_API_KEY in dashboard/.env
            </span>
          </div>
        )}
      </div>

      {/* Claim history table */}
      {claimsHistory.length > 0 && (
        <div className="chart-card" style={{ marginTop: 0 }}>
          <table className="data-table">
            <thead>
              <tr>
                <th>Date</th>
                <th>AERO Claimed</th>
                <th>USD Value</th>
                <th>Tx Hash</th>
              </tr>
            </thead>
            <tbody>
              {claimsHistory.slice(0, 20).map((c) => (
                <tr key={c.tx_hash}>
                  <td>
                    <span className="mono text-muted" style={{ fontSize: 15 }}>
                      {new Date(c.timestamp * 1000).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </td>
                  <td>
                    <span className="mono text-success" style={{ fontSize: 15 }}>
                      {(c.amount || 0).toFixed(6)} AERO
                    </span>
                  </td>
                  <td>
                    <span className="mono" style={{ fontSize: 15 }}>${(c.amount_usd || 0).toFixed(2)}</span>
                  </td>
                  <td>
                    <a
                      href={`https://basescan.org/tx/${c.tx_hash}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="mono text-primary"
                      style={{ fontSize: 15, textDecoration: 'none' }}
                    >
                      {c.tx_hash.slice(0, 10)}…
                    </a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* ── Accrual chart (claimable balance between claims) ─── */}
      <SectionHeader
        title="Claimable Balance Over Time"
        sub="Resets to 0 when claimed — shows accrual cycles"
      />
      <div className="chart-card">
        {loading ? (
          <div className="loading">
            <div className="loading-dot"/><div className="loading-dot"/><div className="loading-dot"/>
          </div>
        ) : accrualChart.length > 1 ? (
          <ResponsiveContainer width="100%" height={220}>
            <AreaChart data={accrualChart} margin={{ top: 10, right: 10, bottom: 0, left: -8 }}>
              <defs>
                <linearGradient id="gradAccrual" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%"  stopColor="#00e87a" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="#00e87a" stopOpacity={0}   />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(0,170,255,0.05)" />
              <XAxis dataKey="day" tick={{ fontSize: 10 }} interval="preserveStartEnd" />
              <YAxis tick={{ fontSize: 10 }} domain={[0, 'auto']} />
              <Tooltip content={<ChartTooltip formatter={(v) => v.toFixed(4) + ' AERO'} />} />
              {maxAccrual > 0 && (
                <ReferenceLine
                  y={maxAccrual}
                  stroke="rgba(0,232,122,0.2)"
                  strokeDasharray="6 3"
                  label={{ value: 'Peak', fill: '#00e87a', fontSize: 9 }}
                />
              )}
              <Area
                type="monotone"
                dataKey="aero"
                name="Claimable AERO"
                stroke="#00e87a"
                fill="url(#gradAccrual)"
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4, fill: '#00e87a' }}
              />
            </AreaChart>
          </ResponsiveContainer>
        ) : (
          <div className="empty-state">
            No snapshot data yet.<br />
            Dashboard records claimable balance every 30s — data builds up over time.
          </div>
        )}
      </div>

      {/* ── Per-gauge table ─────────────────────────────────── */}
      <SectionHeader title="Live Gauge Status" />
      <div className="chart-card">
        {rewards.length === 0 ? (
          <div className="empty-state">Connecting to gauges…</div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>Gauge</th>
                <th>Claimable Now</th>
                <th>USD</th>
                <th>AERO Price</th>
                <th>All-Time Claimed</th>
              </tr>
            </thead>
            <tbody>
              {rewards.map((r) => (
                <tr key={r.gaugeAddress}>
                  <td>
                    <span className="mono text-muted" style={{ fontSize: 11 }}>
                      {r.gaugeAddress.slice(0, 10)}…{r.gaugeAddress.slice(-6)}
                    </span>
                  </td>
                  <td>
                    <span className="mono text-success">
                      {parseFloat(r.earnedAmount || 0).toFixed(6)} AERO
                    </span>
                  </td>
                  <td>
                    <span className="mono">${(r.earnedUsd || 0).toFixed(2)}</span>
                  </td>
                  <td>
                    <span className="mono text-primary">
                      ${(r.aeroPrice || aeroPrice || 0).toFixed(4)}
                    </span>
                  </td>
                  <td>
                    <span className="mono text-success">
                      {totalClaimed > 0 ? totalClaimed.toFixed(4) + ' AERO' : '—'}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
