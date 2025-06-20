// routes/kyc.js
const express = require('express');
const router = express.Router();
const pool = require('../db');

// Submit new KYC request
router.post('/', async (req, res) => {
  const { user_id, selfie, id_card } = req.body;
  if (!user_id || !selfie || !id_card) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  try {
    const result = await pool.query(
      `INSERT INTO kyc_requests (user_id, selfie, id_card)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [user_id, selfie, id_card]
    );
    res.json({ success: true, id: result.rows[0].id });
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
});

// Get all KYC requests (admin review)
router.get('/', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM kyc_requests ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
});

// Approve/Reject KYC (admin control)
router.post('/:id/status', async (req, res) => {
  const { status } = req.body;
  const { id } = req.params;
  if (!["approved", "rejected", "pending"].includes(status)) {
    return res.status(400).json({ error: "Invalid status" });
  }
  try {
    await pool.query('UPDATE kyc_requests SET status = $1 WHERE id = $2', [status, id]);
    // Optional: also update user table if needed
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
});

// GET current user's KYC status (require user_id from token/session)
router.get('/status', async (req, res) => {
  // If you use JWT, get user id from req.user or req.auth
  const user_id = req.user ? req.user.id : req.query.user_id; // fallback for demo/testing
  if (!user_id) return res.status(401).json({ error: "Unauthorized" });

  try {
    const result = await pool.query(
      `SELECT status FROM kyc_requests WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [user_id]
    );
    if (result.rows.length === 0) return res.json({ status: "unverified" });
    res.json({ status: result.rows[0].status });
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
});

module.exports = router;
