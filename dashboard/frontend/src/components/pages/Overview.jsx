import { useDashboard } from '../../App.jsx';
import { useFetch }      from '../../hooks/useFetch.jsx';
import MetricCard        from '../ui/MetricCard.jsx';
import ChartTooltip      from '../ui/ChartTooltip.jsx';
import {
  AreaChart, Area,
  BarChart,  Bar,
  XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer,
} from 'recharts';

// ── Formatters ────────────────────────────────────────────────

const fmt = {
  eth:  (v) => v == null ? '—' : parseFloat(v).toFixed(5) + ' ETH',
  usd:  (v) => v == null ? '—' : '$' + parseFloat(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
  aero: (v) => v == null ? '—' : parseFloat(v).toLocaleString('en-US', { maximumFractionDigits: 2 }),
  n:    (v) => v == null ? '—' : String(v),
};

// ── Subcomponents ─────────────────────────────────────────────

function SectionHeader({ title }) {
  return (
    <div className="section-header">
      <span className="section-title">{title}</span>
      <div className="section-line" />
    </div>
  );
}

// ── Overview page ─────────────────────────────────────────────

export default function Overview() {
  const { liveData } = useDashboard();

  const { data: summary }        = useFetch('/api/summary');
  const { data: rewardsHistory } = useFetch('/api/rewards/history?limit=5000');
  const { data: claimsData }     = useFetch('/api/rewards/claims?limit=1');

  const positions    = liveData?.positions || [];
  const rewards      = liveData?.rewards   || [];
  const prices       = liveData?.prices    || {};

  const totalAero    = rewards.reduce((s, r) => s + parseFloat(r.earnedAmount || 0), 0);
  const totalAeroUsd = rewards.reduce((s, r) => s + (r.earnedUsd || 0), 0);

  const inRange  = positions.filter((p) => p.isInRange === true).length;
  const outRange = positions.filter((p) => p.isInRange === false).length;

  const gasTotalEth    = summary?.gas?.total_eth || 0;
  const gasTotalUsd    = summary?.gas?.total_usd || 0;
  const txCount        = summary?.gas?.tx_count  || 0;
  const claimsTotals   = claimsData?.totals || { total_aero_claimed: 0, total_usd_claimed: 0 };
  const allTimeAero    = (claimsTotals.total_aero_claimed || 0) + totalAero;
  const allTimeAeroUsd = (claimsTotals.total_usd_claimed || 0) + totalAeroUsd;

  // Build rewards chart data — deduplicate by hour, take last reading per hour
  const rewardsChart = (() => {
    if (!rewardsHistory?.length) return [];
    const byHour = {};
    for (const r of rewardsHistory) {
      const d = new Date(r.timestamp * 1000);
      const key = `${d.getMonth()}-${d.getDate()}-${d.getHours()}`;
      const label = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) +
                    ' ' + d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
      byHour[key] = { day: label, aero: parseFloat(r.earned_amount).toFixed(3), usd: (r.earned_usd || 0).toFixed(2) };
    }
    return Object.values(byHour).slice(-48);
  })();

  // Build daily gas chart from summary
  const gasChart = (summary?.dailyGas || []).map((d) => ({
    day: new Date(d.day).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
    eth: parseFloat(d.eth || 0).toFixed(5),
    txs: d.tx_count,
  }));

  return (
    <div>
      {/* ── Metric cards ───────────────────────────────── */}
      <div className="metric-grid">
        <MetricCard
          label="Active Positions"
          value={fmt.n(positions.length)}
          sub={`${inRange} in range · ${outRange} out of range`}
          accent="primary"
          animDelay={0}
        />
        <MetricCard
          label="All-Time AERO"
          value={fmt.aero(allTimeAero)}
          sub={fmt.usd(allTimeAeroUsd) + ' · ' + fmt.aero(totalAero) + ' claimable now'}
          accent="success"
          animDelay={60}
        />
        <MetricCard
          label="Gas Spent"
          value={gasTotalEth > 0 ? parseFloat(gasTotalEth).toFixed(5) + ' ETH' : '—'}
          sub={gasTotalUsd > 0 ? fmt.usd(gasTotalUsd) : 'Syncing…'}
          accent="warning"
          animDelay={120}
        />
        <MetricCard
          label="Bot Transactions"
          value={fmt.n(txCount)}
          sub={`AERO: $${(prices.AERO || 0).toFixed(3)} · ETH: ${fmt.usd(prices.ETH)}`}
          accent="primary"
          animDelay={180}
        />
      </div>

      {/* ── Charts ─────────────────────────────────────── */}
      <div className="page-grid">

        {/* AERO rewards over time */}
        <div className="chart-card">
          <SectionHeader title="AERO Rewards — Historical" />
          {rewardsChart.length > 1 ? (
            <ResponsiveContainer width="100%" height={200}>
              <AreaChart data={rewardsChart} margin={{ top: 4, right: 4, bottom: 0, left: -10 }}>
                <defs>
                  <linearGradient id="gradAero" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%"   stopColor="#00e87a" stopOpacity={0.28} />
                    <stop offset="95%"  stopColor="#00e87a" stopOpacity={0}    />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(0,170,255,0.05)" />
                <XAxis dataKey="day" tick={{ fontSize: 10 }} interval="preserveStartEnd" />
                <YAxis tick={{ fontSize: 10 }} />
                <Tooltip content={<ChartTooltip />} />
                <Area
                  type="monotone"
                  dataKey="aero"
                  name="AERO"
                  stroke="#00e87a"
                  fill="url(#gradAero)"
                  strokeWidth={2}
                  dot={false}
                />
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <div className="empty-state">
              No reward snapshots yet.<br />
              Data builds up as the dashboard runs.
            </div>
          )}
        </div>

        {/* Daily gas cost */}
        <div className="chart-card">
          <SectionHeader title="Daily Gas Cost (ETH)" />
          {gasChart.length > 0 ? (
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={gasChart} margin={{ top: 4, right: 4, bottom: 0, left: -10 }}>
                <defs>
                  <linearGradient id="gradGas" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%"  stopColor="#ffb020" stopOpacity={0.9} />
                    <stop offset="95%" stopColor="#ffb020" stopOpacity={0.3} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(0,170,255,0.05)" />
                <XAxis dataKey="day" tick={{ fontSize: 10 }} interval="preserveStartEnd" />
                <YAxis tick={{ fontSize: 10 }} />
                <Tooltip content={<ChartTooltip />} />
                <Bar dataKey="eth" name="ETH" fill="url(#gradGas)" radius={[2, 2, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="empty-state">No gas data yet — syncs every 5 minutes.</div>
          )}
        </div>
      </div>

      {/* ── Current positions table ─────────────────────── */}
      <SectionHeader title="Current Positions" />
      <div className="chart-card">
        {positions.length === 0 ? (
          <div className="empty-state">
            {liveData
              ? 'No active positions found for this wallet.'
              : 'Connecting to backend…'}
          </div>
        ) : (
          <table className="data-table">
            <thead>
              <tr>
                <th>Pair</th>
                <th>Token ID</th>
                <th>Status</th>
                <th>Tick Range</th>
                <th>Current Tick</th>
                <th>Fees Owed</th>
              </tr>
            </thead>
            <tbody>
              {positions.map((pos) => (
                <tr key={pos.tokenId}>
                  <td>
                    <div className="token-pair">
                      <span>{pos.token0Symbol}</span>
                      <span className="token-pair-sep">/</span>
                      <span>{pos.token1Symbol}</span>
                    </div>
                  </td>
                  <td>
                    <span className="mono text-muted">#{pos.tokenId}</span>
                  </td>
                  <td>
                    {pos.isInRange === true && (
                      <span className="badge badge-success">● In Range</span>
                    )}
                    {pos.isInRange === false && (
                      <span className="badge badge-danger">● Out</span>
                    )}
                    {pos.isInRange === null && (
                      <span className="badge badge-warning">? Unknown</span>
                    )}
                  </td>
                  <td>
                    <span className="mono text-muted" style={{ fontSize: 11 }}>
                      {pos.tickLower} → {pos.tickUpper}
                    </span>
                  </td>
                  <td>
                    <span className="mono text-primary" style={{ fontSize: 11 }}>
                      {pos.currentTick ?? '—'}
                    </span>
                  </td>
                  <td>
                    <div className="mono text-success" style={{ fontSize: 11, lineHeight: 1.7 }}>
                      {parseFloat(pos.tokensOwed0 || 0).toFixed(6)} {pos.token0Symbol}
                      <br />
                      {parseFloat(pos.tokensOwed1 || 0).toFixed(6)} {pos.token1Symbol}
                    </div>
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
