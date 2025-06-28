require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const multer = require('multer');
const path = require('path');
const pool = require('./db');

// JWT Middleware
const { authenticateToken } = require('./middleware/auth');

// ROUTES
const authRoutes = require('./routes/auth');
const adminRoutes = require('./routes/admin');
const tradeRoutes = require('./routes/trade');
const pricesRoutes = require('./routes/prices');      
const depositRoutes = require('./routes/deposit');
const withdrawalRoutes = require('./routes/withdrawal');
const kycRoutes = require('./routes/kyc');
const profileRoutes = require('./routes/profile');    
const balanceRoutes = require('./routes/balance');
const convertRoutes = require('./routes/convert');
const balanceHistoryRoutes = require('./routes/balanceHistory');

const app = express();

const allowedOrigins = [
  'https://novachain-frontend.vercel.app', // old Vercel preview (optional, can remove later)
  'http://localhost:3000',                 // for local dev
  'https://novachain.pro',                 // your main domain
  'https://www.novachain.pro'              // www version
];


app.use(cors({
  origin: allowedOrigins,
  credentials: true,
}));

app.use(express.json());
app.use('/api/balance/history', balanceHistoryRoutes);
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));


// --- Multer upload config ---
if (!fs.existsSync('./uploads')) fs.mkdirSync('./uploads');
const storage = multer.diskStorage({
  destination: './uploads/',
  filename: (req, file, cb) => {
    const uniqueName = Date.now() + '-' + file.originalname.replace(/\s/g, "_");
    cb(null, uniqueName);
  }
});
const upload = multer({ storage });

// --------- ROUTE MOUNTING ---------
app.use('/api/auth', authRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/trade', tradeRoutes);
app.use('/api/prices', pricesRoutes);          // GET /api/prices        (top 20 coins)
app.use('/api/price', pricesRoutes);           // GET /api/price/:symbol (single coin)
app.use('/api/deposit', depositRoutes);
app.use('/api/deposits', depositRoutes);
app.use('/api/withdraw', withdrawalRoutes);
app.use('/api/withdrawals', withdrawalRoutes);
app.use('/api/kyc', kycRoutes);
app.use('/api/profile', profileRoutes);        // GET /api/profile       (user info)
app.use('/api/balance', balanceRoutes);        // GET /api/balance       (multi-coin balances)
app.use('/api/convert', convertRoutes);        


// --------- BASIC ROOT CHECK ---------
app.get("/", (req, res) => {
  res.send("NovaChain API is running.");
});

// --- Fetch deposit addresses for user deposit modal (public, no auth needed) ---
app.get('/api/deposit-addresses', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT coin, address, qr_url FROM deposit_addresses`
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ message: "Failed to fetch deposit addresses" });
  }
});

// --- ADMIN: Fetch ALL trades for admin backend ---
app.get('/api/trades', async (req, res) => {
  // Only allow admin backend requests!
  if (req.headers['x-admin-token'] !== process.env.ADMIN_API_TOKEN) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  try {
    const { rows } = await pool.query('SELECT * FROM trades ORDER BY timestamp DESC');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: 'DB error' });
  }
});


// Catch-all for unknown API routes
app.use((req, res) => {
  res.status(404).json({ error: 'API route not found' });
});


// --------- START SERVER ---------
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`✅ Server running on port ${PORT}`);
});
