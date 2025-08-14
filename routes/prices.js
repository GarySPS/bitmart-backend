// routes/prices.js — FREE version (CoinGecko + Binance)
// Response shapes preserved:
// 1) GET /prices                 -> { data: [...], prices: { SYM: price, ... } }
// 2) GET /prices/:symbol         -> { symbol, price }
// 3) GET /prices/chart/btcusdt   -> { candles: [{time,open,high,low,close}] }

const express = require("express");
const axios = require("axios");
const router = express.Router();

const SUPPORTED_COINS = ["BTC", "ETH", "USDT", "SOL", "XRP", "TON"];

// Symbol -> CoinGecko ID
const CG_ID = {
  BTC: "bitcoin",
  ETH: "ethereum",
  USDT: "tether",
  SOL: "solana",
  XRP: "ripple",
  TON: "the-open-network",
  BNB: "binancecoin",
  ADA: "cardano",
  DOGE: "dogecoin",
  TRX: "tron",
  MATIC: "matic-network",
};

function normalizeSymbol(input) {
  if (!input) return "";
  let s = String(input).trim().toUpperCase().replace(/\s+/g, "");
  if (s.includes("/")) s = s.split("/")[0];
  if (s.includes("-")) s = s.split("-")[0];
  if (s.endsWith("USDT")) s = s.slice(0, -4);
  if (s.endsWith("USD")) s = s.slice(0, -3);
  return s;
}

// tiny in-memory cache (reduce free-tier rate hits)
let cacheList = { t: 0, data: [], prices: {} };
const CACHE_MS = 10_000;

/* -------------------- CHART (put before /:symbol!) -------------------- */
// --- GET /prices/chart/btcusdt (candles for PremiumChart) ---
router.get("/chart/btcusdt", async (_req, res) => {
  try {
    // Binance 15m klines, last ~2 days (192 points)
    const url = "https://api.binance.com/api/v3/klines?symbol=BTCUSDT&interval=15m&limit=192";
    const { data } = await axios.get(url, { timeout: 8000 });
    const candles = data.map((k) => ({
      time: Math.floor(k[0] / 1000), // open time (sec)
      open: Number(k[1]),
      high: Number(k[2]),
      low: Number(k[3]),
      close: Number(k[4]),
    }));
    res.json({ candles });
  } catch {
    res.json({ candles: [] });
  }
});

/* -------------------- LIST -------------------- */
// --- GET /prices (Dashboard/Wallet list) ---
router.get("/", async (_req, res) => {
  const now = Date.now();
  if (now - cacheList.t < CACHE_MS && cacheList.data.length) {
    return res.json({ data: cacheList.data, prices: cacheList.prices });
  }

  try {
    // CoinGecko top-by-market-cap (free, no key)
    const perPage = 50;
    const url =
      `https://api.coingecko.com/api/v3/coins/markets` +
      `?vs_currency=usd&order=market_cap_desc&per_page=${perPage}&page=1&sparkline=false&price_change_percentage=24h`;

    const { data: items } = await axios.get(url, { timeout: 8000 });

    // Map to CMC-like shape expected by your frontend
    const data = items.map((c) => ({
      id: c.id, // e.g., "bitcoin"
      name: c.name,
      symbol: (c.symbol || "").toUpperCase(),
      quote: {
        USD: {
          price: Number(c.current_price),
          percent_change_24h: Number(c.price_change_percentage_24h ?? 0),
          volume_24h: Number(c.total_volume ?? 0),
          market_cap: Number(c.market_cap ?? 0),
        },
      },
    }));

    // Build simple prices map for wallet usage
    const prices = {};
    data.forEach((c) => (prices[c.symbol] = c.quote.USD.price));

    cacheList = { t: now, data, prices };
    res.json({ data, prices });
  } catch {
    // static fallback (very rare)
    const STATIC_PRICES = { BTC: 107719.98, ETH: 2453.07, SOL: 143.66, XRP: 3, TON: 6.34, USDT: 1 };
    const prices = {};
    SUPPORTED_COINS.forEach((s) => (prices[s] = STATIC_PRICES[s]));
    res.json({ data: [], prices });
  }
});

/* -------------------- SINGLE (real-time, no stale constants unless allowed) -------------------- */
// GET /prices/:symbol  -> { symbol, price }
router.get("/:symbol", async (req, res) => {
  const raw = req.params.symbol;
  const symbol = normalizeSymbol(raw);
  const allowStatic = process.env.ALLOW_STATIC_FALLBACK === "1"; // opt-in only

  // 1) CoinGecko primary (with TON fallback id)
  try {
    let id = CG_ID[symbol];
    if (!id && symbol === "TON") id = "toncoin"; // some endpoints list TON as "toncoin"
    if (id) {
      const url = `https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd`;
      const { data } = await axios.get(url, { timeout: 5000 });
      const price = Number(data?.[id]?.usd);
      if (isFinite(price) && price > 0) return res.json({ symbol, price });
    }
  } catch {}

  // 2) Binance fallback (USDT proxy for USD)
  try {
    const url = `https://api.binance.com/api/v3/ticker/price?symbol=${symbol}USDT`;
    const { data } = await axios.get(url, { timeout: 5000 });
    const price = Number(data?.price);
    if (isFinite(price) && price > 0) return res.json({ symbol, price });
  } catch {}

  // 3) Coinbase fallback (USD spot)
  try {
    const url = `https://api.coinbase.com/v2/prices/${symbol}-USD/spot`;
    const { data } = await axios.get(url, {
      timeout: 5000,
      headers: { "CB-VERSION": "2023-01-01" },
    });
    const price = Number(data?.data?.amount);
    if (isFinite(price) && price > 0) return res.json({ symbol, price });
  } catch {}

  // 4) Optional static fallback (only if explicitly enabled)
  if (allowStatic) {
    const STATIC_PRICES = { BTC: 107419.98, ETH: 2453.07, SOL: 143.66, XRP: 0.6, TON: 7.0, USDT: 1 };
    if (STATIC_PRICES[symbol]) return res.json({ symbol, price: STATIC_PRICES[symbol] });
  }

  // If we got here, we couldn't fetch live price—signal that to the client instead of lying
  return res.status(503).json({ error: "LIVE_PRICE_UNAVAILABLE" });
});


module.exports = router;
