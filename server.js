// server.js
const pool = require('./db');
const express = require('express');
const cors = require('cors');
require('dotenv').config();
const nodemailer = require('nodemailer');
const crypto = require('crypto');
const CoinMarketCap = require('coinmarketcap-api');
const jwt = require('jsonwebtoken');
const adminRoutes = require('./routes/admin');
const tradeRoutes = require('./routes/trade');
const priceRoutes = require('./routes/prices'); 



const app = express();
app.use(cors());
app.use(express.json());
app.use("/uploads", express.static("uploads"));
app.use('/api/admin', adminRoutes);
app.use('/api/trade', tradeRoutes);
app.use('/api/price', priceRoutes); 


const cmc = new CoinMarketCap(process.env.COINMARKETCAP_API_KEY);

const multer = require('multer');
const path = require('path');
const fs = require('fs');

// Ensure uploads directory exists
if (!fs.existsSync('./uploads')) {
  fs.mkdirSync('./uploads');
}

// Multer config
const storage = multer.diskStorage({
  destination: './uploads/',
  filename: (req, file, cb) => {
    const uniqueName = Date.now() + '-' + file.originalname.replace(/\s/g, "_");
    cb(null, uniqueName);
  }
});
const upload = multer({ storage });

// ----------------- JWT Middleware -----------------
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ error: "No token provided" });
  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ error: "Token invalid" });
    req.user = user;
    next();
  });
}


// ----------------- EMAIL TRANSPORTER -----------------
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS,
  },
});

// ----------------- USER & AUTH ROUTES -----------------
// Register API with email duplication check
app.post('/api/register', async (req, res) => {
  const { username = '', email = '', balance = 0, password = '' } = req.body;
  if (!username || !email) {
    return res.status(400).json({ error: 'Missing username or email' });
  }
  try {
    // 1. Check if email exists
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (result.rows.length > 0) {
      return res.status(409).json({ error: 'This email is already registered. Please log in.' });
    }

    // 2. Create OTP and insert user
    const otp = crypto.randomInt(100000, 999999).toString();
    const userInsert = await pool.query(
      `INSERT INTO users (username, email, password, balance, otp, verified, kyc_status)
      VALUES ($1, $2, $3, $4, $5, 0, 'unverified') RETURNING id`,
      [username, email, password, balance, otp]
    );
    const newUserId = userInsert.rows[0].id;

    // 3. Insert supported coins (all with 0 balance)
    const coins = ["USDT", "BTC", "ETH", "SOL", "XRP", "TON"];
    await Promise.all(
      coins.map((coin) => 
        pool.query(
          `INSERT INTO user_balances (user_id, coin, balance) VALUES ($1, $2, 0)`,
          [newUserId, coin]
        )
      )
    );

    // 4. Send email (same logic as before)
    const mailOptions = {
      from: process.env.EMAIL_USER,
      to: email,
      subject: 'NovaChain OTP Verification',
      text: `Hello ${username}, your OTP code is: ${otp}`
    };
    transporter.sendMail(mailOptions, (err, info) => {
      if (err) {
        console.error('❌ OTP email error:', err);
      } else {
        console.log('📧 OTP Email Sent:', info.response);
      }
    });

    res.json({ message: 'User created, OTP sent', userId: newUserId });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Database error' });
  }
});

// User Login API (returns JWT)
app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password)
    return res.status(400).json({ error: "Missing username or password" });

  try {
    // username can be username OR email
    const result = await pool.query(
      "SELECT * FROM users WHERE username = $1 OR email = $1",
      [username]
    );
    if (result.rows.length === 0)
      return res.status(404).json({ error: "User not found" });

    const user = result.rows[0];
    if (user.password && user.password !== password) {
      return res.status(401).json({ error: "Incorrect password" });
    }
    if (user.verified === 0) {
      return res.status(403).json({ error: "Please verify your email with OTP before logging in." });
    }
    // SIGN JWT TOKEN
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
    console.error(err);
    res.status(500).json({ error: "Database error" });
  }
});


