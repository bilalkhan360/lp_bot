import { useFetch }    from '../../hooks/useFetch.jsx';
import MetricCard     from '../ui/MetricCard.jsx';
import ChartTooltip  from '../ui/ChartTooltip.jsx';
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  ReferenceLine,
} from 'recharts';

function SectionHeader({ title }) {
  return (
    <div className="section-header">
      <span className="section-title">{title}</span>
      <div className="section-line" />
    </div>
  );
}

function tsToShort(ts) {
  if (!ts) return '';
  return new Date(ts * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export default function PositionValue() {
  const { data, loading } = useFetch('/api/position-value?limit=500');

  const snapshots = data?.snapshots || [];
  const pnl       = data?.pnl || {};

  const currentValue = pnl.currentValue || 0;
  const pnlValue     = pnl.pnl || 0;
  const pnlPercent   = pnl.pnlPercent || 0;
  const positive     = pnlValue >= 0;

  // Aggregate snapshots by hour for value chart
  const hourlyChart = (() => {
    if (!snapshots.length) return [];
    const byHour = new Map();
    for (const s of snapshots) {
      const hourKey = Math.floor(s.timestamp / 3600) * 3600;
      if (!byHour.has(hourKey) || s.timestamp > byHour.get(hourKey).timestamp) {
        byHour.set(hourKey, s);
      }
    }
    return [...byHour.values()]
      .sort((a, b) => a.timestamp - b.timestamp)
      .map(s => ({
        time: tsToShort(s.timestamp),
        ts: s.timestamp,
        value: parseFloat(s.total_value_usd.toFixed(2)),
        sol: parseFloat(s.sol_amount.toFixed(4)),
        usdc: parseFloat(s.usdc_amount.toFixed(2)),
      }));
  })();

  // P&L over time: value - firstValue
  const pnlChart = (() => {
    if (!snapshots.length) return [];
    const firstValue = snapshots[0]?.total_value_usd || 0;
    const byHour = new Map();
    for (const s of snapshots) {
      const hourKey = Math.floor(s.timestamp / 3600) * 3600;
      if (!byHour.has(hourKey) || s.timestamp > byHour.get(hourKey).timestamp) {
        byHour.set(hourKey, s);
      }
    }
    return [...byHour.values()]
      .sort((a, b) => a.timestamp - b.timestamp)
      .map(s => ({
        time: tsToShort(s.timestamp),
        ts: s.timestamp,
        pnl: parseFloat((s.total_value_usd - firstValue).toFixed(2)),
      }));
  })();

  return (
    <div>
      <div className="metric-grid">
        <MetricCard
          label="Current LP Value"
          value={currentValue > 0 ? '$' + currentValue.toFixed(2) : ''}
          sub={loading ? 'Loading...' : (pnl.trackingSince ? 'Tracking since ' + tsToShort(pnl.trackingSince) : 'No data yet')}
          accent="primary"
          animDelay={0}
        />
        <MetricCard
          label="Starting Value"
          value={pnl.firstValue > 0 ? '$' + pnl.firstValue.toFixed(2) : ''}
          sub="First recorded snapshot"
          accent="primary"
          animDelay={60}
        />
        <MetricCard
          label="P&L"
          value={snapshots.length > 0 ? (positive ? '+$' : '-$') + Math.abs(pnlValue).toFixed(2) : ''}
          sub={snapshots.length > 0 ? 'Since first snapshot' : 'Waiting for data...'}
          accent={positive ? 'success' : 'danger'}
          animDelay={120}
        />
        <MetricCard
          label="P&L %"
          value={snapshots.length > 0 ? (positive ? '+' : '') + pnlPercent.toFixed(2) + '%' : ''}
          sub="Change from start"
          accent={positive ? 'success' : 'danger'}
          animDelay={180}
        />
      </div>

      <div className="page-grid">
        <div className="chart-card">
          <SectionHeader title="Position Value (USD)" />
          {hourlyChart.length > 1 ? (
            <ResponsiveContainer width="100%" height={220}>
              <AreaChart data={hourlyChart} margin={{ top: 4, right: 4, bottom: 0, left: -10 }}>
                <defs>
                  <linearGradient id="valueGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%"  stopColor="var(--primary)" stopOpacity={0.25} />
                    <stop offset="95%" stopColor="var(--primary)" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(0,170,255,0.05)" />
                <XAxis dataKey="time" tick={{ fontSize: 10 }} interval="preserveStartEnd" />
                <YAxis tick={{ fontSize: 10 }} domain={['auto', 'auto']} />
                <Tooltip content={<ChartTooltip formatter={(v) => '$' + v.toFixed(2)} />} />
                <Area
                  type="monotone"
                  dataKey="value"
                  name="Value"
                  stroke="var(--primary)"
                  fill="url(#valueGrad)"
                  strokeWidth={2}
                  dot={false}
                />
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <div className="empty-state">Collecting value snapshots... check back in a few minutes.</div>
          )}
        </div>

        <div className="chart-card">
          <SectionHeader title="P&L Over Time (USD)" />
          {pnlChart.length > 1 ? (
            <ResponsiveContainer width="100%" height={220}>
              <AreaChart data={pnlChart} margin={{ top: 4, right: 4, bottom: 0, left: -10 }}>
                <defs>
                  <linearGradient id="pnlGradPos" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%"  stopColor="var(--success)" stopOpacity={0.25} />
                    <stop offset="95%" stopColor="var(--success)" stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="pnlGradNeg" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%"  stopColor="var(--danger)" stopOpacity={0.25} />
                    <stop offset="95%" stopColor="var(--danger)" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(0,170,255,0.05)" />
                <XAxis dataKey="time" tick={{ fontSize: 10 }} interval="preserveStartEnd" />
                <YAxis tick={{ fontSize: 10 }} domain={['auto', 'auto']} />
                <ReferenceLine y={0} stroke="rgba(255,255,255,0.15)" strokeDasharray="3 3" />
                <Tooltip content={<ChartTooltip formatter={(v) => (v >= 0 ? '+$' : '-$') + Math.abs(v).toFixed(2)} />} />
                <Area
                  type="monotone"
                  dataKey="pnl"
                  name="P&L"
                  stroke={positive ? 'var(--success)' : 'var(--danger)'}
                  fill={positive ? 'url(#pnlGradPos)' : 'url(#pnlGradNeg)'}
                  strokeWidth={2}
                  dot={false}
                />
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <div className="empty-state">Need more data points for P&L chart.</div>
          )}
        </div>
      </div>
    </div>
  );
}
