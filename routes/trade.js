// routes/trade.js
require('dotenv').config();
const express = require("express");
const router = express.Router();
const pool = require('../db');
const { authenticateToken } = require('../middleware/auth');
const CoinMarketCap = require('coinmarketcap-api');
const cmc = new CoinMarketCap(process.env.COINMARKETCAP_API_KEY);

// Utility: Get per-user trade mode
async function getUserTradeMode(user_id) {
  const { rows } = await pool.query("SELECT mode FROM user_trade_modes WHERE user_id = $1", [user_id]);
  return (rows[0] && rows[0].mode) || null;
}
// Utility: Get global trade mode
async function getTradeMode() {
  const { rows } = await pool.query("SELECT value FROM settings WHERE key = 'TRADE_MODE'");
  return (rows[0] && rows[0].value) || 'AUTO';
}

// --- Set global trade mode (admin use) ---
router.post("/set-trade-mode", async (req, res) => {
  const { mode } = req.body;
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
    // Accept symbol from frontend, fallback to BTC
    let { user_id, direction, amount, duration, symbol } = req.body;
    if (!user_id || !direction || !amount || !duration)
      return res.status(400).json({ error: "Missing trade data" });

    // --- Allowed coins ---
    const ALLOWED_COINS = ["BTC", "ETH", "SOL", "XRP", "TON"];
    symbol = (symbol || "BTC").toUpperCase();
    if (!ALLOWED_COINS.includes(symbol))
      return res.status(400).json({ error: "Invalid coin symbol" });

    // Validate duration and amount
    const safeDuration = Math.max(5, Math.min(120, Number(duration))); // clamp 5-120
    const safeAmount = Math.max(1, Number(amount));

    // Check user and USDT balance
    const userRes = await pool.query("SELECT * FROM users WHERE id = $1", [user_id]);
    const user = userRes.rows[0];
    if (!user) return res.status(404).json({ error: "User not found" });

    const usdtRes = await pool.query(
      "SELECT * FROM user_balances WHERE user_id = $1 AND coin = 'USDT'",
      [user_id]
    );
    const usdt = usdtRes.rows[0];
    if (!usdt || parseFloat(usdt.balance) < safeAmount)
      return res.status(400).json({ error: "Insufficient USDT" });

    // --- 1. Get current price for selected coin (with fallback) ---
    let start_price = 0;
    try {
      const priceData = await cmc.getQuotes({ symbol });
      start_price = parseFloat(priceData.data[symbol].quote.USD.price);
    } catch {
      // fallback demo prices
      const fallback = { BTC: 65000, ETH: 3400, SOL: 140, XRP: 0.6, TON: 7.0 };
      start_price = fallback[symbol] || 1;
    }

    // --- 2. Deduct invest amount immediately ---
    await pool.query(
      "UPDATE user_balances SET balance = balance - $1 WHERE user_id = $2 AND coin = 'USDT'",
      [safeAmount, user_id]
    );

    // --- 3. Save as pending trade ---
    const timestamp = new Date().toISOString();
    const insertTradeRes = await pool.query(
      `INSERT INTO trades 
        (user_id, symbol, direction, amount, duration, start_price, result, profit, result_price, timestamp)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        RETURNING id`,
      [user.id, symbol, direction, safeAmount, safeDuration, start_price, "PENDING", 0, null, timestamp]
    );
    const trade_id = insertTradeRes.rows[0].id;
    
    // --- 4. Simulate trade result after {duration} seconds ---
    setTimeout(async () => {
      try {
        // 1. Check per-user and global trade mode
        let mode = await getUserTradeMode(user_id);
        if (!mode) mode = await getTradeMode();

        // 2. Calculate profit percent by duration
        const minSec = 5, maxSec = 120, minPct = 5, maxPct = 40;
        let percent = minPct + ((safeDuration - minSec) * (maxPct - minPct) / (maxSec - minSec));
        percent = Math.max(minPct, Math.min(maxPct, percent));
        percent = Math.round(percent * 100) / 100;

        let result, profit;
        if (mode === "WIN" || mode === "ALL_WIN") {
          result = "WIN";
          profit = Number((safeAmount * percent / 100).toFixed(2));
        } else if (mode === "LOSE" || mode === "ALL_LOSE") {
          result = "LOSE";
          profit = -Number((safeAmount * percent / 100).toFixed(2));
        } else {
          // AUTO: 50/50
          if (Math.random() < 0.5) {
            result = "WIN";
            profit = Number((safeAmount * percent / 100).toFixed(2));
          } else {
            result = "LOSE";
            profit = -Number((safeAmount * percent / 100).toFixed(2));
          }
        }

        // 3. Generate fake close price (within 0.3% volatility for realism)
        let result_price = start_price;
        let change = (Math.random() * 0.006 - 0.003) * start_price; // ±0.3%
        if (result === "WIN") {
          result_price = direction === "BUY" ? start_price + Math.abs(change) : start_price - Math.abs(change);
        } else {
          result_price = direction === "BUY" ? start_price - Math.abs(change) : start_price + Math.abs(change);
        }
        result_price = Number(result_price.toFixed(symbol === "XRP" ? 4 : symbol === "TON" ? 4 : 2));

        // 4. Update trade record
        await pool.query(
          `UPDATE trades SET result = $1, profit = $2, result_price = $3 WHERE id = $4`,
          [result, profit, result_price, trade_id]
        );

        // 5. Add back winnings (if win)
        if (result === "WIN") {
          await pool.query(
            `UPDATE user_balances SET balance = balance + $1 WHERE user_id = $2 AND coin = 'USDT'`,
            [safeAmount + profit, user_id]
          );
        }

        // 6. Insert into balance_history for user
        const { rows: balRows } = await pool.query(
          "SELECT balance FROM user_balances WHERE user_id = $1 AND coin = 'USDT'",
          [user_id]
        );
        const newBalance = balRows[0] ? parseFloat(balRows[0].balance) : 0;
        await pool.query(
          `INSERT INTO balance_history (user_id, coin, balance, price_usd, timestamp)
           VALUES ($1, $2, $3, $4, NOW())`,
          [user_id, 'USDT', newBalance, 1]
        );
      } catch (err) {
        console.error("Trade finish error:", err);
      }
    }, safeDuration * 1000);

    res.json({
      status: "pending",
      trade_id,
      start_price,
      symbol,
      direction,
      amount: safeAmount,
      duration: safeDuration,
      message: "Trade started! Wait for countdown..."
    });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- GET /api/trade/history/:user_id ----
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

// ---- GET /api/admin/trades ----
router.get('/trades', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT 
        t.id AS trade_id,
        t.user_id,
        u.username,
        t.direction,
        t.amount,
        t.duration,
        t.result,
        t.profit,
        t.timestamp
      FROM trades t
      LEFT JOIN users u ON t.user_id = u.id
      ORDER BY t.timestamp DESC
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch trades" });
  }
});

module.exports = router;
