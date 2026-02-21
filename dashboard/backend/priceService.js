import './polyfill.js';

const COINGECKO_URL =
  'https://api.coingecko.com/api/v3/simple/price?ids=aerodrome-finance,weth,coinbase-wrapped-btc,usd-coin,solana&vs_currencies=usd';

let priceCache = null;
let lastFetch = 0;
const CACHE_TTL = 60_000; // 1 minute

export async function fetchPrices() {
  if (priceCache && Date.now() - lastFetch < CACHE_TTL) {
    return priceCache;
  }

  try {
    const res = await fetch(COINGECKO_URL, {
      headers: { 'Accept': 'application/json' },
      signal: AbortSignal.timeout(10_000),
    });
    const data = await res.json();

    priceCache = {
      AERO:  data['aerodrome-finance']?.usd    || 0,
      WETH:  data['weth']?.usd                 || 0,
      ETH:   data['weth']?.usd                 || 0,
      cbBTC: data['coinbase-wrapped-btc']?.usd || 0,
      USDC:  data['usd-coin']?.usd             || 1.0,
      SOL:   data['solana']?.usd               || 0,
    };
    lastFetch = Date.now();
    return priceCache;
  } catch (e) {
    console.warn('[PriceService] Fetch failed:', e.message);
    return priceCache || { AERO: 0, WETH: 0, ETH: 0, cbBTC: 0, USDC: 1.0, SOL: 0 };
  }
}
