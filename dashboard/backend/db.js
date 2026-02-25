import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const db = new Database(join(__dirname, 'data.db'));

db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS position_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp INTEGER NOT NULL,
    token_id TEXT NOT NULL,
    manager_address TEXT,
    token0 TEXT,
    token1 TEXT,
    token0_symbol TEXT,
    token1_symbol TEXT,
    liquidity TEXT,
    tick_lower INTEGER,
    tick_upper INTEGER,
    current_tick INTEGER,
    is_in_range INTEGER,
    tokens_owed0 TEXT,
    tokens_owed1 TEXT,
    is_staked INTEGER DEFAULT 0,
    pool_address TEXT
  );

  CREATE TABLE IF NOT EXISTS reward_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp INTEGER NOT NULL,
    gauge_address TEXT NOT NULL,
    earned_amount TEXT NOT NULL,
    earned_usd REAL DEFAULT 0,
    aero_price REAL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS gas_transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp INTEGER,
    tx_hash TEXT UNIQUE NOT NULL,
    gas_used TEXT,
    gas_price TEXT,
    gas_cost_eth REAL,
    gas_cost_usd REAL DEFAULT 0,
    block_number INTEGER,
    method_name TEXT,
    is_success INTEGER DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS price_cache (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp INTEGER NOT NULL,
    symbol TEXT NOT NULL,
    price_usd REAL NOT NULL
  );

  CREATE TABLE IF NOT EXISTS reward_claims (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp INTEGER NOT NULL,
    tx_hash TEXT UNIQUE NOT NULL,
    amount_raw TEXT NOT NULL,
    amount REAL NOT NULL,
    amount_usd REAL DEFAULT 0,
    aero_price REAL DEFAULT 0,
    from_address TEXT,
    block_number INTEGER
  );

  CREATE TABLE IF NOT EXISTS swap_transactions (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp        INTEGER NOT NULL,
    tx_hash          TEXT UNIQUE NOT NULL,
    token_in         TEXT,
    token_in_address TEXT,
    amount_in        REAL,
    amount_in_usd    REAL DEFAULT 0,
    token_out        TEXT,
    token_out_address TEXT,
    amount_out       REAL,
    amount_out_usd   REAL DEFAULT 0,
    net_usd          REAL DEFAULT 0,
    gas_cost_eth     REAL DEFAULT 0,
    gas_cost_usd     REAL DEFAULT 0,
    total_cost_usd   REAL DEFAULT 0,
    router           TEXT,
    block_number     INTEGER
  );

  CREATE TABLE IF NOT EXISTS position_value_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp INTEGER NOT NULL,
    token_id TEXT NOT NULL,
    sol_amount REAL DEFAULT 0,
    usdc_amount REAL DEFAULT 0,
    sol_price REAL DEFAULT 0,
    fees_usd REAL DEFAULT 0,
    total_value_usd REAL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS lp_deposits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp INTEGER NOT NULL,
    tx_hash TEXT UNIQUE NOT NULL,
    amount REAL NOT NULL,
    token TEXT NOT NULL,
    amount_usd REAL DEFAULT 0,
    from_address TEXT,
    block_number INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_swaps_timestamp ON swap_transactions(timestamp);

  CREATE INDEX IF NOT EXISTS idx_pos_timestamp ON position_snapshots(timestamp);
  CREATE INDEX IF NOT EXISTS idx_pos_token_id ON position_snapshots(token_id);
  CREATE INDEX IF NOT EXISTS idx_rewards_timestamp ON reward_snapshots(timestamp);
  CREATE INDEX IF NOT EXISTS idx_gas_timestamp ON gas_transactions(timestamp);
  CREATE INDEX IF NOT EXISTS idx_price_timestamp ON price_cache(timestamp);
  CREATE INDEX IF NOT EXISTS idx_claims_timestamp ON reward_claims(timestamp);
  CREATE INDEX IF NOT EXISTS idx_pv_timestamp ON position_value_snapshots(timestamp);
  CREATE INDEX IF NOT EXISTS idx_pv_token_id ON position_value_snapshots(token_id);
  CREATE INDEX IF NOT EXISTS idx_deposits_timestamp ON lp_deposits(timestamp);
`);

export default db;
