const { ethers, Contract } = require('ethers');
const config = require('./config');
const logger = require('./logger');

// Delay helper
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

class Rebalancer {
  constructor(web3Manager) {
    this.web3 = web3Manager;
    // Track pending rebalance state
    this.pendingRebalance = null;
  }

  getPriceFromTickAdjusted(currentTick, decimals0, decimals1) {
    // raw price = token1/token0 in raw units
    const priceRaw = Math.pow(1.0001, currentTick);
    // adjust for token decimals to get human-readable token1 per token0
    const decimalAdjustment = Math.pow(10, Number(decimals0) - Number(decimals1));
    return priceRaw * decimalAdjustment;
  }

  /**
   * Check if there's a pending rebalance that needs to be completed
   */
  hasPendingRebalance() {
    return this.pendingRebalance !== null;
  }

  /**
   * Get pending rebalance info
   */
  getPendingRebalance() {
    return this.pendingRebalance;
  }

  /**
   * Clear pending rebalance
   */
  clearPendingRebalance() {
    this.pendingRebalance = null;
  }

  /**
   * Calculate the optimal token ratio for a given tick range
   * Returns the ratio of token0 to token1 needed
   */
  async calculateOptimalRatio(poolAddress, tickLower, tickUpper) {
    const poolContract = new Contract(
      poolAddress,
      [
        'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, bool)',
        'function token0() view returns (address)',
        'function token1() view returns (address)'
      ],
      this.web3.wallet
    );

    const token0Contract = new Contract(
      await poolContract.token0(),
      ['function decimals() view returns (uint8)'],
      this.web3.wallet
    );
    const token1Contract = new Contract(
      await poolContract.token1(),
      ['function decimals() view returns (uint8)'],
      this.web3.wallet
    );

    const [slot0, decimals0, decimals1] = await Promise.all([
      poolContract.slot0(),
      token0Contract.decimals(),
      token1Contract.decimals()
    ]);

    const currentTick = Number(slot0.tick);
    const sqrtPriceX96 = slot0.sqrtPriceX96;

    logger.info(`Current tick: ${currentTick}, sqrtPriceX96: ${sqrtPriceX96}`);
    logger.info(`Token decimals: token0=${decimals0}, token1=${decimals1}`);

    // Compute sqrt prices directly from ticks to avoid large-integer precision loss.
    const sqrtPriceCurrent = Math.pow(1.0001, currentTick / 2);
    const sqrtPriceLower = Math.sqrt(1.0001 ** tickLower);
    const sqrtPriceUpper = Math.sqrt(1.0001 ** tickUpper);

    logger.info(`sqrtPriceLower: ${sqrtPriceLower}, sqrtPriceCurrent: ${sqrtPriceCurrent}, sqrtPriceUpper: ${sqrtPriceUpper}`);

    // Calculate the ratio using the correct Uniswap V3 liquidity formula
    // If current price is in range, both tokens are needed
    // If current price is below range, only token0 is needed
    // If current price is above range, only token1 is needed

    if (currentTick < tickLower) {
      // Below range - need only token0
      return { token0Ratio: 1, token1Ratio: 0, inRange: false, belowRange: true };
    } else if (currentTick > tickUpper) {
      // Above range - need only token1
      return { token0Ratio: 0, token1Ratio: 1, inRange: false, belowRange: false };
    } else {
      // In range - calculate the ratio using correct V3 math
      // For a position in range:
      // amount0 = L * (1/sqrtPriceCurrent - 1/sqrtPriceUpper)
      // amount1 = L * (sqrtPriceCurrent - sqrtPriceLower)
      // 
      // So: amount0/amount1 = (1/sqrtCurrent - 1/sqrtUpper) / (sqrtCurrent - sqrtLower)
      
      const amount0PerAmount1Raw = (1/sqrtPriceCurrent - 1/sqrtPriceUpper) / (sqrtPriceCurrent - sqrtPriceLower);
      
      // Adjust for decimals: amount0 has decimals0, amount1 has decimals1
      // To get human-readable ratio: multiply by 10^(decimals1 - decimals0)
      const decimalAdjustment = 10 ** (Number(decimals1) - Number(decimals0));
      const amount0PerAmount1Human = amount0PerAmount1Raw * decimalAdjustment;
      
      logger.info(`Raw ratio (amount0/amount1): ${amount0PerAmount1Raw}`);
      logger.info(`Human ratio (token0/token1): ${amount0PerAmount1Human}`);

      // Convert to fractions that sum to 1
      // If amount0PerAmount1Human = X, then for every 1 unit of token1, we need X units of token0
      // So token0Fraction = X / (X + 1), token1Fraction = 1 / (X + 1)
      // But we need to account for value, not just amount
      // The price is sqrtPrice^2 = token1/token0 in raw units
      // Adjusted price = price * 10^(decimals0 - decimals1)
      
      const priceAdjusted = this.getPriceFromTickAdjusted(currentTick, decimals0, decimals1);
      logger.info(`Price (token1 per token0, adjusted): ${priceAdjusted}`);
      
      // Value of token0 in terms of token1 = amount0 * price
      // Value of token1 in terms of token1 = amount1
      // For ratio X (amount0 per amount1):
      // value0 = X * priceAdjusted
      // value1 = 1
      // total value = X * priceAdjusted + 1
      
      const value0 = amount0PerAmount1Human * priceAdjusted;
      const value1 = 1;
      const totalValue = value0 + value1;
      
      const token0ValueFraction = value0 / totalValue;
      const token1ValueFraction = value1 / totalValue;
      
      logger.info(`Value fractions: token0=${token0ValueFraction}, token1=${token1ValueFraction}`);
      
      return {
        token0Ratio: token0ValueFraction,
        token1Ratio: token1ValueFraction,
        amount0PerAmount1: amount0PerAmount1Human,
        inRange: true,
        belowRange: false,
        currentTick,
        sqrtPriceX96: sqrtPriceX96.toString(),
        decimals0: Number(decimals0),
        decimals1: Number(decimals1)
      };
    }
  }

