import { useDashboard } from '../../App.jsx';
import { useFetch }      from '../../hooks/useFetch.jsx';
import MetricCard        from '../ui/MetricCard.jsx';
import ChartTooltip      from '../ui/ChartTooltip.jsx';
import { useState }      from 'react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts';

function SectionHeader({ title }) {
  return (
    <div className="section-header">
      <span className="section-title">{title}</span>
      <div className="section-line" />
    </div>
  );
}

function RangeBar({ lower, upper, current }) {
  if (current == null) return <span className="text-muted mono" style={{ fontSize: 10 }}>—</span>;

  const span   = upper - lower;
  const clamp  = Math.max(lower, Math.min(upper, current));
  const pct    = span > 0 ? ((clamp - lower) / span) * 100 : 50;
  const inRange = current >= lower && current < upper;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, minWidth: 120 }}>
      <div style={{
        height: 6,
        background: 'var(--surface-2)',
        borderRadius: 3,
        position: 'relative',
        overflow: 'hidden',
        border: '1px solid var(--border)',
      }}>
        <div style={{
          position: 'absolute',
          left: `${pct}%`,
          top: 0,
          bottom: 0,
          width: 2,
          background: inRange ? 'var(--success)' : 'var(--danger)',
          boxShadow: `0 0 6px ${inRange ? 'var(--success)' : 'var(--danger)'}`,
          transform: 'translateX(-50%)',
        }} />
      </div>
      <div className="mono text-muted" style={{ fontSize: 9, display: 'flex', justifyContent: 'space-between' }}>
        <span>{lower}</span>
        <span style={{ color: inRange ? 'var(--success)' : 'var(--danger)' }}>
          {current}
        </span>
        <span>{upper}</span>
      </div>
    </div>
  );
}

