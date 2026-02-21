const { ethers, Contract } = require('ethers');
const config = require('./config');
const logger = require('./logger');
const { Web3Manager } = require('./web3');
const { PositionMonitor } = require('./monitor');
const { Rebalancer } = require('./rebalancer');

// Delay helper
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

class AerodromeAutoBalancer {
  constructor() {
    this.web3 = null;
    this.monitor = null;
    this.rebalancer = null;
    this.isRunning = false;
    this.checkInterval = null;
    this.isCheckInProgress = false;
    this.poolInfo = null; // Store pool info for the configured gauge
  }

  getPriceFromTickAdjusted(currentTick, decimals0, decimals1) {
    const priceRaw = Math.pow(1.0001, currentTick);
    const decimalAdjustment = Math.pow(10, Number(decimals0) - Number(decimals1));
    return priceRaw * decimalAdjustment;
  }

  async start() {
    logger.info('='.repeat(50));
    logger.info('Aerodrome Auto-Balancer Starting...');
    logger.info('='.repeat(50));
    
    // Validate configuration
    if (!config.privateKey) {
      logger.error('PRIVATE_KEY not configured. Please copy .env.example to .env and add your private key.');
      process.exit(1);
    }
    
    try {
      // Initialize Web3
      this.web3 = new Web3Manager();
      await this.web3.initialize();
      
      // Initialize components
      this.monitor = new PositionMonitor(this.web3);
      this.rebalancer = new Rebalancer(this.web3);
      
      const walletAddress = this.web3.wallet.address;
      logger.info(`Monitoring wallet: ${walletAddress}`);
      
      // Get pool info from configured gauge
      await this.initializePoolInfo();
      
      // Check initial positions
      logger.info('Checking initial positions...');
      const positions = await this.monitor.checkAllPositions(walletAddress);
      
      if (positions.length === 0) {
        logger.info('No LP positions found.');
        
        // Check if we have tokens in wallet that need to be deposited
        if (this.poolInfo) {
          await this.checkAndCreatePositionFromWallet();
        }
      } else {
        logger.info(`Found ${positions.length} LP position(s)`);
      }
      
      // Start monitoring loop (single-flight: next cycle is scheduled only after current cycle completes)
      this.isRunning = true;
      logger.info(`Bot started. Checking positions every ${config.checkInterval / 1000} seconds.`);
      logger.info(`Auto-rebalancing: ${config.autoRebalance ? 'ENABLED' : 'DISABLED'}`);
      
      // Initial check cycle
      await this.runCheckCycle();
      
    } catch (error) {
      logger.error(`Failed to start bot: ${error.message}`);
      logger.error(`Stack: ${error.stack}`);
      process.exit(1);
    }
  }

  /**
   * Initialize pool info from configured gauge
   */
  async initializePoolInfo() {
    try {
      const gaugeAddress = config.gauges[0];
      if (!gaugeAddress) {
        logger.warn('No gauge configured, cannot determine pool');
        return;
      }
      
      const gauge = new Contract(
        gaugeAddress,
        ['function pool() view returns (address)'],
        this.web3.wallet
      );
      
      const poolAddress = await gauge.pool();
      logger.info(`Pool address from gauge: ${poolAddress}`);
      
      const pool = new Contract(
        poolAddress,
        [
          'function token0() view returns (address)',
          'function token1() view returns (address)',
          'function fee() view returns (uint24)',
          'function tickSpacing() view returns (int24)',
          'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, bool unlocked)'
        ],
        this.web3.wallet
      );
      
      const [token0, token1, fee, tickSpacing, slot0] = await Promise.all([
        pool.token0(),
        pool.token1(),
        pool.fee(),
        pool.tickSpacing(),
        pool.slot0()
      ]);
      
      // Get token info
      const token0Contract = new Contract(
        token0,
        ['function symbol() view returns (string)', 'function decimals() view returns (uint8)'],
        this.web3.wallet
      );
      const token1Contract = new Contract(
        token1,
        ['function symbol() view returns (string)', 'function decimals() view returns (uint8)'],
        this.web3.wallet
      );
      
      const [symbol0, symbol1, decimals0, decimals1] = await Promise.all([
        token0Contract.symbol(),
        token1Contract.symbol(),
        token0Contract.decimals(),
        token1Contract.decimals()
      ]);
      
      this.poolInfo = {
        address: poolAddress,
        token0,
        token1,
        symbol0,
        symbol1,
        decimals0,
        decimals1,
        fee,
        tickSpacing: Number(tickSpacing),
        gaugeAddress,
        currentTick: Number(slot0.tick)
      };
      
      logger.info(`Pool initialized: ${symbol0}/${symbol1}`);
      logger.info(`  Token0: ${token0} (${symbol0})`);
      logger.info(`  Token1: ${token1} (${symbol1})`);
      logger.info(`  Fee: ${fee}`);
      logger.info(`  TickSpacing: ${tickSpacing}`);
      logger.info(`  Current tick: ${slot0.tick}`);
      
    } catch (error) {
      logger.error(`Failed to initialize pool info: ${error.message}`);
    }
  }

