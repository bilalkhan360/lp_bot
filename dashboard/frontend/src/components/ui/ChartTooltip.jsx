export default function ChartTooltip({ active, payload, label, formatter }) {
  if (!active || !payload?.length) return null;

  return (
    <div className="custom-tooltip">
      <div className="tt-label">{label}</div>
      {payload.map((p, i) => (
        <div key={i} className="tt-row">
          <span style={{ color: p.color || 'var(--text-muted)' }}>{p.name}</span>
          <span>{formatter ? formatter(p.value, p.name) : p.value}</span>
        </div>
      ))}
    </div>
  );
}
