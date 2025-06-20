// routes/deposit.js
const express = require('express');
const router = express.Router();
const pool = require('../db');

// ✅ Create new deposit request
router.post('/', async (req, res) => {
  const { user_id, coin, amount, address, screenshot } = req.body;
  if (!user_id || !coin || !amount || !address) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO deposits (user_id, coin, amount, address, screenshot)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id`,
      [user_id, coin, amount, address, screenshot || ""]
    );
    res.json({ success: true, id: result.rows[0].id });
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
});

// ✅ Get all deposits (for admin or user)
router.get('/', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM deposits ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
});

// ✅ Admin approves/rejects deposit
router.post('/:id/status', async (req, res) => {
  const { status } = req.body;
  const { id } = req.params;

  if (!["approved", "rejected", "pending"].includes(status)) {
    return res.status(400).json({ error: "Invalid status" });
  }

  try {
    // 1. Find the deposit
    const { rows } = await pool.query('SELECT * FROM deposits WHERE id = $1', [id]);
    const deposit = rows[0];
    if (!deposit) return res.status(404).json({ error: "Deposit not found" });

    // 2. Update status
    await pool.query('UPDATE deposits SET status = $1 WHERE id = $2', [status, id]);

    if (status === "approved") {
      // ✅ Add to user_balances table
      const { user_id, coin, amount } = deposit;
      await pool.query(
        `
        INSERT INTO user_balances (user_id, coin, balance)
        VALUES ($1, $2, $3)
        ON CONFLICT (user_id, coin) DO UPDATE
        SET balance = user_balances.balance + EXCLUDED.balance
        `,
        [user_id, coin, amount]
      );
      return res.json({ success: true, balanceAdded: true });
    } else {
      return res.json({ success: true, balanceAdded: false });
    }
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
});

module.exports = router;
