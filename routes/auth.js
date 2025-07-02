const bcrypt = require('bcrypt');
const { authenticateToken } = require('../middleware/auth');
const express = require('express');
const router = express.Router();
const pool = require('../db');
const nodemailer = require('nodemailer');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');

// Email transporter
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

// Register (with duplicate email check and pre-setup for balances)
router.post('/register', async (req, res) => {
  const { username, email, password } = req.body;
  if (!username || !email || !password) {
    return res.status(400).json({ error: 'Missing username, email or password' });
  }
  try {
    const { rows: existing } = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (existing.length > 0) return res.status(409).json({ error: 'This email is already registered. Please log in.' });

    const hashedPassword = await bcrypt.hash(password, 10); // <--- secure hash!
    const otp = crypto.randomInt(100000, 999999).toString();
    const result = await pool.query(
      'INSERT INTO users (username, email, password, balance, otp, verified) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
      [username, email, hashedPassword, 0, otp, false]
    );
    const userId = result.rows[0].id;

    // Insert balances for all coins (multi-coin support)
    const coins = ["USDT", "BTC", "ETH", "SOL", "XRP", "TON"];
    await Promise.all(
      coins.map((coin) => 
        pool.query(
          `INSERT INTO user_balances (user_id, coin, balance) VALUES ($1, $2, 0)`,
          [userId, coin]
        )
      )
    );

    // Send OTP Email
    const mailOptions = {
      from: process.env.EMAIL_USER,
      to: email,
      subject: 'NovaChain OTP Verification',
      text: `Hello ${username}, your OTP code is: ${otp}`
    };
    transporter.sendMail(mailOptions, (err) => {
      if (err) console.error('❌ OTP email error:', err);
    });

    res.status(201).json({ message: 'User registered! OTP sent.', userId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// Login (returns JWT, supports email or username)
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const { rows } = await pool.query(
      `SELECT * FROM users WHERE LOWER(email) = LOWER($1) OR LOWER(username) = LOWER($1)`,
      [email]
    );
    const user = rows[0];
    if (!user) {
      return res.status(400).json({ error: 'Invalid email or password' });
    }

    let match = false;
    if (user.password.startsWith("$2b$")) {
      // bcrypt hash
      match = await bcrypt.compare(password, user.password);
    } else {
      // plain text fallback for legacy users
      match = (password === user.password);
    }
    if (!match) {
      return res.status(400).json({ error: 'Invalid email or password' });
    }

    if (user.verified === false || user.verified === 0) {
      return res.status(403).json({ error: "Please verify your email with OTP before logging in." });
    }
    // Create JWT token
    const payload = { id: user.id, username: user.username, email: user.email };
    const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '7d' });
    res.json({
      token,
      user: {
        id: "NC-" + String(user.id).padStart(7, "0"),
        username: user.username,
        email: user.email
      }
    });
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
});




// OTP Verification (POSTGRES BOOLEAN SAFE)
router.post('/verify-otp', async (req, res) => {
  const { email, otp } = req.body;
  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    const user = rows[0];
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.otp === otp) {
      await pool.query('UPDATE users SET verified = TRUE WHERE email = $1', [email]);
      res.json({ message: 'Email verified successfully' });
    } else {
      res.status(400).json({ error: 'Invalid OTP' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


module.exports = router;
