const express = require('express');
const router = express.Router();
const pool = require('../db');

// GET /api/user/balance/:id
router.get('/balance/:id', async (req, res) => {
  const userId = req.params.id;
  const sql = `SELECT coin, balance FROM user_balances WHERE user_id = $1`;
  try {
    const result = await pool.query(sql, [userId]);
    res.json(result.rows);
  } catch (err) {
    console.error("DB error:", err);
    res.status(500).json({ error: 'Database error' });
  }
});

module.exports = router;
