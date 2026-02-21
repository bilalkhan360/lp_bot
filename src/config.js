require('dotenv').config();

module.exports = {
  // Wallet configuration
  privateKey: process.env.PRIVATE_KEY || '',
  
  // Network configuration
  baseRpcUrl: process.env.BASE_RPC_URL || 'https://mainnet.base.org',
  
  // Bot settings
  checkInterval: parseInt(process.env.CHECK_INTERVAL) || 30000,
  slippageBps: parseInt(process.env.SLIPPAGE_BPS) || 300,
  minSwapValueUsdc: parseFloat(process.env.MIN_SWAP_VALUE_USDC) || 20,
  gasStrategy: process.env.GAS_STRATEGY || 'auto',
  maxGasPrice: parseInt(process.env.MAX_GAS_PRICE) || 100,
  priorityFeeGwei: parseFloat(process.env.PRIORITY_FEE_GWEI) || 0.001,
  rpcCallTimeoutMs: parseInt(process.env.RPC_CALL_TIMEOUT_MS) || 30000,
  txWaitTimeoutMs: parseInt(process.env.TX_WAIT_TIMEOUT_MS) || 180000,
  autoRebalance: process.env.AUTO_REBALANCE === 'true',
  
  // Range multiplier for rebalancing (0.5 = 15 ticks each side, 1 = 30 ticks each side)
  rangeMultiplier: parseFloat(process.env.RANGE_MULTIPLIER) || 2.6,
  
  // Out-of-range threshold percentage to trigger rebalance
  rebalanceThreshold: parseFloat(process.env.REBALANCE_THRESHOLD) || 20,
  
  // Monitored positions (format: poolAddress:token0:token1:feeTier)
  monitoredPositions: (process.env.MONITORED_POSITIONS || '').split(',').filter(p => p.trim() !== ''),

  // Kyber Aggregator configuration (used for token swaps)
  kyber: {
    apiBaseUrl: process.env.KYBER_API_BASE_URL || 'https://aggregator-api.kyberswap.com',
    chain: process.env.KYBER_CHAIN || 'base',
    clientId: process.env.KYBER_CLIENT_ID || 'lp_bot',
    source: process.env.KYBER_SOURCE || 'lp_bot',
    // Empty string allows all supported sources (best route).
    includedSources: process.env.KYBER_INCLUDED_SOURCES || '',
    // Optional router allowlist (comma separated). Empty disables allowlist check.
    allowedRouters: (process.env.KYBER_ALLOWED_ROUTERS || '')
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean)
  },
  
  // ============================================================
  // AERODROME CONTRACTS - Base Mainnet
  // 
  // IMPORTANT: Verify these addresses at:
  // https://docs.aerodrome.finance/contracts
  // 
  // These can be overridden via environment variables:
  // - AERODROME_POSITION_MANAGER
  // - AERODROME_ROUTER
  // - AERODROME_FACTORY
  // ============================================================
  aerodrome: {
    // NonfungiblePositionManager - handles V3 LP positions (VERIFIED)
    positionManager: process.env.AERODROME_POSITION_MANAGER || '0x827922686190790b37229fd06084350E74485b72',
    
    // Alternative PositionManager for specific pools (USER SPECIFIED)
    altPositionManager: process.env.AERODROME_ALT_POSITION_MANAGER || '0xa990C6a764b73BF43cee5Bb40339c3322FB9D55F',
    
    // Router - legacy setting (current swap execution uses Kyber router from API response)
    router: process.env.AERODROME_ROUTER || '0x6Df1c91424F79E40E33B1A48F0687B666bE71075',
    
    // Factory - for finding pools (USER SPECIFIED)
    factory: process.env.AERODROME_FACTORY || '0xaDe65c38CD4849aDBA595a4323a8C7DdfE89716a',
  },
  
  // ============================================================
  // COMMON TOKEN ADDRESSES - Base Mainnet
  // 
  // Verify at: https://docs.base.org/tokens
  // ============================================================
  tokens: {
    // WETH (Canonical on Base)
    WETH: process.env.TOKEN_WETH || '0x4200000000000000000000000000000000000006',
    
    // USDC (Canonical on Base)
    USDC: process.env.TOKEN_USDC || '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    
    // cbBTC (Coinbase Wrapped BTC)
    cbBTC: process.env.TOKEN_CBBTC || '0xcbB7e00086518eEe1072D2C2B9E72b7974B9763',
    
    // DAI
    DAI: process.env.TOKEN_DAI || '0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb',
    
    // AERO (Aerodrome governance/rewards token)
    AERO: process.env.TOKEN_AERO || '0x940181a94A35A4569e4529d1eD8d740276BD0900',
    
    // SOL
    SOL: process.env.TOKEN_SOL || '0x311935cd80b76769bf2ecc9d8ab7635b2139cf82',
  },
  
  // Staking gauge factories (used to find gauges for pools)
  gaugeFactories: (process.env.GAUGE_FACTORIES || '0x35f35cA5B132CaDf2916BaB57639128eAC5bbcb5,0xD30677bd8dd15132F251Cb54CbDA552d2A05Fb08').split(','),
  
  // Staking gauge addresses - ONLY the one specified by user
  gauges: ['0xC6e211fF1D04A1728ab011406AD42EF529Cb3886'],
};
