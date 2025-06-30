// routes/prices.js

const express = require('express');
const axios = require('axios');
const router = express.Router();

const CMC_API_KEY = process.env.COINMARKETCAP_API_KEY;

const SUPPORTED_COINS = [
  "BTC", "ETH", "USDT", "SOL", "XRP", "TON"
];

// --- GET /api/prices (All coins for Dashboard/Wallet) ---
router.get('/', async (req, res) => {
  try {
    const response = await axios.get(
      'https://pro-api.coinmarketcap.com/v1/cryptocurrency/listings/latest?limit=50',
      { headers: { 'X-CMC_PRO_API_KEY': CMC_API_KEY } }
    );
    if (!Array.isArray(response.data.data)) {
      return res.status(500).json({ error: "Invalid data from CoinMarketCap" });
    }
    // Only include supported coins for dashboard table
    const data = response.data.data; // ← get ALL (up to 50) coins!
    // Build a map for Wallet page
    const prices = {};
    data.forEach(c => {
      prices[c.symbol] = c.quote.USD.price;
    });
    res.json({ data, prices });
  } catch (error) {
    // fallback: static prices
    const STATIC_PRICES = {
      BTC: 107419.98,
      ETH: 2453.07,
      SOL: 143.66,
      XRP: 2.17,
      TON: 6.34,
      USDT: 1
    };
    const prices = {};
    SUPPORTED_COINS.forEach(symbol => prices[symbol] = STATIC_PRICES[symbol]);
    res.json({ data: [], prices });
  }
});

// --- GET /api/price/:symbol (Single coin for Trade page) ---
router.get('/:symbol', async (req, res) => {
  const symbol = req.params.symbol.toUpperCase();
  try {
    const response = await axios.get(
      'https://pro-api.coinmarketcap.com/v1/cryptocurrency/quotes/latest',
      {
        params: { symbol },
        headers: { 'X-CMC_PRO_API_KEY': CMC_API_KEY }
      }
    );
    const data = response.data.data;
    if (
      data &&
      data[symbol] &&
      data[symbol].quote &&
      data[symbol].quote.USD &&
      typeof data[symbol].quote.USD.price === 'number'
    ) {
      return res.json({ symbol, price: data[symbol].quote.USD.price });
    }
    // fallback below if not found
  } catch (err) {
    // fallback below
  }

  // fallback: static price
  const STATIC_PRICES = {
    BTC: 107419.98,
    ETH: 2453.07,
    SOL: 143.66,
    XRP: 2.17,
    TON: 6.34,
    USDT: 1
  };
  if (STATIC_PRICES[symbol]) {
    return res.json({ symbol, price: STATIC_PRICES[symbol] });
  }
  res.status(404).json({ error: "Not found" });
});

// --- GET /api/chart/btcusdt (BTC/USDT candles for PremiumChart) ---
router.get('/chart/btcusdt', async (req, res) => {
  try {
    // Use the OHLCV endpoint for BTC (id=1)
    const response = await axios.get(
      'https://pro-api.coinmarketcap.com/v1/cryptocurrency/ohlcv/historical',
      {
        params: {
          id: 1,           // BTC ID in CMC
          convert: 'USDT', // Convert to USDT
          time_start: Math.floor(Date.now() / 1000) - 60 * 60 * 24 * 2, // last 2 days (or more, as you want)
          time_end: Math.floor(Date.now() / 1000),
          interval: '15m', // or '1h', etc.
        },
        headers: { 'X-CMC_PRO_API_KEY': CMC_API_KEY }
      }
    );

    const candles = response.data.data.quotes.map(q => ({
      time: Math.floor(new Date(q.timestamp).getTime() / 1000), // unix seconds
      open: q.quote.USDT.open,
      high: q.quote.USDT.high,
      low: q.quote.USDT.low,
      close: q.quote.USDT.close,
    }));

    res.json({ candles });
  } catch (err) {
    // fallback: empty or static candles
    res.json({ candles: [] });
  }
});

module.exports = router;