  /**
   * Convert tick to sqrtPriceX96
   */
  tickToSqrtPrice(tick) {
    const sqrtPrice = Math.sqrt(1.0001 ** tick) * (2 ** 96);
    return BigInt(Math.floor(sqrtPrice));
  }

  /**
   * Rebalance a position that is out of range
   */
  async rebalance(positionInfo, newRange) {
    const { tokenId, token0, token1, poolAddress, isStaked, gaugeAddress } = positionInfo;
    const { tickLower, tickUpper } = newRange;
    
    logger.info(`Starting rebalance for position #${tokenId}...`);
    logger.info(`isStaked: ${isStaked}, gaugeAddress: ${gaugeAddress}`);
    logger.info(`New range: ${tickLower} - ${tickUpper}`);
    
    try {
      // Store the rebalance info in case we need to resume
      this.pendingRebalance = {
        tokenId,
        token0,
        token1,
        poolAddress,
        gaugeAddress,
        tickLower,
        tickUpper,
        stage: 'starting'
      };

      // Step 0: Unstake if position is staked
      if (isStaked && gaugeAddress) {
        logger.info(`Unstaking position #${tokenId} from gauge ${gaugeAddress}...`);
        this.pendingRebalance.stage = 'unstaking';
        try {
          await this.unstakeFromGauge(tokenId, gaugeAddress);
          logger.info('Unstake successful, waiting 5 seconds...');
          await delay(5000);
        } catch (e) {
          logger.error(`Unstake error: ${e.message}`);
          logger.warn('Continuing with rebalance without unstaking...');
        }
      }
      
      // Step 1: Use multicall to decrease liquidity, collect fees, and burn old position
      logger.info(`Using multicall to withdraw from position #${tokenId}...`);
      this.pendingRebalance.stage = 'withdrawing';
      
      const pmAddress = config.aerodrome.altPositionManager;
      const pm = new Contract(
        pmAddress,
        [
          'function multicall(bytes[]) returns (bytes[])',
          'function decreaseLiquidity((uint256,uint128,uint256,uint256,uint256)) returns (uint256,uint256)',
          'function collect((uint256,address,uint128,uint128)) returns (uint256,uint256)',
          'function burn(uint256) returns (uint256,uint256)'
        ],
        this.web3.wallet
      );
      
      const maxUint128 = BigInt('0xffffffffffffffffffffffffffffffff');
      
      logger.info(`Liquidity to remove: ${positionInfo.liquidity.toString()}`);
      
      const decreaseLiquidityData = pm.interface.encodeFunctionData('decreaseLiquidity', [
        [
          BigInt(tokenId),
          BigInt(positionInfo.liquidity.toString()),
          0n,
          0n,
          BigInt(Math.floor(Date.now() / 1000) + 600)
        ]
      ]);
      
      const collectData = pm.interface.encodeFunctionData('collect', [
        [
          BigInt(tokenId),
          this.web3.wallet.address,
          maxUint128,
          maxUint128
        ]
      ]);
      
      const burnData = pm.interface.encodeFunctionData('burn', [BigInt(tokenId)]);
      
      const tx = await pm.multicall([decreaseLiquidityData, collectData, burnData]);
      const receipt = await tx.wait();
      logger.info(`Multicall executed, tx: ${receipt.hash}`);
      logger.info(`Position #${tokenId} withdrawn and burned`);
      
      logger.info('Waiting 10 seconds for balances to update...');
      await delay(10000);
      
      // Step 3: Get actual token balances from wallet
      logger.info('Getting token balances from wallet...');
      this.pendingRebalance.stage = 'checking_balances';
      
      const token0Contract = new Contract(
        token0,
        ['function balanceOf(address) view returns (uint256)', 'function decimals() view returns (uint8)', 'function symbol() view returns (string)'],
        this.web3.wallet
      );
      const token1Contract = new Contract(
        token1,
        ['function balanceOf(address) view returns (uint256)', 'function decimals() view returns (uint8)', 'function symbol() view returns (string)'],
        this.web3.wallet
      );
      
      const [amount0, amount1, decimals0, decimals1, symbol0, symbol1] = await Promise.all([
        token0Contract.balanceOf(this.web3.wallet.address),
        token1Contract.balanceOf(this.web3.wallet.address),
        token0Contract.decimals(),
        token1Contract.decimals(),
        token0Contract.symbol(),
        token1Contract.symbol()
      ]);
      
      logger.info(`${symbol0} balance: ${ethers.formatUnits(amount0, decimals0)}`);
      logger.info(`${symbol1} balance: ${ethers.formatUnits(amount1, decimals1)}`);
      
      // Update pending rebalance with amounts
      this.pendingRebalance.amount0 = amount0.toString();
      this.pendingRebalance.amount1 = amount1.toString();
      this.pendingRebalance.decimals0 = decimals0;
      this.pendingRebalance.decimals1 = decimals1;
      this.pendingRebalance.symbol0 = symbol0;
      this.pendingRebalance.symbol1 = symbol1;
      
      // Step 4: Calculate optimal ratio for new position
      logger.info('Calculating optimal token ratio for new position...');
      this.pendingRebalance.stage = 'calculating_ratio';
      
      const ratio = await this.calculateOptimalRatio(poolAddress, tickLower, tickUpper);
      logger.info(`Optimal ratio - ${symbol0}: ${ratio.token0Ratio.toFixed(4)}, ${symbol1}: ${ratio.token1Ratio.toFixed(4)}`);
      logger.info(`Position in range: ${ratio.inRange}`);
      
      // Step 5: Swap tokens to match the optimal ratio
      this.pendingRebalance.stage = 'swapping';
      
      let amount0ToAdd = amount0;
      let amount1ToAdd = amount1;
      
      if (!ratio.inRange) {
        // Position is out of range, need to swap all to one token
        if (ratio.belowRange) {
          // Need only token0, swap all token1 to token0
          if (amount1 > 0n) {
            logger.info(`Position below range, swapping all ${symbol1} to ${symbol0}...`);
            const swapResult = await this.swapTokens(token1, token0, amount1.toString(), poolAddress);
            if (swapResult) {
              logger.info('Swap completed, waiting 10 seconds...');
              await delay(10000);
              // Get new balance
              const newAmount0 = await token0Contract.balanceOf(this.web3.wallet.address);
              const newAmount1 = await token1Contract.balanceOf(this.web3.wallet.address);
              amount0ToAdd = newAmount0;
              amount1ToAdd = newAmount1;
              logger.info(`New ${symbol0} balance: ${ethers.formatUnits(newAmount0, decimals0)}`);
              logger.info(`New ${symbol1} balance: ${ethers.formatUnits(newAmount1, decimals1)}`);
            } else {
              throw new Error(`Swap ${symbol1} -> ${symbol0} failed; aborting rebalance before mint`);
            }
          }
        } else {
          // Need only token1, swap all token0 to token1
          if (amount0 > 0n) {
            logger.info(`Position above range, swapping all ${symbol0} to ${symbol1}...`);
            const swapResult = await this.swapTokens(token0, token1, amount0.toString(), poolAddress);
            if (swapResult) {
              logger.info('Swap completed, waiting 10 seconds...');
              await delay(10000);
              // Get new balance
              const newAmount0 = await token0Contract.balanceOf(this.web3.wallet.address);
              const newAmount1 = await token1Contract.balanceOf(this.web3.wallet.address);
              amount0ToAdd = newAmount0;
              amount1ToAdd = newAmount1;
              logger.info(`New ${symbol0} balance: ${ethers.formatUnits(newAmount0, decimals0)}`);
              logger.info(`New ${symbol1} balance: ${ethers.formatUnits(newAmount1, decimals1)}`);
            } else {
              throw new Error(`Swap ${symbol0} -> ${symbol1} failed; aborting rebalance before mint`);
            }
          }
        }
      } else {
        // Position is in range, need to balance both tokens according to ratio
        // Calculate total value in terms of token1
        const poolContract = new Contract(
          poolAddress,
          ['function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, bool)'],
          this.web3.wallet
        );
        const slot0 = await poolContract.slot0();
        const currentTickForPrice = Number(slot0.tick);
        
        const price0InToken1 = this.getPriceFromTickAdjusted(currentTickForPrice, decimals0, decimals1);
        logger.info(`Price of ${symbol0} in ${symbol1} (adjusted): ${price0InToken1}`);
        
        // Calculate current value in token1 terms
        const amount0InToken1 = Number(ethers.formatUnits(amount0, decimals0)) * price0InToken1;
        const amount1InToken1 = Number(ethers.formatUnits(amount1, decimals1));
        const totalInToken1 = amount0InToken1 + amount1InToken1;
        
        logger.info(`Current ${symbol0} value in ${symbol1}: ${amount0InToken1}`);
        logger.info(`Current ${symbol1} value: ${amount1InToken1}`);
        logger.info(`Total value in ${symbol1} terms: ${totalInToken1}`);
        
        // Calculate target amounts based on ratio
        const targetToken0InToken1 = totalInToken1 * ratio.token0Ratio;
        const targetToken1InToken1 = totalInToken1 * ratio.token1Ratio;
        const minSwapValueUsdc = Number(config.minSwapValueUsdc);
        
        logger.info(`Target ${symbol0} value in ${symbol1}: ${targetToken0InToken1}`);
        logger.info(`Target ${symbol1} value: ${targetToken1InToken1}`);
        
        // Determine which token to swap
        const currentToken0InToken1 = Number(ethers.formatUnits(amount0, decimals0)) * price0InToken1;
        const token0Diff = currentToken0InToken1 - targetToken0InToken1;
        
        logger.info(`Token0 value difference: ${token0Diff}`);
        
        if (Math.abs(token0Diff) > minSwapValueUsdc) {
          if (token0Diff > 0) {
            // We have too much token0, swap some to token1
            const amount0ToSwapInToken1 = token0Diff;
            const amount0ToSwap = amount0ToSwapInToken1 / price0InToken1;
            const amount0ToSwapWei = ethers.parseUnits(amount0ToSwap.toFixed(Number(decimals0)), decimals0);
            
            logger.info(`Swapping ${amount0ToSwap.toFixed(6)} ${symbol0} to ${symbol1}...`);
            const swapResult = await this.swapTokens(token0, token1, amount0ToSwapWei.toString(), poolAddress);
            if (swapResult) {
              logger.info('Swap completed, waiting 10 seconds...');
              await delay(10000);
              // Get new balances
              const newAmount0 = await token0Contract.balanceOf(this.web3.wallet.address);
              const newAmount1 = await token1Contract.balanceOf(this.web3.wallet.address);
              amount0ToAdd = newAmount0;
              amount1ToAdd = newAmount1;
              logger.info(`New ${symbol0} balance: ${ethers.formatUnits(newAmount0, decimals0)}`);
              logger.info(`New ${symbol1} balance: ${ethers.formatUnits(newAmount1, decimals1)}`);
            } else {
              throw new Error(`Swap ${symbol0} -> ${symbol1} failed; aborting rebalance before mint`);
            }
          } else {
            // We have too much token1, swap some to token0
            const amount1ToSwapInToken1 = -token0Diff;
            const amount1ToSwap = amount1ToSwapInToken1;
            const amount1ToSwapWei = ethers.parseUnits(amount1ToSwap.toFixed(Number(decimals1)), decimals1);
            
            logger.info(`Swapping ${amount1ToSwap.toFixed(6)} ${symbol1} to ${symbol0}...`);
            const swapResult = await this.swapTokens(token1, token0, amount1ToSwapWei.toString(), poolAddress);
            if (swapResult) {
              logger.info('Swap completed, waiting 10 seconds...');
              await delay(10000);
              // Get new balances
              const newAmount0 = await token0Contract.balanceOf(this.web3.wallet.address);
              const newAmount1 = await token1Contract.balanceOf(this.web3.wallet.address);
              amount0ToAdd = newAmount0;
              amount1ToAdd = newAmount1;
              logger.info(`New ${symbol0} balance: ${ethers.formatUnits(newAmount0, decimals0)}`);
              logger.info(`New ${symbol1} balance: ${ethers.formatUnits(newAmount1, decimals1)}`);
            } else {
              throw new Error(`Swap ${symbol1} -> ${symbol0} failed; aborting rebalance before mint`);
            }
          }
        } else {
          logger.info(
            `Token imbalance (${Math.abs(token0Diff).toFixed(2)} ${symbol1}) is below MIN_SWAP_VALUE_USDC (${minSwapValueUsdc}). Skipping swap.`
          );
        }
      }
      
      // Step 6: Create new position
      logger.info(`Creating new position with range ${tickLower} - ${tickUpper}...`);
      this.pendingRebalance.stage = 'creating_position';
      
      const newTokenId = await this.createPosition(
        token0, token1, poolAddress,
        tickLower, tickUpper,
        amount0ToAdd, amount1ToAdd,
        decimals0, decimals1
      );
      
      if (!newTokenId) {
        throw new Error('Failed to create new position');
      }
      
      logger.info(`New position created with tokenId: ${newTokenId}`);
      logger.info('Waiting 10 seconds before staking...');
      await delay(10000);
      
      // Step 7: Stake the new position
      if (gaugeAddress) {
        logger.info(`Staking position #${newTokenId} to gauge ${gaugeAddress}...`);
        this.pendingRebalance.stage = 'staking';
        
        try {
          await this.stakeToGauge(newTokenId, gaugeAddress);
          logger.info(`Position #${newTokenId} staked successfully`);
        } catch (e) {
          logger.error(`Staking error: ${e.message}`);
          logger.warn('Position created but not staked. You may need to stake manually.');
        }
      }
      
      // Clear pending rebalance
      this.pendingRebalance = null;
      
      logger.info(`Successfully rebalanced position #${tokenId} to new position #${newTokenId}`);
      
      return {
        success: true,
        newTokenId,
        newTickLower: tickLower,
        newTickUpper: tickUpper,
        amount0Added: amount0ToAdd.toString(),
        amount1Added: amount1ToAdd.toString()
      };
      
    } catch (error) {
      logger.error(`Rebalance failed: ${error.message}`);
      logger.error(`Stack: ${error.stack}`);
      throw error;
    }
  }

