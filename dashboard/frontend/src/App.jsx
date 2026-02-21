import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { createContext, useContext, useState, useCallback } from 'react';
import Layout   from './components/Layout.jsx';
import Overview  from './components/pages/Overview.jsx';
import Positions from './components/pages/Positions.jsx';
import Rewards   from './components/pages/Rewards.jsx';
import Costs     from './components/pages/Costs.jsx';
import Swaps     from './components/pages/Swaps.jsx';
import { useWebSocket } from './hooks/useWebSocket.jsx';

export const DashboardCtx = createContext({});
export const useDashboard = () => useContext(DashboardCtx);

export default function App() {
  const [liveData,   setLiveData]   = useState(null);
  const [wsError,    setWsError]    = useState(null);

  const handleMessage = useCallback((msg) => {
    if (msg.type === 'snapshot') {
      setLiveData(msg.data);
      setWsError(null);
    } else if (msg.type === 'error') {
      setWsError(msg.message);
    }
  }, []);

  const { isConnected } = useWebSocket('ws://localhost:3001', handleMessage);

  return (
    <DashboardCtx.Provider value={{ liveData, isConnected, wsError }}>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Layout />}>
            <Route index element={<Navigate to="/overview" replace />} />
            <Route path="overview"  element={<Overview />} />
            <Route path="positions" element={<Positions />} />
            <Route path="rewards"   element={<Rewards />} />
            <Route path="costs"     element={<Costs />} />
            <Route path="swaps"     element={<Swaps />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </DashboardCtx.Provider>
  );
}
