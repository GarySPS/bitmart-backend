// routes/profile.js
const express = require('express');
const router = express.Router();
const pool = require('../db');
const { authenticateToken } = require('../middleware/auth');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcrypt');

// Ensure uploads dir exists
if (!fs.existsSync('./uploads')) fs.mkdirSync('./uploads');

const storage = multer.diskStorage({
  destination: './uploads/',
  filename: (req, file, cb) => {
    const uniqueName = Date.now() + '-' + file.originalname.replace(/\s/g, "_");
    cb(null, uniqueName);
  }
});
const upload = multer({ storage });

// -------- GET /api/profile (JWT-protected) --------
router.get('/', authenticateToken, async (req, res) => {
  try {
    // 1. Get user info
    const result = await pool.query(
      "SELECT id, username, email, avatar, referral FROM users WHERE id = $1",
      [req.user.id]
    );
    const row = result.rows[0];
    if (!row) return res.status(404).json({ error: "User not found" });

    // 2. Get user balance (sum all coins)
    const balanceRes = await pool.query(
      "SELECT SUM(balance) as total_usd FROM user_balances WHERE user_id = $1",
      [req.user.id]
    );
    const total_usd = Number(balanceRes.rows[0].total_usd) || 0;

    let avatarUrl = row.avatar ? (`/uploads/${row.avatar}`) : "";
    res.json({
      user: {
        id: "NC-" + String(row.id).padStart(7, "0"),
        username: row.username,
        email: row.email,
        balance: total_usd,
        avatar: avatarUrl,
        referral: row.referral || ""
      }
    });
  } catch (err) {
    console.error("❌ /api/profile error:", err);
    res.status(500).json({ error: "Database error" });
  }
});

// -------- POST /api/profile/avatar (update avatar) --------
router.post('/avatar', authenticateToken, upload.single('avatar'), async (req, res) => {
  const userId = req.user.id;
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });
  const filename = req.file.filename;

  try {
    await pool.query(
      "UPDATE users SET avatar = $1 WHERE id = $2",
      [filename, userId]
    );
    res.json({ success: true, avatar: `/uploads/${filename}` });
  } catch (err) {
    res.status(500).json({ error: "Failed to update avatar" });
  }
});

// -------- POST /api/profile/change-password --------
router.post('/change-password', authenticateToken, async (req, res) => {
  const userId = req.user.id;
  const { old_password, new_password } = req.body;
  if (!old_password || !new_password) {
    return res.status(400).json({ error: "Missing old or new password" });
  }
  try {
    // Get stored password hash or value
    const { rows } = await pool.query("SELECT password FROM users WHERE id = $1", [userId]);
    const stored = rows[0]?.password;
    if (!stored) {
      return res.status(400).json({ error: "Incorrect old password" });
    }

    // If already hashed, compare with bcrypt. Otherwise, compare plaintext for legacy support.
    let match = false;
    if (stored.startsWith("$2")) {
      match = await bcrypt.compare(old_password, stored);
    } else {
      match = (old_password === stored);
    }

    if (!match) {
      return res.status(400).json({ error: "Incorrect old password" });
    }

    // Hash the new password before saving
    const newHash = await bcrypt.hash(new_password, 10);
    await pool.query("UPDATE users SET password = $1 WHERE id = $2", [newHash, userId]);
    res.json({ success: true, message: "Password changed successfully" });
  } catch (err) {
    res.status(500).json({ error: "Failed to change password" });
  }
});  // <--- You missed this bracket!

module.exports = router;