  /**
   * Swap tokens via the Aerodrome Universal Router.
   *
   * Flow:
   *   1. Read tickSpacing from pool.
   *   2. On-chain quote via Aerodrome Quoter → derive amountOutMinimum.
   *   3. Approve the router's Permit2 contract to spend tokenIn.
   *   4. Build execute() with command 0x00 (V3/CL exact-in) and
   *      CL path: tokenIn (20 bytes) + tickSpacing (3 bytes) + tokenOut (20 bytes).
   *   5. Send via Universal Router.
   */
  async swapTokens(tokenIn, tokenOut, amountIn, poolAddress) {
    if (BigInt(amountIn) === 0n) {
      logger.info('Amount to swap is 0, skipping swap');
      return null;
    }

    logger.info(`Swapping ${amountIn} of token ${tokenIn} for ${tokenOut} via Aerodrome Universal Router...`);

    try {
      const amountInBigInt = BigInt(amountIn.toString());
      const userAddress    = this.web3.wallet.address;
      const routerAddress  = config.aerodrome.universalRouter;

      // 1. Read tickSpacing from the pool
      const poolContract = new Contract(
        poolAddress,
        ['function tickSpacing() view returns (int24)'],
        this.web3.wallet
      );
      const tickSpacing = await poolContract.tickSpacing();

      // 2. On-chain quote — staticCall on the Aerodrome Quoter
      //    Struct order: tokenIn, tokenOut, amountIn, tickSpacing, sqrtPriceLimitX96
      const quoterContract = new Contract(
        config.aerodrome.quoter,
        ['function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, int24 tickSpacing, uint160 sqrtPriceLimitX96)) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)'],
        this.web3.wallet
      );
      const quoteResult = await quoterContract.quoteExactInputSingle.staticCall({
        tokenIn,
        tokenOut,
        amountIn:          amountInBigInt,
        tickSpacing,
        sqrtPriceLimitX96: 0n,
      });

      const expectedOut      = quoteResult[0];
      const amountOutMinimum = (expectedOut * BigInt(10000 - config.slippageBps)) / 10000n;

      logger.info(`Aerodrome quote amountOut: ${expectedOut}`);
      logger.info(`Aerodrome amountOutMinimum (${config.slippageBps}bps slippage): ${amountOutMinimum}`);

      // 3. Two-step Permit2 approval:
      //    a) ERC-20: approve Permit2 to spend tokenIn (one-time, max amount)
      //    b) Permit2: approve the Universal Router to pull tokenIn on our behalf
      const routerAbiPermit = new Contract(
        routerAddress,
        ['function PERMIT2() view returns (address)'],
        this.web3.wallet
      );
      const permit2Address = await routerAbiPermit.PERMIT2();

      // 3a. ERC-20 approval to Permit2
      await this.web3.approveToken(tokenIn, permit2Address, amountInBigInt.toString());

      // 3b. Permit2 allowance approval to Universal Router (skip if already max)
      const maxUint160 = (2n ** 160n) - 1n;
      const maxUint48  = (2n ** 48n)  - 1n;
      const permit2Contract = new Contract(
        permit2Address,
        [
          'function approve(address token, address spender, uint160 amount, uint48 expiration) external',
          'function allowance(address user, address token, address spender) view returns (uint160 amount, uint48 expiration, uint48 nonce)',
        ],
        this.web3.wallet
      );
      const [p2Amount] = await permit2Contract.allowance(userAddress, tokenIn, routerAddress);
      if (p2Amount < amountInBigInt) {
        logger.info(`Setting Permit2 allowance for ${tokenIn} → router...`);
        const permit2Tx = await permit2Contract.approve(tokenIn, routerAddress, maxUint160, maxUint48);
        await permit2Tx.wait();
        logger.info('Permit2 allowance set.');
        await delay(1000);
      } else {
        logger.info('Permit2 allowance already sufficient; skipping.');
      }

      // 4. Encode CL path:
      //    tokenIn (20 bytes) + poolParam (3 bytes) + tokenOut (20 bytes)
      //
      // Aerodrome UR expects Slipstream routes to use poolParam = 0x100000 + tickSpacing.
      // For this bot we route through Slipstream (isUni=false).
      const slipstreamPoolParam = (0x100000 + Number(tickSpacing)).toString(16).padStart(6, '0');
      const path = '0x'
        + tokenIn.slice(2).toLowerCase()
        + slipstreamPoolParam
        + tokenOut.slice(2).toLowerCase();

      // Input for command 0x00 (V3_SWAP_EXACT_IN — CL pool):
      //   abi.encode(recipient, amountIn, amountOutMinimum, path, payerIsUser, isUni)
      //   payerIsUser=true  => pull tokenIn from msg.sender via Permit2
      //   isUni=false       => Aerodrome Slipstream route format
      const abiCoder  = new ethers.AbiCoder();
      const swapInput = abiCoder.encode(
        ['address', 'uint256', 'uint256', 'bytes', 'bool', 'bool'],
        [userAddress, amountInBigInt, amountOutMinimum, path, true, false]
      );

      // 5. Execute via Universal Router: execute(commands, inputs[], deadline)
      const universalRouter = new Contract(
        routerAddress,
        ['function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable'],
        this.web3.wallet
      );

      const deadline  = BigInt(Math.floor(Date.now() / 1000) + 300); // 5 min
      const txRequest = await universalRouter.execute.populateTransaction(
        '0x00',       // command byte: V3_SWAP_EXACT_IN (CL concentrated liquidity pool)
        [swapInput],
        deadline
      );

      let receipt;
      try {
        receipt = await this.web3.sendTransaction(txRequest);
      } catch (sendError) {
        const isNonceExpired =
          sendError?.code === 'NONCE_EXPIRED' ||
          /nonce too low|nonce has already been used/i.test(sendError?.message || '');

        if (!isNonceExpired) throw sendError;

        logger.warn('Nonce expired on swap submit. Resetting nonce manager and retrying once...');
        if (typeof this.web3.wallet.reset === 'function') this.web3.wallet.reset();
        receipt = await this.web3.sendTransaction(txRequest);
      }

      logger.info(`Aerodrome swap completed, tx: ${receipt.hash}`);
      return receipt;
    } catch (error) {
      logger.error(`Aerodrome swap failed: ${error.message}`);
      if (error.data) logger.error(`Error data: ${error.data}`);
      return null;
    }
  }