function PositionHistoryChart({ tokenId }) {
  const { data, loading } = useFetch(`/api/positions/history?tokenId=${tokenId}&limit=50`);

  if (loading) return <div className="loading"><div className="loading-dot"/><div className="loading-dot"/><div className="loading-dot"/></div>;
  if (!data?.length) return <div className="empty-state">No historical data yet.</div>;

  const chartData = data.slice().reverse().map((r) => ({
    time:    new Date(r.timestamp * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    tick:    r.current_tick,
    lower:   r.tick_lower,
    upper:   r.tick_upper,
  }));

  return (
    <ResponsiveContainer width="100%" height={160}>
      <LineChart data={chartData} margin={{ top: 4, right: 4, bottom: 0, left: -10 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="rgba(0,170,255,0.05)" />
        <XAxis dataKey="time" tick={{ fontSize: 9 }} interval="preserveStartEnd" />
        <YAxis tick={{ fontSize: 9 }} domain={['auto', 'auto']} />
        <Tooltip content={<ChartTooltip />} />
        <Line type="monotone" dataKey="tick"  name="Current Tick" stroke="var(--primary)"  strokeWidth={2} dot={false} />
        <Line type="monotone" dataKey="lower" name="Lower"        stroke="var(--danger)"   strokeWidth={1} dot={false} strokeDasharray="4 2" />
        <Line type="monotone" dataKey="upper" name="Upper"        stroke="var(--success)"  strokeWidth={1} dot={false} strokeDasharray="4 2" />
      </LineChart>
    </ResponsiveContainer>
  );
}

export default function Positions() {
  const { liveData }    = useDashboard();
  const [expanded, setExpanded] = useState(null);

  const positions = liveData?.positions || [];
  const inRange   = positions.filter((p) => p.isInRange === true).length;
  const outRange  = positions.filter((p) => p.isInRange === false).length;

  const totalLiquidity = positions.reduce((s, p) => s + BigInt(p.liquidity || 0), 0n);

  return (
    <div>
      <div className="metric-grid">
        <MetricCard label="Total Positions" value={positions.length} accent="primary" animDelay={0} />
        <MetricCard label="In Range"  value={inRange}  sub="Within tick bounds" accent="success" animDelay={60} />
        <MetricCard label="Out of Range" value={outRange} sub="Need rebalancing" accent={outRange > 0 ? 'danger' : 'primary'} animDelay={120} />
        <MetricCard
          label="Combined Liquidity"
          value={totalLiquidity > 0n ? (Number(totalLiquidity / 1_000_000_000_000n) / 1_000_000).toFixed(2) + 'T' : '—'}
          sub="Raw liquidity units (combined)"
          accent="primary"
          animDelay={180}
        />
      </div>

      <SectionHeader title="LP Positions" />

      {positions.length === 0 ? (
        <div className="chart-card">
          <div className="empty-state">
            {liveData
              ? 'No active positions found.'
              : 'Waiting for backend connection…'}
          </div>
        </div>
      ) : (
        positions.map((pos, idx) => {
          const isExp = expanded === pos.tokenId;
          const inR   = pos.isInRange === true;
          const outR  = pos.isInRange === false;

          return (
            <div
              key={pos.tokenId}
              className="chart-card"
              style={{ marginBottom: 10, animationDelay: `${idx * 40}ms` }}
            >
              {/* ── Header row ──────────────────────────────── */}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 16,
                  cursor: 'pointer',
                  userSelect: 'none',
                }}
                onClick={() => setExpanded(isExp ? null : pos.tokenId)}
              >
                <div className="token-pair" style={{ minWidth: 110 }}>
                  <span>{pos.token0Symbol}</span>
                  <span className="token-pair-sep">/</span>
                  <span>{pos.token1Symbol}</span>
                </div>

                <span className="mono text-muted" style={{ fontSize: 11 }}>
                  #{pos.tokenId}
                </span>

                {inR  && <span className="badge badge-success">● In Range</span>}
                {outR && <span className="badge badge-danger">● Out of Range</span>}
                {!inR && !outR && <span className="badge badge-warning">? Unknown</span>}

                {pos.isStaked && (
                  <span className="badge badge-primary">Staked</span>
                )}

                <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 20 }}>
                  <div style={{ textAlign: 'right' }}>
                    <div className="mono text-muted" style={{ fontSize: 9, letterSpacing: 1 }}>FEES OWED</div>
                    <div className="mono text-success" style={{ fontSize: 11 }}>
                      {parseFloat(pos.tokensOwed0 || 0).toFixed(6)} {pos.token0Symbol}
                    </div>
                    <div className="mono text-success" style={{ fontSize: 11 }}>
                      {parseFloat(pos.tokensOwed1 || 0).toFixed(6)} {pos.token1Symbol}
                    </div>
                  </div>
                  <span style={{ color: 'var(--text-muted)', fontSize: 14, transition: 'transform 0.2s', transform: isExp ? 'rotate(180deg)' : 'none' }}>
                    ▾
                  </span>
                </div>
              </div>

              {/* ── Expanded detail ─────────────────────────── */}
              {isExp && (
                <div style={{ marginTop: 18, borderTop: '1px solid var(--border)', paddingTop: 16 }}>
                  {/* Tick range bar */}
                  <div style={{ display: 'flex', gap: 32, marginBottom: 18, flexWrap: 'wrap' }}>
                    <div>
                      <div className="mono text-muted" style={{ fontSize: 9, letterSpacing: 2, marginBottom: 8 }}>TICK RANGE</div>
                      <RangeBar lower={pos.tickLower} upper={pos.tickUpper} current={pos.currentTick} />
                    </div>

                    <div>
                      <div className="mono text-muted" style={{ fontSize: 9, letterSpacing: 2, marginBottom: 6 }}>DETAILS</div>
                      <table style={{ borderCollapse: 'collapse' }}>
                        {[
                          ['Tick Lower',   pos.tickLower],
                          ['Tick Upper',   pos.tickUpper],
                          ['Current Tick', pos.currentTick ?? '—'],
                          ['Tick Spacing', pos.tickSpacing],
                          ['Liquidity',    BigInt(pos.liquidity || 0).toLocaleString()],
                          ['Pool',         pos.poolAddress ? pos.poolAddress.slice(0, 10) + '…' : '—'],
                        ].map(([k, v]) => (
                          <tr key={k}>
                            <td style={{ color: 'var(--text-muted)', fontSize: 11, paddingRight: 16, paddingBottom: 3, fontFamily: 'var(--font-body)' }}>{k}</td>
                            <td className="mono" style={{ fontSize: 11 }}>{v}</td>
                          </tr>
                        ))}
                      </table>
                    </div>
                  </div>

                  {/* Tick history chart */}
                  <div>
                    <div className="mono text-muted" style={{ fontSize: 9, letterSpacing: 2, marginBottom: 10 }}>TICK HISTORY</div>
                    <PositionHistoryChart tokenId={pos.tokenId} />
                  </div>
                </div>
              )}
            </div>
          );
        })
      )}
    </div>
  );
}
