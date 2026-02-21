# Aerodrome LP Bot + Dashboard (Base)

Automated CL (concentrated liquidity) position management for Aerodrome pools on Base, with a live analytics dashboard.

---

## Project Structure

```
lp_bot/
├── src/                        ← Bot source code
├── dashboard/
│   ├── backend/                ← Express API server + SQLite
│   │   └── data.db             ← auto-created on first run
│   └── frontend/               ← React + Vite dashboard UI
├── .env                        ← Bot config (private key, RPC, pool settings)
└── dashboard/.env              ← Dashboard config (wallet address, RPC)
```

---

## The Bot

### What it does

1. Connects to Base with your wallet.
2. Reads LP positions from the configured PositionManager + gauge.
3. Computes in-range / out-of-range status from current tick.
4. Auto-stakes unstaked positions that are in range.
5. Rebalances only when all conditions are true:
   - `AUTO_REBALANCE=true`
   - position is out of range
   - `% out of range >= REBALANCE_THRESHOLD`

If no LP exists, it can create a fresh position from wallet token balances for the configured pool.

### Rebalance flow

For a qualifying out-of-range position:
1. Unstake NFT from gauge (if staked).
2. Multicall withdraw on old position (decrease liquidity + collect + burn).
3. Read wallet balances.
4. Calculate target token ratio for new tick range.
5. Swap excess token via Kyber Aggregator.
6. Mint new position.
7. Stake new position to gauge.

### Bot setup

**Prerequisites:** Node.js >= 18, ETH on Base for gas.

```bash
npm install
cp .env.example .env
# fill in .env, then:
npm start
```

Check positions without running the bot:

```bash
npm run check-positions
```

### Bot config (`.env`)

Required:

```env
PRIVATE_KEY=
BASE_RPC_URL=https://base-mainnet.g.alchemy.com/v2/YOUR_KEY
```

Runtime controls:

```env
CHECK_INTERVAL=30000
AUTO_REBALANCE=false
REBALANCE_THRESHOLD=20
RANGE_MULTIPLIER=2.6
SLIPPAGE_BPS=300
GAS_STRATEGY=auto
MAX_GAS_PRICE=100
```

Kyber swap:

```env
KYBER_API_BASE_URL=https://aggregator-api.kyberswap.com
KYBER_CHAIN=base
KYBER_CLIENT_ID=lp_bot
KYBER_SOURCE=lp_bot
KYBER_INCLUDED_SOURCES=
KYBER_ALLOWED_ROUTERS=
```

Optional contract / token overrides (defaults are set in `src/config.js`):

```env
AERODROME_POSITION_MANAGER=
AERODROME_ALT_POSITION_MANAGER=
AERODROME_ROUTER=
AERODROME_FACTORY=
TOKEN_WETH=
TOKEN_USDC=
TOKEN_SOL=
TOKEN_AERO=
```

---

## The Dashboard

A live analytics UI for tracking rewards, gas costs, swap history, and LP position status.

### Dashboard setup

**Step 1 — Config**

```bash
cp dashboard/.env.example dashboard/.env
```

Edit `dashboard/.env`:

```env
BASE_RPC_URL=https://mainnet.base.org   # any RPC works for chain reads
ALCHEMY_API_KEY=YOUR_ALCHEMY_KEY        # required for tx history + price data
WALLET_ADDRESS=0xYourPublicWalletAddress
PORT=3001
POLL_INTERVAL=30000
```

> Only your **public** wallet address is needed — no private key.
> If `BASE_RPC_URL` is already an Alchemy URL, `ALCHEMY_API_KEY` is optional (parsed automatically).

**Step 2 — Backend**

```bash
cd dashboard/backend
npm install
node server.js
```

Runs on `http://localhost:3001`. Polls the chain every 30s, syncs historical data from Alchemy, and stores everything in `dashboard/backend/data.db`.

**Step 3 — Frontend** (separate terminal)

```bash
cd dashboard/frontend
npm install
npm run dev
```

Open **http://localhost:5173**.

### What the dashboard tracks

| Page | Data |
|------|------|
| Overview | Current position, tick range, AERO claimable, uncollected fees |
| Rewards | Historical AERO claims with USD values |
| Swaps | Full swap history with slippage, gas, and P&L per swap |
| Costs | Gas spend over time (bot operations + swaps) |
| Positions | LP position snapshots and range status history |

Prices use the **Alchemy Prices API** (5-minute historical candles at the exact swap timestamp).

---

## Running both with PM2

```bash
# Bot
pm2 start src/index.js --name lp-bot

# Dashboard backend
pm2 start dashboard/backend/server.js --name lp-dashboard-backend

# Dashboard frontend (build first)
cd dashboard/frontend && npm run build
pm2 serve dist 5173 --name lp-dashboard-frontend

pm2 save
```

---

## Risk notes

- Use a dedicated wallet with limited funds.
- Start with `AUTO_REBALANCE=false` and verify logs before enabling.
- Swap execution depends on Kyber API availability.
- Never commit `.env` files.
- DeFi smart contract risk and market risk apply. Use at your own risk.

---

## Troubleshooting

**Transaction reverted on swap**
- Check Kyber route/build response in logs
- Verify wallet has token balance and ETH for gas
- Verify token approvals to the Kyber router

**No positions detected**
- Confirm wallet address in logs
- Confirm gauge and PositionManager addresses in `src/config.js`

**Rebalance not triggering**
- Confirm `AUTO_REBALANCE=true`
- Check `% out of range` vs `REBALANCE_THRESHOLD` in logs

**Dashboard shows no data**
- Confirm `BASE_RPC_URL` is an Alchemy URL (required for tx history)
- Check backend logs for sync errors
