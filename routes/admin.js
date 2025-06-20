// routes/admin.js
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
    console.error("❌ Failed to fetch users:", err.message);
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
    // First, get deposit info
    const { rows } = await pool.query('SELECT * FROM deposits WHERE id = $1', [id]);
    const deposit = rows[0];
    if (!deposit) return res.status(404).json({ error: "Deposit not found" });

    // Update deposit status
    await pool.query('UPDATE deposits SET status = $1 WHERE id = $2', [status, id]);

    if (status === "approved") {
      // Insert or update balance in user_balances table
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

    // Only proceed if not already approved (avoid double deduction)
    if (row.status !== 'approved' && status === "approved") {
      // 1️⃣ Check user has enough balance for this coin
      const { rows: balRows } = await pool.query(
        'SELECT balance FROM user_balances WHERE user_id = $1 AND coin = $2',
        [withdrawal.user_id, withdrawal.coin]
      );
      const userBal = balRows[0];
      if (!userBal) return res.status(500).json({ error: "User balance not found" });
      if (parseFloat(userBal.balance) < parseFloat(withdrawal.amount)) {
        return res.status(400).json({ error: "Insufficient balance" });
      }
      // 2️⃣ Update withdrawal status to approved
      await pool.query('UPDATE withdrawals SET status = $1 WHERE id = $2', [status, id]);
      // 3️⃣ Subtract amount from user's balance for this coin
      await pool.query(
        'UPDATE user_balances SET balance = balance - $1 WHERE user_id = $2 AND coin = $3',
        [withdrawal.amount, withdrawal.user_id, withdrawal.coin]
      );
      return res.json({ success: true, balanceReduced: true });
    } else {
      // If not approving, just update status
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
    // Delete from all relevant tables
    await pool.query(`DELETE FROM users WHERE id = $1`, [userId]);
    // Optionally: delete related data (add more queries if needed)
    // await pool.query('DELETE FROM deposits WHERE user_id = $1', [userId]);
    // await pool.query('DELETE FROM withdrawals WHERE user_id = $1', [userId]);
    // await pool.query('DELETE FROM trades WHERE user_id = $1', [userId]);
    res.json({ success: true, message: "User deleted" });
  } catch (err) {
    res.status(500).json({ error: "Failed to delete user" });
  }
});

// mode: 'WIN', 'LOSE', or null to remove override
router.post('/users/:id/trade-mode', async (req, res) => {
  const { id } = req.params;
  const { mode } = req.body; // mode: "WIN", "LOSE", or null
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

// --- (Future) Delete, Block, Unblock User endpoints here ---

module.exports = router;