// Verify OTP
app.post('/api/verify-otp', async (req, res) => {
  const { email, otp } = req.body;
  if (!email || !otp) {
    return res.status(400).json({ error: 'Missing email or OTP' });
  }

  try {
    const result = await pool.query(
      `SELECT * FROM users WHERE email = $1`,
      [email]
    );

    if (result.rows.length === 0)
      return res.status(404).json({ error: 'User not found' });

    const user = result.rows[0];
    if (user.otp === otp) {
      await pool.query(
        `UPDATE users SET verified = 1 WHERE email = $1`,
        [email]
      );
      res.json({ success: true, message: 'Email verified successfully. You can now log in.' });
    } else {
      res.status(400).json({ error: 'Invalid OTP' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// Get profile (JWT protected)
// Get profile (JWT protected)
app.get('/api/profile', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT id, username, email, balance, avatar, referral FROM users WHERE id = $1",
      [req.user.id]
    );
    const row = result.rows[0];
    if (!row) return res.status(404).json({ error: "User not found" });
    let avatarUrl = row.avatar ? (`/uploads/${row.avatar}`) : "";
    res.json({ user: {
      id: "NC-" + String(row.id).padStart(7, "0"),
      username: row.username,
      email: row.email,
      balance: row.balance,
      avatar: avatarUrl,
      referral: row.referral || ""
    }});
  } catch (err) {
    res.status(500).json({ error: "Database error" });
  }
});

// Get multi-coin balances (JWT protected) - FINAL version
app.get('/api/balance', authenticateToken, async (req, res) => {
  try {
    const { rows } = await pool.query(
      "SELECT coin, balance FROM user_balances WHERE user_id = $1",
      [req.user.id]
    );
    // Show all supported coins, even if 0 balance
    const allCoins = ["USDT", "BTC", "ETH", "SOL", "XRP", "TON"];
    const assets = allCoins.map(symbol => {
      const row = rows.find(r => r.coin === symbol);
      return {
        symbol,
        icon: symbol === "BTC" ? "₿"
              : symbol === "ETH" ? "Ξ"
              : symbol === "SOL" ? "◎"
              : symbol === "XRP" ? "✕"
              : symbol === "TON" ? "🪙"
              : "💵",
        balance: row ? parseFloat(row.balance) : 0
      };
    });
    const total_usd = assets.find(a => a.symbol === "USDT")?.balance || 0;
    res.json({ total_usd, assets });
  } catch (err) {
    res.status(500).json({ error: "Database error" });
  }
});


// Get KYC status (JWT protected)
app.get('/api/kyc/status', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT kyc_status FROM users WHERE id = $1",
      [req.user.id]
    );
    const row = result.rows[0];
    if (!row) return res.json({ status: "unverified" });
    res.json({
      status: row.kyc_status
        ? row.kyc_status.charAt(0).toUpperCase() + row.kyc_status.slice(1)
        : "unverified"
    });
  } catch (err) {
    res.status(500).json({ error: "Database error" });
  }
});


// ----------------- OTHER FUNCTIONAL ROUTES -----------------
app.get('/api/price/:symbol', async (req, res) => {
  try {
    const symbol = req.params.symbol.toUpperCase();
    const response = await cmc.getQuotes({ symbol });
    const quote = response.data[symbol]?.quote?.USD;
    if (!quote) return res.status(404).json({ error: 'Symbol not found' });
    res.json({ symbol, price: quote.price, percent_change_24h: quote.percent_change_24h });
  } catch (err) {
    console.error('CMC Error:', err);
    res.status(500).json({ error: 'Failed to fetch price' });
  }
});

app.get('/api/prices', async (req, res) => {
  try {
    const response = await cmc.getTickers({ limit: 20 });
    res.json({ data: response.data });
  } catch (err) {
    console.error('CMC Prices Error:', err);
    res.status(500).json({ error: 'Failed to fetch prices' });
  }
});

// Test Email Route
app.get('/api/test-email', (req, res) => {
  const mailOptions = {
    from: process.env.EMAIL_USER,
    to: process.env.ADMIN_EMAIL,
    subject: 'Test Email from NovaChain',
    text: 'Hello Admin, this is a test email from your NovaChain backend.'
  };

  transporter.sendMail(mailOptions, (err, info) => {
    if (err) {
      console.error('❌ Email error:', err);
      res.status(500).json({ error: err.message });
    } else {
      console.log('📧 Test Email Sent:', info.response);
      res.json({ message: 'Test email sent', info: info.response });
    }
  });
});