  /**
   * Create a new LP position
   */
  async createPosition(token0, token1, poolAddress, tickLower, tickUpper, amount0, amount1, decimals0, decimals1) {
    const pmAddress = config.aerodrome.altPositionManager;
    
    logger.info(`Creating position in pool ${poolAddress}...`);
    logger.info(`Token0: ${token0}, Token1: ${token1}`);
    logger.info(`Range: ${tickLower} - ${tickUpper}`);
    logger.info(`Amount0: ${ethers.formatUnits(amount0, decimals0)}`);
    logger.info(`Amount1: ${ethers.formatUnits(amount1, decimals1)}`);
    
    try {
      // Get pool info
      const poolContract = new Contract(
        poolAddress,
        [
          'function fee() view returns (uint24)',
          'function tickSpacing() view returns (int24)'
        ],
        this.web3.wallet
      );
      
      const [fee, tickSpacing] = await Promise.all([
        poolContract.fee(),
        poolContract.tickSpacing()
      ]);
      
      logger.info(`Pool fee: ${fee}, tickSpacing: ${tickSpacing}`);
      
      // Convert amounts to BigInt
      const amount0BigInt = BigInt(amount0.toString());
      const amount1BigInt = BigInt(amount1.toString());
      
      // Approve tokens
      logger.info('Approving tokens for PositionManager...');
      await this.web3.approveToken(token0, pmAddress, amount0BigInt.toString());
      await this.web3.approveToken(token1, pmAddress, amount1BigInt.toString());
      logger.info('Tokens approved, waiting 3 seconds...');
      await delay(3000);
      
      // Calculate minimum amounts with slippage
      const amount0Min = (amount0BigInt * BigInt(10000 - config.slippageBps)) / 10000n;
      const amount1Min = (amount1BigInt * BigInt(10000 - config.slippageBps)) / 10000n;
      
      // Create position manager contract with Aerodrome-specific ABI
      // Aerodrome uses tickSpacing instead of fee, and has sqrtPriceX96 parameter
      const pm = new Contract(
        pmAddress,
        [
          'function mint((address token0, address token1, int24 tickSpacing, int24 tickLower, int24 tickUpper, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, address recipient, uint256 deadline, uint160 sqrtPriceX96)) external payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)'
        ],
        this.web3.wallet
      );
      
      const mintParams = {
        token0: token0,
        token1: token1,
        tickSpacing: tickSpacing,
        tickLower: tickLower,
        tickUpper: tickUpper,
        amount0Desired: amount0BigInt,
        amount1Desired: amount1BigInt,
        amount0Min: amount0Min,
        amount1Min: amount1Min,
        recipient: this.web3.wallet.address,
        deadline: Math.floor(Date.now() / 1000) + 600,
        sqrtPriceX96: 0  // Can be 0 for new positions
      };
      
      logger.info('Minting new position...');
      logger.info(`Mint params: ${JSON.stringify(mintParams, (key, value) => 
        typeof value === 'bigint' ? value.toString() : value
      )}`);
      
      // First try a static call to get the actual revert reason
      try {
        const callResult = await pm.mint.staticCall(mintParams);
        logger.info(`Static call succeeded, would return tokenId: ${callResult.tokenId}`);
      } catch (staticError) {
        logger.error(`Static call failed: ${staticError.message}`);
        if (staticError.data) {
          logger.error(`Error data: ${staticError.data}`);
        }
        // Try to decode the error
        if (staticError.reason) {
          logger.error(`Revert reason: ${staticError.reason}`);
        }
        return null;
      }
      
      logger.info('Submitting mint transaction...');
      const mintCallData = pm.interface.encodeFunctionData('mint', [mintParams]);
      const receipt = await this.web3.sendTransaction({
        to: pmAddress,
        data: mintCallData,
        value: 0n
      });
      
      logger.info(`Position created, tx: ${receipt.hash}`);
      
      // Get tokenId from event
      const iface = new ethers.Interface([
        'event IncreaseLiquidity(uint256 indexed tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)'
      ]);
      
      for (const log of receipt.logs) {
        try {
          const parsed = iface.parseLog({ topics: log.topics, data: log.data });
          if (parsed && parsed.name === 'IncreaseLiquidity') {
            logger.info(`New position tokenId: ${parsed.args.tokenId}`);
            return parsed.args.tokenId;
          }
        } catch (e) {
          // Not the event we're looking for
        }
      }
      
      // If we couldn't find the event, try to get the tokenId from the transfer event
      const nftIface = new ethers.Interface([
        'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)'
      ]);
      
      for (const log of receipt.logs) {
        try {
          const parsed = nftIface.parseLog({ topics: log.topics, data: log.data });
          if (parsed && parsed.name === 'Transfer' && parsed.args.from === '0x0000000000000000000000000000000000000000') {
            logger.info(`New position tokenId (from Transfer): ${parsed.args.tokenId}`);
            return parsed.args.tokenId;
          }
        } catch (e) {
          // Not the event we're looking for
        }
      }
      
      logger.warn('Could not find tokenId from events, check transaction manually');
      return null;
      
    } catch (error) {
      logger.error(`Create position failed: ${error.message}`);
      logger.error(`Stack: ${error.stack}`);
      return null;
    }
  }

