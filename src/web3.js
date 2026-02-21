const { ethers, Contract } = require('ethers');
const config = require('./config');
const logger = require('./logger');

// ERC20 ABI for token interactions
const ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)',
];

// Aerodrome V3 NonfungiblePositionManager ABI (simplified)
const POSITION_MANAGER_ABI = [
  'function positions(uint256 tokenId) view returns (tuple(uint96 nonce, address operator, address token0, address token1, int24 tickSpacing, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1))',
  'function decreaseLiquidity(tuple(uint256 tokenId, uint128 liquidity, uint256 amount0Min, uint256 amount1Min, uint256 deadline)) returns (uint256 amount0, uint256 amount1)',
  'function increaseLiquidity(tuple(uint256 tokenId, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, uint256 deadline, address recipient)) returns (uint256 amount0, uint256 amount1)',
  'function collect(tuple(uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max)) returns (uint256 amount0, uint256 amount1)',
  'function mint(tuple(address token0, address token1, int24 tickSpacing, int24 tickLower, int24 tickUpper, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, address recipient, uint256 deadline)) returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)',
  'function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)',
  'function balanceOf(address owner) view returns (uint256)',
  'function multicall(bytes[] data) returns (bytes[] results)',
];

// Pool ABI for getting slot0 (current price)
// Using Aerodrome pool format (6 return values, no feeProtocol)
const POOL_ABI = [
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, bool unlocked)',
  'function factory() view returns (address)',
  'function token0() view returns (address)',
  'function token1() view returns (address)',
  'function tickSpacing() view returns (int24)',
  'function fee() view returns (uint24)',
  'function tick() view returns (int24)',
];

// Router ABI for exact input swaps
const ROUTER_ABI = [
  'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) payable returns (uint256 amountOut)',
  'function exactInput((bytes path, address recipient, uint256 amountIn, uint256 amountOutMinimum)) payable returns (uint256 amountOut)',
  'function factory() view returns (address)',
  'function multicall(bytes[] data) payable returns (bytes[] results)',
  'function refundETH() payable',
  'function unwrapWETH9(uint256 amountMinimum, address recipient) payable',
];

class Web3Manager {
  constructor() {
    this.provider = null;
    this.eoaWallet = null;
    this.wallet = null;
    this.positionManager = null;
    this.router = null;
    this.pools = new Map();
    this.tokens = new Map();
  }

  async initialize() {
    logger.info('Initializing Web3 connection...');
    
    this.provider = new ethers.JsonRpcProvider(config.baseRpcUrl);
    
    if (!config.privateKey) {
      throw new Error('PRIVATE_KEY not configured in .env');
    }
    
    this.eoaWallet = new ethers.Wallet(config.privateKey, this.provider);
    this.wallet = new ethers.NonceManager(this.eoaWallet);
    // Keep compatibility with existing code that reads this.web3.wallet.address.
    this.wallet.address = this.eoaWallet.address;
    logger.info(`Wallet address: ${this.wallet.address}`);
    
    // Initialize contracts
    this.positionManager = new Contract(
      config.aerodrome.positionManager,
      POSITION_MANAGER_ABI,
      this.wallet
    );
    
    this.router = new Contract(
      config.aerodrome.router,
      ROUTER_ABI,
      this.wallet
    );
    
    // Get chain id
    const network = await this.provider.getNetwork();
    logger.info(`Connected to Base chain: ${network.chainId}`);
    
    return this;
  }

  async getToken(tokenAddress) {
    if (!this.tokens.has(tokenAddress)) {
      const token = new Contract(tokenAddress, ERC20_ABI, this.wallet);
      const [decimals, symbol] = await Promise.all([
        token.decimals(),
        token.symbol()
      ]);
      this.tokens.set(tokenAddress, { contract: token, decimals, symbol });
    }
    return this.tokens.get(tokenAddress);
  }

  async getPool(poolAddress) {
    if (!this.pools.has(poolAddress)) {
      const pool = new Contract(poolAddress, POOL_ABI, this.wallet);
      const [token0, token1, tickSpacing, fee, slot0] = await Promise.all([
        pool.token0(),
        pool.token1(),
        pool.tickSpacing(),
        pool.fee(),
        pool.slot0()
      ]);
      
      this.pools.set(poolAddress, { 
        contract: pool, 
        token0, 
        token1, 
        tickSpacing, 
        fee,
        currentTick: slot0.tick
      });
    }
    return this.pools.get(poolAddress);
  }

