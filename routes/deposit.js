const express = require('express');
const router = express.Router();
const pool = require('../db');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { authenticateToken } = require('../middleware/auth');

// Ensure uploads dir exists
if (!fs.existsSync('./uploads')) {
  fs.mkdirSync('./uploads');
}
const storage = multer.diskStorage({
  destination: './uploads/',
  filename: (req, file, cb) => {
    const uniqueName = Date.now() + '-' + file.originalname.replace(/\s/g, "_");
    cb(null, uniqueName);
  }
});
const upload = multer({ storage });

// --- Create deposit (user, with screenshot upload, JWT protected) ---
router.post(
  '/',
  authenticateToken,
  upload.single('screenshot'),
  async (req, res) => {
    const user_id = req.user.id;
    const { coin, amount, address } = req.body;
    const screenshot = req.file ? req.file.filename : "";

    if (!user_id || !coin || !amount || !address) {
      return res.status(400).json({ error: 'Missing required fields' });
    }
    try {
      // Insert with 'pending' status!
      const result = await pool.query(
        `INSERT INTO deposits (user_id, coin, amount, address, screenshot, status)
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
        [user_id, coin, amount, address, screenshot, 'pending']
      );
      res.json({ success: true, id: result.rows[0].id });
    } catch (err) {
      res.status(500).json({ error: 'Database error' });
    }
  }
);

// --- Get all deposits (admin view, or user with filter) ---
router.get('/', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM deposits ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
});

// --- Admin: Approve/Reject deposit by id ---
router.post('/:id/status', async (req, res) => {
  const { status } = req.body;
  const { id } = req.params;
  if (!["approved", "rejected", "pending"].includes(status)) {
    return res.status(400).json({ error: "Invalid status" });
  }
  try {
    const { rows } = await pool.query('SELECT * FROM deposits WHERE id = $1', [id]);
    const deposit = rows[0];
    if (!deposit) return res.status(404).json({ error: "Deposit not found" });

    await pool.query('UPDATE deposits SET status = $1 WHERE id = $2', [status, id]);

    if (status === "approved") {
      // 1. Update user balance (insert or add)
      await pool.query(
        `INSERT INTO user_balances (user_id, coin, balance)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id, coin) DO UPDATE
         SET balance = user_balances.balance + EXCLUDED.balance`,
        [deposit.user_id, deposit.coin, deposit.amount]
      );

      // 2. Get the latest balance for this user and coin
      const { rows: balanceRows } = await pool.query(
        `SELECT balance FROM user_balances WHERE user_id = $1 AND coin = $2`,
        [deposit.user_id, deposit.coin]
      );
      const newBalance = balanceRows[0] ? parseFloat(balanceRows[0].balance) : 0;

      // 3. Get latest USD price for this coin (LIVE: from prices, fallback 1 for USDT)
      let price_usd = 1;
      if (deposit.coin !== "USDT") {
        const { rows: priceRows } = await pool.query(
          `SELECT price_usd FROM prices WHERE symbol = $1 ORDER BY updated_at DESC LIMIT 1`,
          [deposit.coin]
        );
        price_usd = priceRows[0] ? parseFloat(priceRows[0].price_usd) : 1;
        if (!price_usd || isNaN(price_usd)) price_usd = 1;
      }

      // 4. Insert into balance_history (timestamped as now)
      await pool.query(
        `INSERT INTO balance_history (user_id, coin, balance, price_usd, timestamp)
         VALUES ($1, $2, $3, $4, NOW())`,
        [deposit.user_id, deposit.coin, newBalance, price_usd]
      );

      return res.json({ success: true, balanceAdded: true });
    } else {
      return res.json({ success: true, balanceAdded: false });
    }
  } catch (err) {
    console.error("Deposit approve error:", err);
    res.status(500).json({ error: 'Database error', detail: err.message });
  }
});



module.exports = router;