  /**
   * Check wallet balances and create position if we have tokens
   */
  async checkAndCreatePositionFromWallet() {
    if (!this.poolInfo) {
      logger.warn('No pool info available, cannot create position from wallet');
      return;
    }
    
    logger.info('Checking wallet balances for tokens...');
    
    try {
      const { token0, token1, symbol0, symbol1, decimals0, decimals1 } = this.poolInfo;
      
      const token0Contract = new Contract(
        token0,
        ['function balanceOf(address) view returns (uint256)'],
        this.web3.wallet
      );
      const token1Contract = new Contract(
        token1,
        ['function balanceOf(address) view returns (uint256)'],
        this.web3.wallet
      );
      
      const [balance0, balance1] = await Promise.all([
        token0Contract.balanceOf(this.web3.wallet.address),
        token1Contract.balanceOf(this.web3.wallet.address)
      ]);
      
      const formatted0 = ethers.formatUnits(balance0, decimals0);
      const formatted1 = ethers.formatUnits(balance1, decimals1);
      
      logger.info(`${symbol0} balance: ${formatted0}`);
      logger.info(`${symbol1} balance: ${formatted1}`);
      
      // Check if we have meaningful amounts
      const hasBalance0 = parseFloat(formatted0) > 0.001;
      const hasBalance1 = parseFloat(formatted1) > 0.001;
      
      if (!hasBalance0 && !hasBalance1) {
        logger.info('No significant token balances in wallet. Nothing to deposit.');
        return;
      }
      
      logger.info('Found tokens in wallet. Creating new LP position...');
      
      // Calculate new range around current price
      const slot0 = await new Contract(
        this.poolInfo.address,
        ['function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, bool)'],
        this.web3.wallet
      ).slot0();
      
      const currentTick = Number(slot0.tick);
      const tickSpacing = this.poolInfo.tickSpacing;
      
      // Calculate range: ±30 ticks around current price (or use rangeMultiplier)
      const rangeWidth = tickSpacing * Math.floor(30 / tickSpacing) * config.rangeMultiplier;
      const tickLower = Math.floor((currentTick - rangeWidth) / tickSpacing) * tickSpacing;
      const tickUpper = Math.floor((currentTick + rangeWidth) / tickSpacing) * tickSpacing;
      
      logger.info(`Creating position with range ${tickLower} - ${tickUpper}`);
      
      // Calculate optimal ratio for the tick range
      const ratio = await this.rebalancer.calculateOptimalRatio(this.poolInfo.address, tickLower, tickUpper);
      logger.info(`Optimal ratio - ${symbol0}: ${ratio.token0Ratio.toFixed(4)}, ${symbol1}: ${ratio.token1Ratio.toFixed(4)}`);
      
      // Calculate current value in token1 terms using tick-based price math.
      const price0InToken1 = this.getPriceFromTickAdjusted(currentTick, decimals0, decimals1);
      
      const amount0InToken1 = parseFloat(formatted0) * price0InToken1;
      const amount1InToken1 = parseFloat(formatted1);
      const totalInToken1 = amount0InToken1 + amount1InToken1;
      
      logger.info(`Total value in ${symbol1} terms: ${totalInToken1.toFixed(2)}`);
      
      // Calculate target values
      const targetValue0 = totalInToken1 * ratio.token0Ratio;
      const targetValue1 = totalInToken1 * ratio.token1Ratio;
      
      logger.info(`Target ${symbol0} value in ${symbol1}: ${targetValue0.toFixed(2)}`);
      logger.info(`Target ${symbol1} value: ${targetValue1.toFixed(2)}`);
      
      // Determine swap needed
      const diff = amount0InToken1 - targetValue0;
      let amount0ToAdd = balance0;
      let amount1ToAdd = balance1;
      const minSwapValueUsdc = Number(config.minSwapValueUsdc);
      
      if (Math.abs(diff) > minSwapValueUsdc) {
        if (diff > 0) {
          // Too much token0, swap some to token1
          const amount0ToSwapValue = diff;
          const amount0ToSwap = amount0ToSwapValue / price0InToken1;
          const amount0ToSwapWei = ethers.parseUnits(amount0ToSwap.toFixed(Number(decimals0)), decimals0);
          
          logger.info(`Swapping ${amount0ToSwap.toFixed(6)} ${symbol0} to ${symbol1}...`);
          const swapResult = await this.rebalancer.swapTokens(token0, token1, amount0ToSwapWei.toString(), this.poolInfo.address);
          
          if (swapResult) {
            logger.info('Swap completed, waiting 5 seconds...');
            await new Promise(resolve => setTimeout(resolve, 5000));
            // Get new balances
            const [newBalance0, newBalance1] = await Promise.all([
              token0Contract.balanceOf(this.web3.wallet.address),
              token1Contract.balanceOf(this.web3.wallet.address)
            ]);
            amount0ToAdd = newBalance0;
            amount1ToAdd = newBalance1;
            logger.info(`New ${symbol0} balance: ${ethers.formatUnits(newBalance0, decimals0)}`);
            logger.info(`New ${symbol1} balance: ${ethers.formatUnits(newBalance1, decimals1)}`);
          } else {
            logger.error(`Swap ${symbol0} -> ${symbol1} failed. Aborting position creation for this cycle.`);
            return null;
          }
        } else {
          // Too much token1, swap some to token0
          const amount1ToSwapValue = -diff;
          const amount1ToSwapWei = ethers.parseUnits(amount1ToSwapValue.toFixed(Number(decimals1)), decimals1);
          
          logger.info(`Swapping ${amount1ToSwapValue.toFixed(6)} ${symbol1} to ${symbol0}...`);
          const swapResult = await this.rebalancer.swapTokens(token1, token0, amount1ToSwapWei.toString(), this.poolInfo.address);
          
          if (swapResult) {
            logger.info('Swap completed, waiting 5 seconds...');
            await new Promise(resolve => setTimeout(resolve, 5000));
            // Get new balances
            const [newBalance0, newBalance1] = await Promise.all([
              token0Contract.balanceOf(this.web3.wallet.address),
              token1Contract.balanceOf(this.web3.wallet.address)
            ]);
            amount0ToAdd = newBalance0;
            amount1ToAdd = newBalance1;
            logger.info(`New ${symbol0} balance: ${ethers.formatUnits(newBalance0, decimals0)}`);
            logger.info(`New ${symbol1} balance: ${ethers.formatUnits(newBalance1, decimals1)}`);
          } else {
            logger.error(`Swap ${symbol1} -> ${symbol0} failed. Aborting position creation for this cycle.`);
            return null;
          }
        }
      } else {
        logger.info(
          `Token ratio imbalance (${Math.abs(diff).toFixed(2)} ${symbol1}) is below MIN_SWAP_VALUE_USDC (${minSwapValueUsdc}). Skipping swap.`
        );
      }
      
      // Create position with balanced amounts
      const result = await this.rebalancer.createPosition(
        token0, token1, this.poolInfo.address,
        tickLower, tickUpper,
        amount0ToAdd.toString(), amount1ToAdd.toString(),
        decimals0, decimals1
      );
      
      if (result) {
        logger.info(`Position created successfully! Token ID: ${result}`);
        
        // Stake the position to the gauge
        const gaugeAddress = this.poolInfo.gaugeAddress;
        if (gaugeAddress) {
          logger.info(`Staking position #${result} to gauge ${gaugeAddress}...`);
          try {
            await this.rebalancer.stakeToGauge(result, gaugeAddress);
            logger.info(`Position #${result} staked successfully!`);
          } catch (e) {
            logger.error(`Staking error: ${e.message}`);
            logger.warn('Position created but not staked. You may need to stake manually.');
          }
        }
      } else {
        logger.warn('Position creation returned no result');
      }
      
      return result;
    } catch (error) {
      logger.error(`Error creating position from wallet: ${error.message}`);
      logger.error(`Stack: ${error.stack}`);
    }
  }

