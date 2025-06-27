const { authenticateToken } = require('../middleware/auth');
const express = require('express');
const router = express.Router();
const pool = require('../db');

// User requests withdrawal (status = pending)
router.post('/', authenticateToken, async (req, res) => {
  const user_id = req.user.id;
  const { coin, amount, address } = req.body;
  if (!user_id || !coin || !amount || !address) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    // Check user balance
    const { rows } = await pool.query(
      'SELECT balance FROM user_balances WHERE user_id = $1 AND coin = $2',
      [user_id, coin]
    );
    const userBal = rows[0];
    if (!userBal) return res.status(400).json({ error: "Balance record not found" });
    if (parseFloat(userBal.balance) < parseFloat(amount)) {
      return res.status(400).json({ error: "Insufficient balance" });
    }

    // Create pending withdrawal
    const result = await pool.query(
      `INSERT INTO withdrawals (user_id, coin, amount, address, status)
       VALUES ($1, $2, $3, $4, 'pending')
       RETURNING id`,
      [user_id, coin, amount, address]
    );

    res.json({ success: true, id: result.rows[0].id });
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
});

// Get all withdrawals (user view, JWT required)
router.get('/', authenticateToken, async (req, res) => {
  try {
    const user_id = req.user.id;
    const result = await pool.query(
      'SELECT * FROM withdrawals WHERE user_id = $1 ORDER BY created_at DESC',
      [user_id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
});

// Approve/Reject withdrawal (admin)
router.post('/:id/status', async (req, res) => {
  const { status } = req.body;
  const { id } = req.params;
  if (!["approved", "rejected", "pending"].includes(status)) {
    return res.status(400).json({ error: "Invalid status" });
  }
  try {
    // Find the withdrawal request
    const { rows } = await pool.query('SELECT * FROM withdrawals WHERE id = $1', [id]);
    const withdrawal = rows[0];
    if (!withdrawal) return res.status(404).json({ error: "Withdrawal not found" });

    // Only deduct if approving and not already approved
    if (status === "approved" && withdrawal.status !== "approved") {
      // Double check balance again (safe)
      const { rows: balRows } = await pool.query(
        'SELECT balance FROM user_balances WHERE user_id = $1 AND coin = $2',
        [withdrawal.user_id, withdrawal.coin]
      );
      const userBal = balRows[0];
      if (!userBal) return res.status(500).json({ error: "User balance not found" });
      if (parseFloat(userBal.balance) < parseFloat(withdrawal.amount)) {
        return res.status(400).json({ error: "Insufficient balance" });
      }
      // Deduct now
      await pool.query(
        'UPDATE user_balances SET balance = balance - $1 WHERE user_id = $2 AND coin = $3',
        [withdrawal.amount, withdrawal.user_id, withdrawal.coin]
      );

      // ---- Insert balance history after deduction ----
      const { rows: balRows2 } = await pool.query(
        'SELECT balance FROM user_balances WHERE user_id = $1 AND coin = $2',
        [withdrawal.user_id, withdrawal.coin]
      );
      const newBalance = balRows2[0] ? parseFloat(balRows2[0].balance) : 0;
      let price_usd = 1;
      if (withdrawal.coin !== "USDT") price_usd = 0; // Replace with real price logic if available

      await pool.query(
        `INSERT INTO balance_history (user_id, coin, balance, price_usd, timestamp)
         VALUES ($1, $2, $3, $4, NOW())`,
        [withdrawal.user_id, withdrawal.coin, newBalance, price_usd]
      );
      // ---- End balance history insert ----
    }
    // If rejected, refund if necessary
    if (status === "rejected" && withdrawal.status === "approved") {
      // If previously approved, add back (rare, just for safety)
      await pool.query(
        'UPDATE user_balances SET balance = balance + $1 WHERE user_id = $2 AND coin = $3',
        [withdrawal.amount, withdrawal.user_id, withdrawal.coin]
      );
    }

    await pool.query('UPDATE withdrawals SET status = $1 WHERE id = $2', [status, id]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Database error" });
  }
});

module.exports = router;
