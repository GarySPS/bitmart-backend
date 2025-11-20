// routes/withdrawals.js

require('dotenv').config();
const express = require('express');
const router = express.Router();
const pool = require('../db');
const { authenticateToken } = require('../middleware/auth');
const jwt = require('jsonwebtoken');

const ADMIN_API_TOKEN = process.env.ADMIN_API_TOKEN || 'yourSecureAdminTokenHere1234';

// --- 1. User requests withdrawal (FIXED) ---
router.post('/', authenticateToken, async (req, res) => {
  try {
    // Debug log to see exactly what the frontend is sending
    console.log("💰 Processing Withdrawal:", req.body);

    // Safely get User ID (checks both common formats)
    const user_id = req.user.id || req.user.user_id;
    if (!user_id) {
      console.error("❌ Error: User ID missing from token");
      return res.status(401).json({ error: 'User identification failed' });
    }

    const { coin, amount, address, network } = req.body;

    // Validation
    if (!coin || !amount || !address) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    // Check Balance
    const { rows } = await pool.query(
      'SELECT balance FROM user_balances WHERE user_id = $1 AND coin = $2',
      [user_id, coin]
    );
    
    const userBal = rows[0];
    if (!userBal) return res.status(400).json({ error: "Balance record not found" });
    
    if (parseFloat(userBal.balance) < parseFloat(amount)) {
      return res.status(400).json({ error: "Insufficient balance" });
    }

    // CRITICAL FIX: Handle undefined network
    // If 'network' is undefined, we use NULL to prevent database crash
    const safeNetwork = network || null; 

    // Insert into Database
    const result = await pool.query(
      `INSERT INTO withdrawals (user_id, coin, amount, address, status, network)
       VALUES ($1, $2, $3, $4, 'pending', $5)
       RETURNING id`,
      [user_id, coin, amount, address, safeNetwork]
    );

    console.log("✅ Withdrawal Saved! ID:", result.rows[0].id);
    res.json({ success: true, id: result.rows[0].id });

  } catch (err) {
    console.error("❌ DATABASE CRASH:", err);
    res.status(500).json({ error: 'Database error. Check server console.' });
  }
});

// --- 2. Get withdrawals (User & Admin) ---
router.get('/', async (req, res) => {
  // --- Admin view ---
  if (req.headers['x-admin-token'] && req.headers['x-admin-token'] === ADMIN_API_TOKEN) {
    try {
      const result = await pool.query(
        'SELECT * FROM withdrawals ORDER BY created_at DESC'
      );
      return res.json(result.rows);
    } catch (err) {
      return res.status(500).json({ error: 'Database error (admin)' });
    }
  }

  // --- User view ---
  try {
    if (!req.headers.authorization) {
      return res.status(401).json({ error: 'No token' });
    }
    let user_id = null;
    try {
      const token = req.headers.authorization.split(' ')[1];
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      user_id = decoded.id || decoded.user_id;
    } catch (e) {
      return res.status(401).json({ error: "User not authenticated" });
    }
    if (!user_id) return res.status(401).json({ error: "User not authenticated" });

    const result = await pool.query(
      'SELECT * FROM withdrawals WHERE user_id = $1 ORDER BY created_at DESC',
      [user_id]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Database error (user)' });
  }
});

// --- 3. Approve/Reject withdrawal (Admin) ---
router.post('/:id/status', async (req, res) => {
  const { status } = req.body;
  const { id } = req.params;
  
  if (!["approved", "rejected", "pending"].includes(status)) {
    return res.status(400).json({ error: "Invalid status" });
  }

  try {
    const { rows } = await pool.query('SELECT * FROM withdrawals WHERE id = $1', [id]);
    const withdrawal = rows[0];
    if (!withdrawal) return res.status(404).json({ error: "Withdrawal not found" });

    // Only deduct if approving and not already approved
    if (status === "approved" && withdrawal.status !== "approved") {
      const { rows: balRows } = await pool.query(
        'SELECT balance FROM user_balances WHERE user_id = $1 AND coin = $2',
        [withdrawal.user_id, withdrawal.coin]
      );
      const userBal = balRows[0];
      
      // Extra safety check
      if (!userBal) return res.status(500).json({ error: "User balance not found" });
      if (parseFloat(userBal.balance) < parseFloat(withdrawal.amount)) {
        return res.status(400).json({ error: "Insufficient balance" });
      }

      // Deduct Balance
      await pool.query(
        'UPDATE user_balances SET balance = balance - $1 WHERE user_id = $2 AND coin = $3',
        [withdrawal.amount, withdrawal.user_id, withdrawal.coin]
      );

      // Insert balance history
      const { rows: balRows2 } = await pool.query(
        'SELECT balance FROM user_balances WHERE user_id = $1 AND coin = $2',
        [withdrawal.user_id, withdrawal.coin]
      );
      const newBalance = balRows2[0] ? parseFloat(balRows2[0].balance) : 0;
      let price_usd = 1;
      if (withdrawal.coin !== "USDT") price_usd = 0; 

      await pool.query(
        `INSERT INTO balance_history (user_id, coin, balance, price_usd, timestamp)
         VALUES ($1, $2, $3, $4, NOW())`,
        [withdrawal.user_id, withdrawal.coin, newBalance, price_usd]
      );
    }

    // Refund if rejected after approval
    if (status === "rejected" && withdrawal.status === "approved") {
      await pool.query(
        'UPDATE user_balances SET balance = balance + $1 WHERE user_id = $2 AND coin = $3',
        [withdrawal.amount, withdrawal.user_id, withdrawal.coin]
      );
    }

    await pool.query('UPDATE withdrawals SET status = $1 WHERE id = $2', [status, id]);
    res.json({ success: true });
  } catch (err) {
    console.error("Admin Status Update Error:", err);
    res.status(500).json({ error: "Database error" });
  }
});

module.exports = router;