  async checkAndRebalance() {
    if (!this.isRunning) return;
    
    try {
      const walletAddress = this.web3.wallet.address;
      const positions = await this.monitor.checkAllPositions(walletAddress);
      
      // Find out-of-range positions
      const outOfRangePositions = positions.filter(p => !p.isInRange);
      const threshold = Number(config.rebalanceThreshold);
      const rebalanceCandidates = outOfRangePositions.filter((p) => {
        const percentOut = Number(p.percentOutOfRange || 0);
        return percentOut >= threshold;
      });
      
      // Find unstaked positions that are in range (for auto-staking)
      const unstakedInRangePositions = positions.filter(p => p.isInRange && !p.isStaked && p.gaugeAddress);
      
      // Auto-stake unstaked positions that are in range
      if (unstakedInRangePositions.length > 0) {
        logger.info(`Found ${unstakedInRangePositions.length} unstaked position(s) in range`);
        
        for (const position of unstakedInRangePositions) {
          logger.info(`Auto-staking position #${position.tokenId}...`);
          try {
            await this.rebalancer.stakeToGauge(position.tokenId, position.gaugeAddress);
            logger.info(`✅ Position #${position.tokenId} staked successfully`);
          } catch (error) {
            logger.error(`❌ Failed to stake position #${position.tokenId}: ${error.message}`);
          }
        }
      }
      
      if (outOfRangePositions.length > 0) {
        logger.info(`Found ${outOfRangePositions.length} out-of-range position(s)`);
        logger.info(`Rebalance threshold: ${threshold}%`);
        logger.info(`Positions meeting threshold: ${rebalanceCandidates.length}`);
        
        if (config.autoRebalance && rebalanceCandidates.length > 0) {
          for (const position of rebalanceCandidates) {
            // Convert BigInt to number for calculation
            const tickLower = Number(position.tickLower);
            const tickUpper = Number(position.tickUpper);
            const currentTick = Number(position.currentTick);
            const tickSpacing = Number(position.tickSpacing);
            
            // Calculate new range - pass existing ticks to keep same width
            const newRange = this.monitor.calculateNewRange(
              currentTick,
              tickSpacing,
              config.rangeMultiplier,
              tickLower,
              tickUpper
            );
            
            logger.info(`Rebalancing position #${position.tokenId}...`);
            logger.info(`  isStaked: ${position.isStaked}, gaugeAddress: ${position.gaugeAddress}`);
            logger.info(`  Current range: ${tickLower} - ${tickUpper}`);
            logger.info(`  New range: ${newRange.tickLower} - ${newRange.tickUpper}`);
            
            try {
              await this.rebalancer.rebalance(position, newRange);
              logger.info(`✅ Position #${position.tokenId} rebalanced successfully`);
            } catch (error) {
              logger.error(`❌ Failed to rebalance position #${position.tokenId}: ${error.message}`);
            }
          }
        } else if (config.autoRebalance && rebalanceCandidates.length === 0) {
          logger.info('No out-of-range positions exceed the rebalance threshold. Skipping rebalance cycle.');
        } else {
          logger.info('Auto-rebalancing is disabled. Run with AUTO_REBALANCE=true to enable.');
        }
      } else if (positions.length === 0) {
        // No positions found - check if we have tokens in wallet
        logger.info('No positions found. Checking wallet for tokens to deposit...');
        await this.checkAndCreatePositionFromWallet();
      } else {
        logger.info('All positions are in range ✅');
      }
      
    } catch (error) {
      logger.error(`Error during check: ${error.message}`);
      logger.error(`Stack: ${error.stack}`);
    }
  }

