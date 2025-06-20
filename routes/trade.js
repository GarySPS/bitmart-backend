const express = require("express");
const router = express.Router();
const pool = require('../db');
const CoinMarketCap = require('coinmarketcap-api');
const cmc = new CoinMarketCap(process.env.COINMARKETCAP_API_KEY);

// Utility: Get per-user trade mode (WIN, LOSE, or null)
async function getUserTradeMode(user_id) {
  const { rows } = await pool.query("SELECT mode FROM user_trade_modes WHERE user_id = $1", [user_id]);
  return (rows[0] && rows[0].mode) || null;
}

// Utility: Get global trade mode (AUTO/ALL_WIN/ALL_LOSE)
async function getTradeMode() {
  const { rows } = await pool.query("SELECT value FROM settings WHERE key = 'TRADE_MODE'");
  return (rows[0] && rows[0].value) || 'AUTO';
}

// Utility: Set trade mode
router.post("/set-trade-mode", async (req, res) => {
  const { mode } = req.body; // 'AUTO', 'ALL_WIN', 'ALL_LOSE'
  if (!['AUTO', 'ALL_WIN', 'ALL_LOSE'].includes(mode)) {
    return res.status(400).json({ error: "Invalid trade mode" });
  }
  try {
    await pool.query(
      "INSERT INTO settings (key, value) VALUES ('TRADE_MODE', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
      [mode]
    );
    res.json({ success: true, mode });
  } catch (err) {
    res.status(500).json({ error: "Failed to update mode" });
  }
});

// ---- POST /api/trade ----
router.post("/", async (req, res) => {
  try {
    const { user_id, direction, amount, duration } = req.body;
    if (!user_id || !direction || !amount || !duration)
      return res.status(400).json({ error: "Missing trade data" });

    // Fetch user & check balance
    const userRes = await pool.query("SELECT * FROM users WHERE id = $1", [user_id]);
    const user = userRes.rows[0];
    if (!user) return res.status(404).json({ error: "User not found" });

    const usdtRes = await pool.query(
      "SELECT * FROM user_balances WHERE user_id = $1 AND coin = 'USDT'",
      [user_id]
    );
    const usdt = usdtRes.rows[0];
    if (!usdt || usdt.balance < amount)
      return res.status(400).json({ error: "Insufficient USDT" });

    // --- 1. Get entry price (BTC) ---
    const priceData = await cmc.getQuotes({ symbol: "BTC" });
    const start_price = parseFloat(priceData.data.BTC.quote.USD.price);

    // --- 2. Deduct invest amount immediately ---
    await pool.query(
      "UPDATE user_balances SET balance = balance - $1 WHERE user_id = $2 AND coin = 'USDT'",
      [amount, user_id]
    );

    // --- 3. Save as pending trade ---
    const timestamp = new Date().toISOString();
    const insertTradeRes = await pool.query(
      `INSERT INTO trades 
        (user_id, username, direction, amount, duration, start_price, result, profit, timestamp) 
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        RETURNING id`,
      [user.id, user.username, direction, amount, duration, start_price, "PENDING", 0, timestamp]
    );
    const trade_id = insertTradeRes.rows[0].id;

    // --- Wait duration, then resolve trade (simulate countdown) ---
    setTimeout(async () => {
      try {
        let mode = await getUserTradeMode(user_id);
        if (!mode) {
          mode = await getTradeMode();
        } else {
          mode = mode === "WIN" ? "ALL_WIN" : "ALL_LOSE";
        }

        // Result/Profit calculation
        let percent = 10; // WIN/LOSE = 10% of amount
        let result, profit;
        if (mode === "ALL_WIN") {
          result = "WIN";
          profit = Math.round(amount * percent) / 100;
        } else {
          result = "LOSE";
          profit = -Math.round(amount * percent) / 100;
        }

        // Save to DB
        await pool.query(
          `UPDATE trades SET result = $1, profit = $2 WHERE id = $3`,
          [result, profit, trade_id]
        );
        if (result === "WIN") {
          await pool.query(
            `UPDATE user_balances SET balance = balance + $1 WHERE user_id = $2 AND coin = 'USDT'`,
            [amount + profit, user_id]
          );
        }
      } catch (err) {
        console.error("Trade finish error:", err);
      }
    }, duration * 1000);

    res.json({
      status: "pending",
      trade_id,
      start_price,
      direction,
      amount,
      duration,
      message: "Trade started! Wait for countdown..."
    });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- GET /api/trade/history/:user_id (user trade history) ----
router.get("/history/:user_id", async (req, res) => {
  const { user_id } = req.params;
  try {
    const { rows } = await pool.query(
      `SELECT * FROM trades WHERE user_id = $1 ORDER BY timestamp DESC`,
      [user_id]
    );
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: "DB error" });
  }
});

module.exports = router;
