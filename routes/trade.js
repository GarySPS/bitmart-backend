const { authenticateToken } = require('../middleware/auth');
const express = require("express");
const router = express.Router();
const pool = require('../db');
const CoinMarketCap = require('coinmarketcap-api');
const cmc = new CoinMarketCap(process.env.COINMARKETCAP_API_KEY);

// --- Utility: Get per-user trade mode ---
async function getUserTradeMode(user_id) {
  const { rows } = await pool.query("SELECT mode FROM user_trade_modes WHERE user_id = $1", [user_id]);
  return (rows[0] && rows[0].mode) || null;
}

// --- Utility: Get global trade mode ---
async function getTradeMode() {
  const { rows } = await pool.query("SELECT value FROM settings WHERE key = 'TRADE_MODE'");
  return (rows[0] && rows[0].value) || 'AUTO';
}

// --- Set global trade mode ---
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

    // Check user exists & USDT balance
    const userRes = await pool.query("SELECT * FROM users WHERE id = $1", [user_id]);
    const user = userRes.rows[0];
    if (!user) return res.status(404).json({ error: "User not found" });

    const usdtRes = await pool.query(
      "SELECT * FROM user_balances WHERE user_id = $1 AND coin = 'USDT'",
      [user_id]
    );
    const usdt = usdtRes.rows[0];
    if (!usdt || parseFloat(usdt.balance) < parseFloat(amount))
      return res.status(400).json({ error: "Insufficient USDT" });

    // 1. Get current BTC price
    const priceData = await cmc.getQuotes({ symbol: "BTC" });
    const start_price = parseFloat(priceData.data.BTC.quote.USD.price);

    // 2. Deduct invest amount immediately
    await pool.query(
      "UPDATE user_balances SET balance = balance - $1 WHERE user_id = $2 AND coin = 'USDT'",
      [amount, user_id]
    );

    // 3. Save as pending trade
    const timestamp = new Date().toISOString();
    const insertTradeRes = await pool.query(
      `INSERT INTO trades 
        (user_id, direction, amount, duration, start_price, result, profit, result_price, timestamp)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        RETURNING id`,
      [user.id, direction, amount, duration, start_price, "PENDING", 0, null, timestamp]
    );
    const trade_id = insertTradeRes.rows[0].id;
    
    // 4. Simulate trade result after {duration} seconds (auto or admin controlled)
    setTimeout(async () => {
      try {
        // --- 1. Check per-user and global trade mode ---
        let mode = await getUserTradeMode(user_id);
        let source = "user";
        if (!mode) {
          mode = await getTradeMode();
          source = "global";
        }
        // --- 2. Calculate result and profit ---
        // ---- Dynamic profit percent by duration ----
const minSec = 5, maxSec = 120, minPct = 5, maxPct = 40;
let percent = minPct;
if (duration <= minSec) percent = minPct;
else if (duration >= maxSec) percent = maxPct;
else percent = minPct + ((duration - minSec) * (maxPct - minPct) / (maxSec - minSec));
percent = Math.round(percent * 100) / 100; // round for nice log

let result, profit;
if (mode === "WIN" || mode === "ALL_WIN") {
  result = "WIN";
  profit = Number((amount * percent / 100).toFixed(2));
} else if (mode === "LOSE" || mode === "ALL_LOSE") {
  result = "LOSE";
  profit = -Number((amount * percent / 100).toFixed(2));
} else if (mode === "AUTO") {
  if (Math.random() < 0.5) {
    result = "WIN";
    profit = Number((amount * percent / 100).toFixed(2));
  } else {
    result = "LOSE";
    profit = -Number((amount * percent / 100).toFixed(2));
  }
} else {
  result = "LOSE";
  profit = -Number((amount * percent / 100).toFixed(2));
}

        // --- 3. Generate fake close price based on result ---
        let result_price = start_price;
        if (result === "WIN") {
          result_price = direction === "BUY"
            ? start_price + Math.random() * 10
            : start_price - Math.random() * 10;
        } else if (result === "LOSE") {
          result_price = direction === "BUY"
            ? start_price - Math.random() * 10
            : start_price + Math.random() * 10;
        }
        result_price = Number(result_price.toFixed(2));

        // --- 4. Update trade record ---
        await pool.query(
          `UPDATE trades SET result = $1, profit = $2, result_price = $3 WHERE id = $4`,
          [result, profit, result_price, trade_id]
        );

        // --- 5. Add back winnings (if win) ---
        if (result === "WIN") {
          await pool.query(
            `UPDATE user_balances SET balance = balance + $1 WHERE user_id = $2 AND coin = 'USDT'`,
            [parseFloat(amount) + profit, user_id]
          );
        }

        // --- 6. Insert into balance_history for user (after trade resolved) ---
        // Always log balance after trade completes
        const { rows: balRows } = await pool.query(
          "SELECT balance FROM user_balances WHERE user_id = $1 AND coin = 'USDT'",
          [user_id]
        );
        const newBalance = balRows[0] ? parseFloat(balRows[0].balance) : 0;
        const price_usd = 1; // For USDT, always 1
        await pool.query(
          `INSERT INTO balance_history (user_id, coin, balance, price_usd, timestamp)
           VALUES ($1, $2, $3, $4, NOW())`,
          [user_id, 'USDT', newBalance, price_usd]
        );
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
    console.error("Trade history error:", err);
    res.status(500).json({ error: "DB error" });
  }
});

// GET /api/admin/trades
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
    console.error("Failed to fetch trades:", err);
    res.status(500).json({ error: "Failed to fetch trades" });
  }
});

module.exports = router;