// Trade API
app.post('/api/trade', async (req, res) => {
  const { username, tradeType, amount } = req.body;

  if (!username || !tradeType || !amount) {
    return res.status(400).json({ error: 'Missing trade data' });
  }

  const result = Math.random() < 0.5 ? 'win' : 'loss';
  const profit = result === 'win' ? amount * 0.9 : -amount;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Update balance
    await client.query(
      `UPDATE users SET balance = balance + $1 WHERE username = $2`,
      [profit, username]
    );

    // Insert trade record
    const timestamp = new Date().toISOString();
    const direction = tradeType;
    const duration = 60;
    await client.query(
      `INSERT INTO trades (username, direction, amount, duration, result, timestamp)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [username, direction, amount, duration, result, timestamp]
    );

    await client.query('COMMIT');
    res.json({ message: 'Trade processed', result, profit });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Error saving trade:', err);
    res.status(500).json({ error: 'Trade error' });
  } finally {
    client.release();
  }
});


// Trade History API
app.get('/api/history', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM trades ORDER BY timestamp DESC'
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Failed to fetch trade history' });
  }
});


// Deposit endpoint (with screenshot upload)
app.post('/api/deposit', authenticateToken, upload.single('screenshot'), async (req, res) => {
  const user_id = req.user.id;
  const { coin, amount, address } = req.body;
  const screenshot = req.file ? req.file.filename : "";

  if (!user_id || !coin || !amount || !address) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO deposits (user_id, coin, amount, address, screenshot)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [user_id, coin, amount, address, screenshot]
    );
    res.json({ success: true, id: result.rows[0].id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});


// Withdraw endpoint
app.post('/api/withdraw', async (req, res) => {
  const { user_id, coin, amount, address } = req.body;

  if (!user_id || !coin || !amount || !address) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO withdrawals (user_id, coin, amount, address)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [user_id, coin, amount, address]
    );
    res.json({ success: true, id: result.rows[0].id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Database error' });
  }
});


      //convert
app.post('/api/convert', async (req, res) => {
  const { user_id, from_coin, to_coin, amount, result } = req.body;

  if (!user_id || !from_coin || !to_coin || !amount || !result) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  // Begin transaction
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Check balances
    const { rows } = await client.query(
      `SELECT coin, balance FROM user_balances
       WHERE user_id = $1 AND coin IN ($2, $3)`,
      [user_id, from_coin, to_coin]
    );
    const fromBalance = rows.find(r => r.coin === from_coin);
    const toBalance = rows.find(r => r.coin === to_coin);

    if (!fromBalance || parseFloat(fromBalance.balance) < parseFloat(amount)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: "Insufficient balance" });
    }

    // 2. Deduct from source coin
    await client.query(
      `UPDATE user_balances
       SET balance = balance - $1
       WHERE user_id = $2 AND coin = $3`,
      [amount, user_id, from_coin]
    );

    // 3. Add to target coin (update or insert)
    if (toBalance) {
      await client.query(
        `UPDATE user_balances
         SET balance = balance + $1
         WHERE user_id = $2 AND coin = $3`,
        [result, user_id, to_coin]
      );
    } else {
      await client.query(
        `INSERT INTO user_balances (user_id, coin, balance)
         VALUES ($1, $2, $3)`,
        [user_id, to_coin, result]
      );
    }

    // 4. Insert conversion record
    await client.query(
      `INSERT INTO conversions (user_id, from_coin, to_coin, amount, result)
       VALUES ($1, $2, $3, $4, $5)`,
      [user_id, from_coin, to_coin, amount, result]
    );

    await client.query('COMMIT');
    res.json({ success: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(err);
    res.status(500).json({ error: "Database error" });
  } finally {
    client.release();
  }
});


// Avatar Upload endpoint
app.post('/api/profile/avatar', authenticateToken, upload.single('avatar'), async (req, res) => {
  const user_id = req.user.id;
  if (!req.file) return res.status(400).json({ error: "No avatar uploaded" });
  const avatarUrl = req.file.filename;
  try {
    await pool.query(
      `UPDATE users SET avatar = $1 WHERE id = $2`,
      [avatarUrl, user_id]
    );
    res.json({ success: true, avatar: avatarUrl });
  } catch (err) {
    res.status(500).json({ error: "DB error" });
  }
});

app.get('/debug/all-deposits', async (req, res) => {
  try {
    const result = await pool.query("SELECT * FROM deposits ORDER BY id DESC");
    res.json(result.rows);
  } catch (err) {
    res.json({ error: err.message });
  }
});


// Get all deposits
app.get('/api/deposits', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM deposits ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
});


// Get all withdrawals
app.get('/api/withdrawals', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM withdrawals ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
});


// Get all conversions
app.get('/api/conversions', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM conversions ORDER BY created_at DESC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: 'Database error' });
  }
});


// User submits KYC (Easy Mode)
app.post('/api/kyc', authenticateToken, upload.fields([
  { name: 'selfie', maxCount: 1 },
  { name: 'id_card', maxCount: 1 }
]), async (req, res) => {
  const user_id = req.user.id;
  const selfie = req.files?.selfie ? req.files.selfie[0].filename : null;
  const id_card = req.files?.id_card ? req.files.id_card[0].filename : null;
  if (!selfie || !id_card) {
    return res.status(400).json({ error: 'Missing required files' });
  }
  try {
    await pool.query(
      `UPDATE users SET kyc_status = 'pending', kyc_selfie = $1, kyc_id_card = $2 WHERE id = $3`,
      [selfie, id_card, user_id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'DB error' });
  }
});


// Get KYC status
app.get('/api/kyc/status', authenticateToken, async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT kyc_status FROM users WHERE id = $1",
      [req.user.id]
    );
    const row = result.rows[0];
    if (!row) return res.json({ status: "unverified" });
    res.json({ status: row.kyc_status ? row.kyc_status.charAt(0).toUpperCase() + row.kyc_status.slice(1) : "unverified" });
  } catch (err) {
    res.status(500).json({ error: "DB error" });
  }
});


// Change password endpoint
app.post('/api/profile/password', authenticateToken, async (req, res) => {
  const user_id = req.user.id;
  const { newPassword } = req.body;
  if (!newPassword) return res.status(400).json({ error: "Missing new password" });
  try {
    await pool.query(
      `UPDATE users SET password = $1 WHERE id = $2`,
      [newPassword, user_id]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "DB error" });
  }
});

// Test Supabase DB connection
app.get('/api/test-db', async (req, res) => {
  try {
    const result = await pool.query('SELECT NOW()');
    res.json({ time: result.rows[0].now });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// Start server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
