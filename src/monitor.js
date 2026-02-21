const config = require('./config');
const logger = require('./logger');

class PositionMonitor {
  constructor(web3Manager) {
    this.web3 = web3Manager;
    this.positions = new Map();
  }

  /**
   * Check if a position is out of range
   * @param {Object} position - The LP position
   * @param {number} currentTick - Current pool tick
   * @returns {Object} - Status of the position
   */
  checkPositionStatus(position, currentTick) {
    const tickLower = Number(position.tickLower);
    const tickUpper = Number(position.tickUpper);
    
    const isBelowRange = currentTick < tickLower;
    const isAboveRange = currentTick > tickUpper;
    const isInRange = !isBelowRange && !isAboveRange;
    
    // Calculate how far out of range
    let percentOutOfRange = 0;
    if (isBelowRange) {
      const range = tickUpper - tickLower;
      const distance = tickLower - currentTick;
      percentOutOfRange = (distance / range) * 100;
    } else if (isAboveRange) {
      const range = tickUpper - tickLower;
      const distance = currentTick - tickUpper;
      percentOutOfRange = (distance / range) * 100;
    }
    
    return {
      isInRange,
      isBelowRange,
      isAboveRange,
      percentOutOfRange: percentOutOfRange.toFixed(2),
      tickLower,
      tickUpper,
      currentTick,
      liquidity: position.liquidity.toString()
    };
  }

  /**
   * Calculate new tick range for rebalancing
   * @param {number} currentTick - Current pool tick
   * @param {number} tickSpacing - Pool tick spacing
   * @param {number} rangeMultiplier - How wide the new range should be (e.g., 2 = 2x current range)
   * @param {number} existingTickLower - Existing position's lower tick (optional, for keeping same width)
   * @param {number} existingTickUpper - Existing position's upper tick (optional, for keeping same width)
   * @returns {Object} - New tickLower and tickUpper
   */
  calculateNewRange(currentTick, tickSpacing, rangeMultiplier = 1, existingTickLower = null, existingTickUpper = null) {
    // Use rangeMultiplier to calculate range width (same as wallet position creation)
    // Base is 30 ticks, multiplied by rangeMultiplier
    const rangeWidth = tickSpacing * Math.floor(30 / tickSpacing) * rangeMultiplier;
    
    // Round to nearest tick spacing
    const tickLower = Math.floor((currentTick - rangeWidth) / tickSpacing) * tickSpacing;
    const tickUpper = Math.ceil((currentTick + rangeWidth) / tickSpacing) * tickSpacing;
    
    return { tickLower, tickUpper };
  }

