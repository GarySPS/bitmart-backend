const express = require('express');
const router = express.Router();
const pool = require('../db');
const { authenticateToken } = require('../middleware/auth');
const bcrypt = require('bcrypt');

// SUPABASE STORAGE + MULTER MEMORY
const supabase = require('../utils/supabase');
const multer = require('multer');
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 2 * 1024 * 1024 },
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

    // Get avatar URL from Supabase (if avatar exists)
    let avatarUrl = "";
    if (row.avatar) {
      const { data } = supabase.storage.from('avatars').getPublicUrl(row.avatar);
      avatarUrl = data?.publicUrl || "";
    }

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

// -------- POST /api/profile/avatar (SUPABASE STORAGE) --------
router.post('/avatar', authenticateToken, upload.single('avatar'), async (req, res) => {
  const userId = req.user.id;
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });

  const ext = (req.file.originalname.split('.').pop() || 'jpg').toLowerCase();
  const filename = `${userId}_${Date.now()}.${ext}`;

  try {
    // Upload to Supabase Storage bucket 'avatars'
    const { error: uploadError } = await supabase.storage
      .from('avatars')
      .upload(filename, req.file.buffer, {
        contentType: req.file.mimetype,
        upsert: true
      });
    if (uploadError) throw uploadError;

    // Get public URL
    const { data } = supabase.storage.from('avatars').getPublicUrl(filename);
    const publicUrl = data?.publicUrl || "";

    // Save filename to users.avatar
    await pool.query(
      "UPDATE users SET avatar = $1 WHERE id = $2",
      [filename, userId]
    );

    res.json({ success: true, avatar: publicUrl });
  } catch (err) {
    res.status(500).json({ error: err.message || "Failed to upload avatar" });
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