  async getPosition(tokenId) {
    const result = await this.positionManager.positions(tokenId);
    // Log individual fields instead of JSON.stringify (which fails on BigInt)
    console.log('Position', tokenId, '- token0:', result.token0, 'token1:', result.token1, 'fee:', result.fee, 'liquidity:', result.liquidity?.toString());
    return result;
  }

  // Find gauge for a pool using gauge factories
  async findGaugeForPool(poolAddress) {
    const config = require('./config');
    const gaugeFactories = config.gaugeFactories;
    
    for (const factoryAddress of gaugeFactories) {
      try {
        const factory = new Contract(
          factoryAddress,
          ['function gauges(address) view returns (address)'],
          this.wallet
        );
        const gauge = await factory.gauges(poolAddress);
        if (gauge && gauge !== ethers.ZeroAddress) {
          console.log(`Found gauge ${gauge} for pool ${poolAddress} from factory ${factoryAddress}`);
          return gauge;
        }
      } catch (e) {
        console.log(`Factory ${factoryAddress} error:`, e.message);
      }
    }
    return null;
  }

  async getUserPositions(ownerAddress) {
    const config = require('./config');
    const positions = [];
    
    console.log('Checking positions from altPositionManager and configured gauges...');
    
    // Get pool address from gauge to use for positions
    let gaugePoolAddress = ethers.ZeroAddress;
    let gaugeToken0 = null;
    let gaugeToken1 = null;
    
    // First get gauge info to know the pool
    for (const gaugeAddress of config.gauges) {
      if (!gaugeAddress || gaugeAddress === '') continue;
      try {
        const gauge = new Contract(
          gaugeAddress,
          ['function pool() view returns (address)', 'function token0() view returns (address)', 'function token1() view returns (address)'],
          this.wallet
        );
        gaugePoolAddress = await gauge.pool().catch(() => ethers.ZeroAddress);
        gaugeToken0 = await gauge.token0().catch(() => null);
        gaugeToken1 = await gauge.token1().catch(() => null);
        console.log('Gauge pool:', gaugePoolAddress, 'token0:', gaugeToken0, 'token1:', gaugeToken1);
        if (gaugePoolAddress && gaugePoolAddress !== ethers.ZeroAddress) break;
      } catch (e) {
        console.log('Error getting gauge info:', e.message.substring(0, 50));
      }
    }
    
    // First, check the altPositionManager for user's positions
    try {
      const altPM = new Contract(
        config.aerodrome.altPositionManager,
        [
          'function balanceOf(address owner) view returns (uint256)',
          'function tokenOfOwnerByIndex(address owner, uint256 index) view returns (uint256)',
          'function positions(uint256) view returns (uint96,address,address,address,int24,int24,int24,uint128,uint256,uint256,uint128,uint128)'
        ],
        this.wallet
      );
      
      const altBalance = await altPM.balanceOf(ownerAddress);
      console.log('Alt PositionManager balance:', altBalance.toString());
      
      for (let i = 0; i < parseInt(altBalance.toString()); i++) {
        try {
          const tokenId = await altPM.tokenOfOwnerByIndex(ownerAddress, i);
          console.log('Alt PositionManager tokenId:', tokenId.toString());
          
          const pos = await altPM.positions(tokenId);
          const position = {
            token0: pos[2],
            token1: pos[3],
            tickSpacing: pos[4],
            tickLower: pos[5],
            tickUpper: pos[6],
            liquidity: pos[7]
          };
          
          // Use pool from gauge if tokens match
          let poolAddress = null;
          if (gaugePoolAddress && gaugePoolAddress !== ethers.ZeroAddress && 
              position.token0 === gaugeToken0 && position.token1 === gaugeToken1) {
            poolAddress = gaugePoolAddress;
            console.log('Using gauge pool for position:', poolAddress);
          }
          
          if (position.liquidity > 0n) {
            console.log('Found position in altPM - tokenId:', tokenId.toString(), 'liquidity:', position.liquidity.toString());
            positions.push({
              tokenId: tokenId.toString(),
              ...position,
              isStaked: false,
              poolAddress: poolAddress,
              positionManager: config.aerodrome.altPositionManager,
              gaugeAddress: config.gauges[0] || null  // Add configured gauge for staking after rebalance
            });
          }
        } catch (e) {
          console.log('Error getting altPM position:', e.message.substring(0, 50));
        }
      }
    } catch (e) {
      console.log('Error checking altPositionManager:', e.message.substring(0, 50));
    }
    
    // Then check staked positions in configured gauges
    for (const gaugeAddress of config.gauges) {
      if (!gaugeAddress || gaugeAddress === '') continue;
      
      try {
        console.log('Checking gauge:', gaugeAddress);
        
        // Use the correct gauge ABI from Aerodrome
        const gauge = new Contract(
          gaugeAddress,
          [
            'function pool() view returns (address)',
            'function token0() view returns (address)', 
            'function token1() view returns (address)',
            'function tickSpacing() view returns (int24)',
            'function stakedLength(address) view returns (uint256)',
            'function stakedValues(address) view returns (uint256[])',
            'function stakedContains(address, uint256) view returns (bool)',
            'function stakedByIndex(address, uint256) view returns (uint256)'
          ],
          this.wallet
        );
        
        const [pool, token0, token1, tickSpacing, stakedLength, stakedValuesResult] = await Promise.all([
          gauge.pool().catch(() => ethers.ZeroAddress),
          gauge.token0().catch(() => null),
          gauge.token1().catch(() => null),
          gauge.tickSpacing().catch(() => 0),
          gauge.stakedLength(this.wallet.address).catch(() => 0),
          gauge.stakedValues(this.wallet.address).catch(() => []),
        ]);
        
        console.log('Gauge pool:', pool, 'token0:', token0, 'token1:', token1, 'stakedLength:', stakedLength.toString(), 'stakedValues:', stakedValuesResult);
        
        // Check if there's a specific position we're looking for
        if (stakedValuesResult && stakedValuesResult.length > 0) {
          console.log('Staked values method returned:', stakedValuesResult);
        }
        
        // Get all staked token IDs using stakedByIndex
        if (stakedLength > 0n) {
          try {
            const numStaked = parseInt(stakedLength.toString());
            console.log('Number of staked positions:', numStaked);
            
            for (let i = 0; i < numStaked; i++) {
              try {
                const tokenId = await gauge.stakedByIndex(this.wallet.address, i);
                console.log('Staked token ID at index', i, ':', tokenId.toString());
                
                // Try alternative PositionManager
                try {
                  const altPM = new Contract(
                    config.aerodrome.altPositionManager,
                    ['function positions(uint256) view returns (uint96,address,address,address,int24,int24,int24,uint128,uint256,uint256,uint128,uint128)'],
                    this.wallet
                  );
                  const result = await altPM.positions(tokenId);
                  const position = {
                    token0: result[2],
                    token1: result[3],
                    tickSpacing: result[4],
                    tickLower: result[5],
                    tickUpper: result[6],
                    liquidity: result[7]
                  };
                  console.log('Got position - tickLower:', position.tickLower, 'tickUpper:', position.tickUpper, 'liquidity:', position.liquidity.toString());
                  console.log('Pool address from gauge:', pool);
                  
                  if (position.liquidity > 0n) {
                    positions.push({
                      tokenId: tokenId.toString(),
                      token0: position.token0,
                      token1: position.token1,
                      tickLower: position.tickLower,
                      tickUpper: position.tickUpper,
                      liquidity: position.liquidity,
                      isStaked: true,
                      gaugeAddress,
                      poolAddress: pool // Use pool from gauge directly
                    });
                    console.log('Added staked position', tokenId.toString(), 'with liquidity', position.liquidity.toString());
                  }
                } catch (e) {
                  console.log('Alt PositionManager error for', tokenId.toString(), ':', e.message.substring(0, 50));
                }
              } catch (e) {
                console.log('Error getting staked token at index', i, ':', e.message.substring(0, 50));
              }
            }
          } catch (e) {
            console.log('Error getting staked length:', e.message);
          }
        }
      } catch (error) {
        console.log('Error checking gauge', gaugeAddress, ':', error.message);
      }
    }
    
    return positions;
  }

