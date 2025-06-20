// routes/auth.js
const express = require('express');
const router = express.Router();
const pool = require('../db');
const nodemailer = require('nodemailer');
const crypto = require('crypto');

// Email transporter
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

// Register
router.post('/register', async (req, res) => {
  const { username, email, password } = req.body;
  if (!username || !email || !password) {
    return res.status(400).json({ error: 'Missing username, email or password' });
  }

  try {
    // Check for existing user
    const { rows: existing } = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (existing.length > 0) return res.status(400).json({ message: 'Email already registered' });

    // OTP
    const otp = crypto.randomInt(100000, 999999).toString();
    const result = await pool.query(
      'INSERT INTO users (username, email, password, balance, otp, verified) VALUES ($1, $2, $3, $4, $5, 0) RETURNING id',
      [username, email, password, 0, otp]
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

    res.status(201).json({ message: 'User registered! OTP sent.', userId: result.rows[0].id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Login
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    const user = rows[0];
    if (!user || user.password !== password) {
      return res.status(400).json({ message: 'Invalid email or password' });
    }
    res.json({
      user: {
        id: user.id,
        username: user.username,
        email: user.email
      }
    });
  } catch (err) {
    res.status(500).json({ message: 'Database error' });
  }
});

// OTP Verification
router.post('/verify-otp', async (req, res) => {
  const { email, otp } = req.body;
  try {
    const { rows } = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    const user = rows[0];
    if (!user) return res.status(404).json({ error: 'User not found' });
    if (user.otp === otp) {
      await pool.query('UPDATE users SET verified = 1 WHERE email = $1', [email]);
      res.json({ message: 'Email verified successfully' });
    } else {
      res.status(400).json({ error: 'Invalid OTP' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
