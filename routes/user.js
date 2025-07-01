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

// POST /api/users/password -- Change current user's password (JWT-protected)
router.post('/password', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const { currentPassword, newPassword } = req.body;

  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: "Missing current or new password" });
  }

  try {
    // Get user's current password from DB
    const { rows } = await pool.query(
      "SELECT password FROM users WHERE id = $1",
      [userId]
    );
    const user = rows[0];
    if (!user) return res.status(404).json({ error: "User not found" });

    // Check if current password matches
    if (user.password !== currentPassword) {
      return res.status(401).json({ error: "Current password is incorrect" });
    }

    // Optional: Prevent same password as before
    if (currentPassword === newPassword) {
      return res.status(400).json({ error: "New password must be different from the current password" });
    }

    // Update password
    await pool.query(
      "UPDATE users SET password = $1 WHERE id = $2",
      [newPassword, userId]
    );

    res.json({ message: "Password changed successfully" });
  } catch (err) {
    console.error("Change password error:", err);
    res.status(500).json({ error: "Failed to change password" });
  }
});


module.exports = router;
