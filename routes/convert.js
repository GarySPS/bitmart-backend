// routes/convert.js — Free live prices version
const express = require("express");
const router = express.Router();
const pool = require("../db");
const { authenticateToken } = require("../middleware/auth");
const axios = require("axios");

// Symbol -> CoinGecko ID
const CG_ID = {
  BTC: "bitcoin",
  ETH: "ethereum",
  SOL: "solana",
  XRP: "ripple",
  TON: "the-open-network",
  USDT: "tether",
};

// Get live USD price for symbol (CoinGecko primary, Binance fallback)
async function getSpotUSD(symbol) {
  const sym = symbol.toUpperCase();

  // 1) CoinGecko
  try {
    const id = CG_ID[sym];
    if (id) {
      const url = `https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd`;
      const { data } = await axios.get(url, { timeout: 8000 });
      const price = Number(data?.[id]?.usd);
      if (price) return price;
    }
  } catch (_) {}

  // 2) Binance (via USDT)
  try {
    const url = `https://api.binance.com/api/v3/ticker/price?symbol=${sym}USDT`;
    const { data } = await axios.get(url, { timeout: 8000 });
    const price = Number(data?.price);
    if (price) return price;
  } catch (_) {}

  throw new Error("PRICE_UNAVAILABLE");
}

router.post("/", authenticateToken, async (req, res) => {
  try {
    const { from_coin, to_coin, amount } = req.body;
    const user_id = req.user.id;

    const fromSym = from_coin?.toUpperCase();
    const toSym = to_coin?.toUpperCase();

    if (!CG_ID[fromSym] || !CG_ID[toSym]) {
      return res.status(400).json({ error: "Invalid coin" });
    }
    if (fromSym === toSym) {
      return res.status(400).json({ error: "Cannot convert to same coin" });
    }

    let rate = 1;
    let received = 0;

    // USDT -> Other coin
    if (fromSym === "USDT" && toSym !== "USDT") {
      rate = await getSpotUSD(toSym);
      received = parseFloat(amount) / rate;
    }
    // Other coin -> USDT
    else if (toSym === "USDT" && fromSym !== "USDT") {
      rate = await getSpotUSD(fromSym);
      received = parseFloat(amount) * rate;
    }
    // Disallow other swaps
    else {
      return res
        .status(400)
        .json({ error: "Only USDT to coin or coin to USDT swaps allowed." });
    }

    // Check user has enough balance
    const balRes = await pool.query(
      "SELECT balance FROM user_balances WHERE user_id = $1 AND coin = $2",
      [user_id, fromSym]
    );
    const balance = parseFloat(balRes.rows[0]?.balance || 0);
    if (balance < parseFloat(amount)) {
      return res.status(400).json({ error: "Insufficient balance." });
    }

    // Update balances (subtract from_coin, add to_coin)
    await pool.query(
      "UPDATE user_balances SET balance = balance - $1 WHERE user_id = $2 AND coin = $3",
      [amount, user_id, fromSym]
    );
    await pool.query(
      `INSERT INTO user_balances (user_id, coin, balance)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, coin) DO UPDATE SET balance = user_balances.balance + $3`,
      [user_id, toSym, received]
    );

    // Record conversion
    await pool.query(
      `INSERT INTO conversions (user_id, from_coin, to_coin, amount, received, rate)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [user_id, fromSym, toSym, amount, received, rate]
    );

    res.json({ success: true, received, rate });
  } catch (err) {
    console.error("Convert error:", err.message || err);
    res.status(500).json({ error: "Conversion failed." });
  }
});

module.exports = router;
