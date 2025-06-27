// routes/convert.js (Express route example)
const express = require('express');
const router = express.Router();
const pool = require('../db');
const { authenticateToken } = require('../middleware/auth');

// Replace this with your price source!
const STATIC_PRICES = {
  BTC: 107419.98,
  ETH: 2453.07,
  SOL: 143.66,
  XRP: 2.17,
  TON: 6.34,
  USDT: 1,
};

router.post('/', authenticateToken, async (req, res) => {
  try {
    const { from_coin, to_coin, amount } = req.body;
    const user_id = req.user.id;
    if (!STATIC_PRICES[from_coin] || !STATIC_PRICES[to_coin]) {
      return res.status(400).json({ error: "Invalid coin" });
    }
    if (from_coin === to_coin) {
      return res.status(400).json({ error: "Cannot convert to same coin" });
    }

    let rate = 1;
    let received = 0;

    // USDT -> Other coin
    if (from_coin === "USDT" && to_coin !== "USDT") {
      rate = STATIC_PRICES[to_coin];
      received = parseFloat(amount) / rate;
    }
    // Other coin -> USDT
    else if (to_coin === "USDT" && from_coin !== "USDT") {
      rate = STATIC_PRICES[from_coin];
      received = parseFloat(amount) * rate;
    }
    // Disallow other swaps
    else {
      return res.status(400).json({ error: "Only USDT to coin or coin to USDT swaps allowed." });
    }

    // Check user has enough balance
    const balRes = await pool.query(
      "SELECT balance FROM user_balances WHERE user_id = $1 AND coin = $2",
      [user_id, from_coin]
    );
    const balance = parseFloat(balRes.rows[0]?.balance || 0);
    if (balance < parseFloat(amount)) {
      return res.status(400).json({ error: "Insufficient balance." });
    }

    // Update balances (subtract from_coin, add to_coin)
    await pool.query(
      "UPDATE user_balances SET balance = balance - $1 WHERE user_id = $2 AND coin = $3",
      [amount, user_id, from_coin]
    );
    await pool.query(
      `INSERT INTO user_balances (user_id, coin, balance)
        VALUES ($1, $2, $3)
        ON CONFLICT (user_id, coin) DO UPDATE SET balance = user_balances.balance + $3`,
      [user_id, to_coin, received]
    );

    // Record conversion
    await pool.query(
      `INSERT INTO conversions (user_id, from_coin, to_coin, amount, received, rate)
        VALUES ($1, $2, $3, $4, $5, $6)`,
      [user_id, from_coin, to_coin, amount, received, rate]
    );

    res.json({ success: true, received, rate });
  } catch (err) {
    console.error("Convert error:", err);
    res.status(500).json({ error: "Conversion failed." });
  }
});

module.exports = router;
