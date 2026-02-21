import { Outlet, NavLink } from 'react-router-dom';
import { useDashboard } from '../App.jsx';
import { useEffect, useState } from 'react';

const NAV = [
  {
    to: '/overview',
    label: 'Overview',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="nav-icon">
        <rect x="3" y="3" width="7" height="7" rx="1"/>
        <rect x="14" y="3" width="7" height="7" rx="1"/>
        <rect x="3" y="14" width="7" height="7" rx="1"/>
        <rect x="14" y="14" width="7" height="7" rx="1"/>
      </svg>
    ),
  },
  {
    to: '/positions',
    label: 'Positions',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="nav-icon">
        <path d="M4 6h16M4 10h16M4 14h10M4 18h6"/>
      </svg>
    ),
  },
  {
    to: '/rewards',
    label: 'AERO Rewards',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="nav-icon">
        <polygon points="12,2 15.09,8.26 22,9.27 17,14.14 18.18,21.02 12,17.77 5.82,21.02 7,14.14 2,9.27 8.91,8.26"/>
      </svg>
    ),
  },
  {
    to: '/costs',
    label: 'Gas & Fees',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="nav-icon">
        <path d="M3 3h18v4H3zM3 10h18v4H3zM3 17h18v4H3z" opacity="0"/>
        <rect x="2" y="7" width="20" height="10" rx="1"/>
        <path d="M6 12h12M12 9v6"/>
      </svg>
    ),
  },
  {
    to: '/swaps',
    label: 'Swaps',
    icon: (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="nav-icon">
        <path d="M7 16V4m0 0L3 8m4-4l4 4"/>
        <path d="M17 8v12m0 0l4-4m-4 4l-4-4"/>
      </svg>
    ),
  },
];

export default function Layout() {
  const { liveData, isConnected, wsError } = useDashboard();
  const [now, setNow] = useState(new Date());

  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);

  const wallet = liveData?.walletAddress;
  const shortWallet = wallet
    ? `${wallet.slice(0, 6)}...${wallet.slice(-4)}`
    : null;

  const lastUpdate = liveData?.timestamp
    ? new Date(liveData.timestamp * 1000).toLocaleTimeString()
    : null;

  const handleRefresh = () => {
    fetch('/api/refresh', { method: 'POST' }).catch(() => {});
  };

  return (
    <div className="layout">
      {/* ── Top bar ─────────────────────────────────────────── */}
      <header className="topbar">
        <span className="topbar-brand">LP Terminal</span>

        <div className="topbar-divider" />

        <div className={`live-badge`} style={{ color: isConnected ? 'var(--success)' : 'var(--danger)' }}>
          <span className={`live-dot ${isConnected ? 'online' : 'offline'}`} />
          {isConnected ? 'Live' : 'Offline'}
        </div>

        {shortWallet && (
          <>
            <div className="topbar-divider" />
            <span className="topbar-wallet" title={wallet}>{shortWallet}</span>
          </>
        )}

        {wsError && (
          <span style={{ color: 'var(--danger)', fontSize: 11, fontFamily: 'var(--font-mono)' }}>
            {wsError}
          </span>
        )}

        <div className="topbar-right">
          {lastUpdate && (
            <span className="topbar-time">updated {lastUpdate}</span>
          )}
          <button className="btn-refresh" onClick={handleRefresh}>
            ↻ Refresh
          </button>
        </div>
      </header>

      {/* ── Sidebar ─────────────────────────────────────────── */}
      <aside className="sidebar">
        <div className="sidebar-section-label">Navigation</div>
        <ul className="nav-list">
          {NAV.map(({ to, label, icon }) => (
            <li key={to}>
              <NavLink
                to={to}
                className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}
              >
                {icon}
                {label}
              </NavLink>
            </li>
          ))}
        </ul>

        {/* Bottom: clock */}
        <div style={{
          position: 'absolute',
          bottom: 16,
          left: 0,
          right: 0,
          padding: '0 18px',
          fontFamily: 'var(--font-mono)',
          fontSize: 10,
          color: 'var(--text-dim)',
        }}>
          {now.toLocaleTimeString()}
        </div>
      </aside>

      {/* ── Content ─────────────────────────────────────────── */}
      <main className="content">
        <Outlet />
      </main>
    </div>
  );
}
