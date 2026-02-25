import './polyfill.js';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '../../.env') });
dotenv.config({ path: join(__dirname, '../.env'), override: true });

const RPC_URL         = process.env.BASE_RPC_URL || '';
const ALCHEMY_API_KEY = process.env.ALCHEMY_API_KEY || (RPC_URL.includes('alchemy.com') ? RPC_URL.split('/v2/')[1] : null);

// SOL price is derived on-chain from sqrtPriceX96 — only need ETH + AERO here
// ETH  → Binance ticker (no key, real-time)
// AERO → Alchemy historical (not listed on Binance)

let priceCache = null;
let lastFetch  = 0;
const CACHE_TTL = 15_000; // 15 seconds

async function fetchBinanceTicker(pair) {
  const res  = await fetch(
    `https://api.binance.com/api/v3/ticker/price?symbol=${pair}`,
    { signal: AbortSignal.timeout(5_000) }
  );
  const data = await res.json();
  return parseFloat(data?.price) || 0;
}

async function fetchAeroPrice() {
  try {
    const res  = await fetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=aerodrome-finance&vs_currencies=usd',
      { signal: AbortSignal.timeout(8_000) }
    );
    const data = await res.json();
    return data['aerodrome-finance']?.usd || 0;
  } catch {
    return 0;
  }
}

export async function fetchPrices() {
  if (priceCache && Date.now() - lastFetch < CACHE_TTL) {
    return priceCache;
  }

  try {
    const [ethPrice, aeroPrice] = await Promise.all([
      fetchBinanceTicker('ETHUSDT'),
      fetchAeroPrice(),
    ]);

    priceCache = { ETH: ethPrice, WETH: ethPrice, AERO: aeroPrice, USDC: 1.0 };
    lastFetch  = Date.now();
    return priceCache;
  } catch (e) {
    console.warn('[PriceService] Price fetch failed:', e.message);
    return priceCache || { ETH: 0, WETH: 0, AERO: 0, USDC: 1.0 };
  }
}