  /**
   * Get all user positions and check their status
   * @param {string} userAddress - User's wallet address
   * @returns {Array} - Array of positions with their status
   */
  async checkAllPositions(userAddress) {
    logger.info(`Checking positions for ${userAddress}...`);
    
    const positions = await this.web3.getUserPositions(userAddress);
    const results = [];
    
    for (const position of positions) {
      try {
        console.log('Position tokenId:', position.tokenId, 'token0:', position.token0, 'token1:', position.token1);
        
        // Get pool address - use existing poolAddress if available (for staked positions)
        let poolAddress = position.poolAddress;
        
        if (!poolAddress) {
          // Try to find pool from factory
          poolAddress = await this.findPool(position.token0, position.token1);
        }
        
        if (!poolAddress) {
          logger.warn(`Could not find pool for ${position.token0}/${position.token1}`);
          continue;
        }
        
        // Get pool info to get fee and current tick
        const poolInfo = await this.web3.getPool(poolAddress);
        
        // Get current price - handle errors gracefully
        let currentTick = 0;
        try {
          const slot0 = await this.web3.getCurrentPrice(poolAddress);
          currentTick = Number(slot0.tick);
        } catch (e) {
          logger.warn(`Could not get current tick for pool ${poolAddress}: ${e.message.substring(0, 50)}`);
          // Try to get tick from pool directly
          try {
            const pool = new Contract(poolAddress, ['function tick() view returns (int24)'], this.web3.wallet);
            currentTick = Number(await pool.tick());
          } catch (e2) {
            logger.warn(`Could not get tick either: ${e2.message.substring(0, 50)}`);
          }
        }
        
        // Check position status
        const status = this.checkPositionStatus(position, currentTick);
        
        // Get token info
        const token0Info = await this.web3.getToken(position.token0);
        const token1Info = await this.web3.getToken(position.token1);
        
        const result = {
          tokenId: position.tokenId,
          poolAddress,
          token0: position.token0,
          token1: position.token1,
          token0Symbol: token0Info.symbol,
          token1Symbol: token1Info.symbol,
          fee: poolInfo.fee,
          tickSpacing: poolInfo.tickSpacing,
          liquidity: position.liquidity.toString(),
          isStaked: position.isStaked || false,
          gaugeAddress: position.gaugeAddress || null,
          ...status
        };
        
        results.push(result);
        
        // Log status
        if (status.isInRange) {
          logger.info(`Position #${position.tokenId} (${token0Info.symbol}/${token1Info.symbol}): ✅ IN RANGE at tick ${currentTick}`);
        } else if (status.isBelowRange) {
          logger.warn(`Position #${position.tokenId} (${token0Info.symbol}/${token1Info.symbol}): 🔻 BELOW RANGE (${status.percentOutOfRange}% out) at tick ${currentTick}`);
        } else {
          logger.warn(`Position #${position.tokenId} (${token0Info.symbol}/${token1Info.symbol}): 🔺 ABOVE RANGE (${status.percentOutOfRange}% out) at tick ${currentTick}`);
        }
        
      } catch (error) {
        logger.error(`Error checking position ${position.tokenId}: ${error.message}`);
      }
    }
    
    return results;
  }

  /**
   * Find pool address from token pair
   * Tries common fee tiers since we don't know which one was used
   * Also tries both Aerodrome factories (V3 and Stable)
   */
  async findPool(token0, token1) {
    console.log('findPool called with:', token0, token1);
    // Common fee tiers in basis points (including Aerodrome specific ones)
    const feeTiers = [10, 20, 35, 40, 100, 500, 3000, 10000]; // Including 0.035% (35), 0.2% (200), etc
    
    // Both Aerodrome factories
    const factories = [
      config.aerodrome.factory,
      '0x420DD381b31aEf6683db6B902084cB0FFECe40Da',
      '0xaDe65c38CD4849aDBA595a4323a8C7DdfE89716a'
    ];
    
    try {
      // Try each factory with each fee tier
      for (const factoryAddress of factories) {
        const factory = new ethers.Contract(
          factoryAddress,
          ['function getPool(address, address, uint24) view returns (address)'],
          this.web3.wallet
        );
        
        for (const fee of feeTiers) {
          try {
            const poolAddress = await factory.getPool(token0, token1, fee);
            if (poolAddress !== ethers.ZeroAddress) {
              console.log(`Found pool for ${token0}/${token1} with fee ${fee}: ${poolAddress}`);
              return poolAddress;
            }
          } catch (e) {
            // Continue to next fee tier
          }
        }
      }
      
      return null;
    } catch (error) {
      logger.error(`Error finding pool: ${error.message}`);
      return null;
    }
  }

  /**
   * Get out-of-range positions that need rebalancing
   * @param {string} userAddress - User's wallet address
   * @param {number} thresholdPercent - Minimum out-of-range percentage to trigger rebalance
   * @returns {Array} - Positions that need rebalancing
   */
  async getOutOfRangePositions(userAddress, thresholdPercent = 5) {
    const allPositions = await this.checkAllPositions(userAddress);
    
    return allPositions.filter(p => 
      !p.isInRange && parseFloat(p.percentOutOfRange) >= thresholdPercent
    );
  }
}

// Need ethers for the findPool function
const { ethers } = require('ethers');

module.exports = { PositionMonitor };