  async getTokenBalance(tokenAddress, ownerAddress = this.wallet.address) {
    const token = await this.getToken(tokenAddress);
    return await token.contract.balanceOf(ownerAddress);
  }

  async approveToken(tokenAddress, spender, amount) {
    const token = await this.getToken(tokenAddress);
    const currentAllowance = await this.withTimeout(
      token.contract.allowance(this.wallet.address, spender),
      config.rpcCallTimeoutMs,
      `allowance(${token.symbol})`
    );
    
    if (currentAllowance < amount) {
      logger.info(`Approving ${token.symbol} for ${spender}...`);
      const tx = await this.withTimeout(
        token.contract.approve(spender, ethers.MaxUint256),
        config.rpcCallTimeoutMs,
        `approve(${token.symbol})`
      );
      logger.info(`Approval tx sent: ${tx.hash}`);
      const receipt = await tx.wait(1, config.txWaitTimeoutMs);
      if (!receipt) {
        throw new Error(`Approval tx not confirmed within ${config.txWaitTimeoutMs}ms`);
      }
      logger.info(`Approved ${token.symbol} in block ${receipt.blockNumber}`);
    } else {
      logger.info(`Allowance already sufficient for ${token.symbol}; skipping approve`);
    }
  }

  async getCurrentPrice(poolAddress) {
    const pool = await this.getPool(poolAddress);
    const slot0 = await pool.contract.slot0();
    pool.currentTick = slot0.tick;
    return slot0;
  }

