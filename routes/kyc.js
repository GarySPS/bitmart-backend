const express = require('express');
const router = express.Router();
const pool = require('../db');
const multer = require('multer');
const { authenticateToken } = require('../middleware/auth'); // Adjust path if needed
const supabase = require('../utils/supabaseClient');


// Multer in-memory storage (not disk)
const upload = multer({ storage: multer.memoryStorage() });

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
    const selfieFile = req.files?.selfie ? req.files.selfie[0] : null;
    const idCardFile = req.files?.id_card ? req.files.id_card[0] : null;

    if (!selfieFile || !idCardFile) {
      return res.status(400).json({ error: 'Missing required files' });
    }
    try {
      // Unique filenames for KYC files
      const selfieFilename = `${user_id}-selfie-${Date.now()}-${selfieFile.originalname.replace(/\s/g, "_")}`;
      const idCardFilename = `${user_id}-idcard-${Date.now()}-${idCardFile.originalname.replace(/\s/g, "_")}`;

      // Upload selfie to Supabase
      const { error: selfieError } = await supabase.storage.from('kyc').upload(selfieFilename, selfieFile.buffer, {
        contentType: selfieFile.mimetype,
        upsert: true,
      });
      // Upload id_card to Supabase
      const { error: idCardError } = await supabase.storage.from('kyc').upload(idCardFilename, idCardFile.buffer, {
        contentType: idCardFile.mimetype,
        upsert: true,
      });
      if (selfieError || idCardError) {
        return res.status(500).json({ error: selfieError?.message || idCardError?.message });
      }

      // Get public URLs
      const { data: selfieUrlObj } = supabase.storage.from('kyc').getPublicUrl(selfieFilename);
      const { data: idCardUrlObj } = supabase.storage.from('kyc').getPublicUrl(idCardFilename);

      // Save public URLs to DB
      await pool.query(
        `UPDATE users
         SET kyc_status = 'pending', kyc_selfie = $1, kyc_id_card = $2
         WHERE id = $3`,
        [selfieUrlObj.publicUrl, idCardUrlObj.publicUrl, user_id]
      );
      res.json({ success: true, selfieUrl: selfieUrlObj.publicUrl, idCardUrl: idCardUrlObj.publicUrl });
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