  /**
   * Unstake a position from the gauge
   */
  async unstakeFromGauge(tokenId, gaugeAddress) {
    logger.info(`Unstaking position #${tokenId} from gauge ${gaugeAddress}...`);
    
    const gauge = new Contract(
      gaugeAddress,
      ['function withdraw(uint256)'],
      this.web3.wallet
    );
    
    const tx = await gauge.withdraw(tokenId);
    const receipt = await tx.wait();
    logger.info(`Unstaked position #${tokenId}, tx: ${receipt.hash}`);
    
    return receipt;
  }

  /**
   * Stake a position to the gauge
   */
  async stakeToGauge(tokenId, gaugeAddress) {
    logger.info(`Staking position #${tokenId} to gauge ${gaugeAddress}...`);
    
    // First approve the gauge to use the NFT
    const pmAddress = config.aerodrome.altPositionManager;
    const pm = new Contract(
      pmAddress,
      ['function approve(address, uint256)', 'function getApproved(uint256) view returns (address)'],
      this.web3.wallet
    );
    
    const approved = await pm.getApproved(tokenId);
    if (approved.toLowerCase() !== gaugeAddress.toLowerCase()) {
      logger.info(`Approving gauge for position #${tokenId}...`);
      const approveTx = await pm.approve(gaugeAddress, tokenId);
      await approveTx.wait();
      logger.info('Gauge approved, waiting 3 seconds...');
      await delay(3000);
    }
    
    const gauge = new Contract(
      gaugeAddress,
      ['function deposit(uint256)'],
      this.web3.wallet
    );
    
    const tx = await gauge.deposit(tokenId);
    const receipt = await tx.wait();
    logger.info(`Staked position #${tokenId}, tx: ${receipt.hash}`);
    
    return receipt;
  }
}

module.exports = { Rebalancer };
