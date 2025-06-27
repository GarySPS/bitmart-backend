const express = require('express');
const router = express.Router();
const pool = require('../db');
const multer = require('multer');
const fs = require('fs');
const { authenticateToken } = require('../middleware/auth'); // Adjust path if needed

// Ensure uploads directory exists
if (!fs.existsSync('./uploads')) {
  fs.mkdirSync('./uploads');
}
const storage = multer.diskStorage({
  destination: './uploads/',
  filename: (req, file, cb) => {
    const uniqueName = Date.now() + '-' + file.originalname.replace(/\s/g, "_");
    cb(null, uniqueName);
  }
});
const upload = multer({ storage });

// --------- Submit new KYC (User uploads selfie + id_card) ---------
router.post(
  '/',
  authenticateToken,
  upload.fields([
    { name: 'selfie', maxCount: 1 },
    { name: 'id_card', maxCount: 1 }
  ]),
  async (req, res) => {
    const user_id = req.user.id;
    const selfie = req.files?.selfie ? req.files.selfie[0].filename : null;
    const id_card = req.files?.id_card ? req.files.id_card[0].filename : null;

    if (!selfie || !id_card) {
      return res.status(400).json({ error: 'Missing required files' });
    }
    try {
      await pool.query(
        `UPDATE users
         SET kyc_status = 'pending', kyc_selfie = $1, kyc_id_card = $2
         WHERE id = $3`,
        [selfie, id_card, user_id]
      );
      res.json({ success: true });
    } catch (err) {
      res.status(500).json({ error: 'Database error' });
    }
  }
);

// --------- Get KYC status (user, JWT protected) ---------
router.get('/status', authenticateToken, async (req, res) => {
  const user_id = req.user.id;
  try {
    const { rows } = await pool.query(
      "SELECT kyc_status FROM users WHERE id = $1",
      [user_id]
    );
    if (!rows[0]) return res.json({ status: "unverified" });
    res.json({ status: rows[0].kyc_status || "unverified" });
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
});

// --------- ADMIN: Approve/Reject KYC status ---------
// (Should be POST /admin/kyc-status in admin, but you can keep for quick use)
router.post('/admin/status', async (req, res) => {
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
    res.status(500).json({ error: "Database error" });
  }
});

module.exports = router;
