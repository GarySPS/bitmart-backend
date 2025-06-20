const express = require('express');
const router = express.Router();
const pool = require('../db');

// User requests withdrawal
router.post('/', async (req, res) => {
  const { user_id, coin, amount, address } = req.body;
  if (!user_id || !coin || !amount || !address) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    // Optional: Check user balance for the given coin
    const { rows } = await pool.query(
      'SELECT balance FROM user_balances WHERE user_id = $1 AND coin = $2',
      [user_id, coin]
    );
    const userBal = rows[0];
    if (!userBal) return res.status(400).json({ error: "Balance record not found" });
    if (parseFloat(userBal.balance) < parseFloat(amount)) {
      return res.status(400).json({ error: "Insufficient balance" });
    }

    // Create withdrawal request (status = pending)
    const result = await pool.query(
      `INSERT INTO withdrawals (user_id, coin, amount, address)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [user_id, coin, amount, address]
    );

    // Optional: Deduct from balance immediately, or only on admin approval
    // For now, DO NOT deduct until admin approves. If you want to deduct immediately, uncomment below:
    // await pool.query(
    //   'UPDATE user_balances SET balance = balance - $1 WHERE user_id = $2 AND coin = $3',
    //   [amount, user_id, coin]
    // );

    res.json({ success: true, id: result.rows[0].id });
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
});

// Get all withdrawals (for admin or user history)
router.get('/', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM withdrawals ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
});

// Approve/Reject Withdrawal (admin control)
router.post('/:id/status', async (req, res) => {
  const { status } = req.body;
  const { id } = req.params;
  if (!["approved", "rejected", "pending"].includes(status)) {
    return res.status(400).json({ error: "Invalid status" });
  }
  try {
    await pool.query('UPDATE withdrawals SET status = $1 WHERE id = $2', [status, id]);

    // (Optional: If rejected, refund the amount)
    if (status === "rejected") {
      const { rows } = await pool.query('SELECT * FROM withdrawals WHERE id = $1', [id]);
      const withdrawal = rows[0];
      if (withdrawal) {
        await pool.query(
          'UPDATE user_balances SET balance = balance + $1 WHERE user_id = $2 AND coin = $3',
          [withdrawal.amount, withdrawal.user_id, withdrawal.coin]
        );
      }
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Database error" });
  }
});

module.exports = router;
