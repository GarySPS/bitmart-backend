const express = require('express');
const router = express.Router();
const pool = require('../db');
const { authenticateToken } = require('../middleware/auth');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcrypt');

// Ensure uploads dir exists
const UPLOADS_DIR = path.join(__dirname, '../uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR);

// Multer storage, limits and file type filter
const storage = multer.diskStorage({
  destination: UPLOADS_DIR,
  filename: (req, file, cb) => {
    const uniqueName = Date.now() + '-' + file.originalname.replace(/\s/g, "_");
    cb(null, uniqueName);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 2 * 1024 * 1024 }, // 2MB
  fileFilter: (req, file, cb) => {
    if (!file.mimetype.startsWith("image/")) {
      return cb(new Error("Only image files are allowed!"));
    }
    cb(null, true);
  }
});

// -------- GET /api/profile (JWT-protected) --------
router.get('/', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT id, username, email, avatar, referral FROM users WHERE id = $1",
      [req.user.id]
    );
    const row = result.rows[0];
    if (!row) return res.status(404).json({ error: "User not found" });

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
    // Fetch current avatar filename
    const { rows } = await pool.query("SELECT avatar FROM users WHERE id = $1", [userId]);
    const oldAvatar = rows[0]?.avatar;

    // Update DB
    await pool.query(
      "UPDATE users SET avatar = $1 WHERE id = $2",
      [filename, userId]
    );

    // Delete old avatar from disk if exists, not default, and not current
    if (
      oldAvatar &&
      oldAvatar !== filename &&
      fs.existsSync(path.join(UPLOADS_DIR, oldAvatar)) &&
      !["logo192.png", "logo192_new.png"].includes(oldAvatar)
    ) {
      fs.unlink(path.join(UPLOADS_DIR, oldAvatar), err => {
        if (err) console.warn("⚠️ Failed to delete old avatar:", err);
      });
    }

    res.json({ success: true, avatar: `/uploads/${filename}` });
  } catch (err) {
    // If multer threw error (fileFilter, fileSize), send nice message
    if (err instanceof multer.MulterError || err.message) {
      return res.status(400).json({ error: err.message || "Upload failed" });
    }
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
    const { rows } = await pool.query("SELECT password FROM users WHERE id = $1", [userId]);
    const stored = rows[0]?.password;
    if (!stored) {
      return res.status(400).json({ error: "Incorrect old password" });
    }

    let match = false;
    if (stored.startsWith("$2")) {
      match = await bcrypt.compare(old_password, stored);
    } else {
      match = (old_password === stored);
    }

    if (!match) {
      return res.status(400).json({ error: "Incorrect old password" });
    }

    const newHash = await bcrypt.hash(new_password, 10);
    await pool.query("UPDATE users SET password = $1 WHERE id = $2", [newHash, userId]);
    res.json({ success: true, message: "Password changed successfully" });
  } catch (err) {
    res.status(500).json({ error: "Failed to change password" });
  }
});

module.exports = router;