  scheduleNextCheck() {
    if (!this.isRunning) return;

    if (this.checkInterval) {
      clearTimeout(this.checkInterval);
    }

    this.checkInterval = setTimeout(() => {
      this.runCheckCycle().catch((error) => {
        logger.error(`Check cycle failed: ${error.message}`);
      });
    }, config.checkInterval);
  }

  async runCheckCycle() {
    if (!this.isRunning) return;

    if (this.isCheckInProgress) {
      logger.warn('Previous check cycle is still running; skipping overlapping cycle.');
      this.scheduleNextCheck();
      return;
    }

    this.isCheckInProgress = true;
    try {
      await this.checkAndRebalance();
    } finally {
      this.isCheckInProgress = false;
      this.scheduleNextCheck();
    }
  }

  async stop() {
    logger.info('Stopping bot...');
    this.isRunning = false;
    
    if (this.checkInterval) {
      clearTimeout(this.checkInterval);
      this.checkInterval = null;
    }
    
    logger.info('Bot stopped.');
    process.exit(0);
  }
}

// Handle graceful shutdown
process.on('SIGINT', async () => {
  logger.info('Received SIGINT, shutting down...');
  await bot.stop();
});

process.on('SIGTERM', async () => {
  logger.info('Received SIGTERM, shutting down...');
  await bot.stop();
});

// Start the bot
const bot = new AerodromeAutoBalancer();
bot.start();
