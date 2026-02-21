require('dotenv').config();
const { Web3Manager } = require('./web3');
const { PositionMonitor } = require('./monitor');
const logger = require('./logger');

async function checkPositions() {
  if (!process.env.PRIVATE_KEY) {
    logger.error('PRIVATE_KEY not configured in .env');
    process.exit(1);
  }

  logger.info('Initializing...');
  const web3 = new Web3Manager();
  await web3.initialize();

  const monitor = new PositionMonitor(web3);
  const positions = await monitor.checkAllPositions(web3.wallet.address);

  if (positions.length === 0) {
    logger.info('No LP positions found.');
  } else {
    logger.info('\n=== POSITION SUMMARY ===');
    positions.forEach(p => {
      const status = p.isInRange ? '✅ IN RANGE' : (p.isBelowRange ? '🔻 BELOW' : '🔺 ABOVE');
      console.log(`\nPosition #${p.tokenId}`);
      console.log(`  Pool: ${p.token0Symbol}/${p.token1Symbol}`);
      console.log(`  Fee: ${p.fee}`);
      console.log(`  Status: ${status} (${p.percentOutOfRange}% out)`);
      console.log(`  Range: ${p.tickLower} - ${p.tickUpper}`);
      console.log(`  Current Tick: ${p.currentTick}`);
      console.log(`  Liquidity: ${p.liquidity}`);
    });
  }

  process.exit(0);
}

checkPositions();