  async getGasPrice() {
    const block = await this.provider.getBlock('latest');
    
    if (config.gasStrategy === 'legacy') {
      return await this.provider.getFeeData();
    }
    
    // EIP-1559
    const baseFee = block.baseFeePerGas;
    const priorityFee = ethers.parseUnits(String(config.priorityFeeGwei), 'gwei');
    
    let maxPriorityFeePerGas = priorityFee;
    let maxFeePerGas = baseFee + maxPriorityFeePerGas;
    
    // Apply max gas price limit
    const maxGwei = ethers.parseUnits(String(config.maxGasPrice), 'gwei');
    if (maxFeePerGas > maxGwei) {
      maxFeePerGas = maxGwei;
    }

    // Ensure EIP-1559 fields are always valid.
    if (maxPriorityFeePerGas > maxFeePerGas) {
      logger.warn(
        `MAX_GAS_PRICE (${config.maxGasPrice} gwei) is below priority fee target; clamping priority fee to keep tx valid`
      );
      maxPriorityFeePerGas = maxFeePerGas;
    }
    
    return {
      maxFeePerGas,
      maxPriorityFeePerGas
    };
  }

  async withTimeout(promise, timeoutMs, label) {
    let timer = null;
    try {
      return await Promise.race([
        promise,
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error(`${label} timed out after ${timeoutMs}ms`));
          }, timeoutMs);
        })
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async sendTransaction(tx) {
    const gasPrice = await this.getGasPrice();
    
    try {
      const fromAddress = this.wallet.address || await this.wallet.getAddress();
      const txForEstimate = {
        ...tx,
        from: fromAddress
      };

      logger.info('Estimating gas...');
      const estimatedGas = await this.withTimeout(
        this.provider.estimateGas(txForEstimate),
        config.rpcCallTimeoutMs,
        'estimateGas'
      );
      const safetyMultiplier = 120n; // 20% buffer
      const gasLimit = (estimatedGas * safetyMultiplier) / 100n;
      
      const txWithGas = {
        ...tx,
        maxFeePerGas: gasPrice.maxFeePerGas,
        maxPriorityFeePerGas: gasPrice.maxPriorityFeePerGas,
        gasLimit
      };
      
      logger.info(`Sending transaction...`);
      const sentTx = await this.withTimeout(
        this.wallet.sendTransaction(txWithGas),
        config.rpcCallTimeoutMs,
        'sendTransaction'
      );
      logger.info(`Transaction sent: ${sentTx.hash}`);
      const receipt = await sentTx.wait(1, config.txWaitTimeoutMs);
      if (!receipt) {
        throw new Error(`Transaction ${sentTx.hash} not confirmed within ${config.txWaitTimeoutMs}ms`);
      }
      logger.info(`Transaction confirmed in block: ${receipt.blockNumber}`);
      
      return receipt;
    } catch (error) {
      logger.error(`Transaction failed: ${error.message}`);
      throw error;
    }
  }
}

module.exports = { Web3Manager };
