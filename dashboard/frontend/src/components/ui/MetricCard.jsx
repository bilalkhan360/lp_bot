const ACCENT_COLORS = {
  primary: 'var(--primary)',
  success: 'var(--success)',
  warning: 'var(--warning)',
  danger:  'var(--danger)',
};

export default function MetricCard({
  label,
  value,
  sub,
  accent = 'primary',
  animDelay = 0,
}) {
  const color = ACCENT_COLORS[accent] || ACCENT_COLORS.primary;

  return (
    <div
      className="metric-card"
      style={{
        '--accent-color': color,
        animationDelay: `${animDelay}ms`,
        fontSize: 25,
      }}
    >
      <div className="metric-card__label">{label}</div>
      <div className="metric-card__value">{value ?? '—'}</div>
      {sub && <div className="metric-card__sub">{sub}</div>}
      <div className="metric-card__glow" />
    </div>
  );
}
