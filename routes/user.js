// routes/user.js
const express = require('express');
const router = express.Router();
const pool = require('../db');
const { authenticateToken } = require('../middleware/auth');

// GET /api/users -- List all users
router.get('/', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT id, username, email, verified, kyc_status FROM users ORDER BY id DESC'
    );
    res.json(result.rows);
  } catch (err) {
    console.error("DB error:", err);
    res.status(500).json({ error: "Database error" });
  }
});

// GET /api/users/balance -- Get current user's balances (JWT-protected)
router.get('/balance', authenticateToken, async (req, res) => {
  try {
    const userId = req.user.id;
    const result = await pool.query(
      "SELECT coin, balance FROM user_balances WHERE user_id = $1",
      [userId]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("DB error:", err);
    res.status(500).json({ error: "Database error" });
  }
});

module.exports = router;
