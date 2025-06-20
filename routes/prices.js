const express = require('express');
const axios = require('axios');
const router = express.Router();

const CMC_API_KEY = process.env.COINMARKETCAP_API_KEY;

// Get latest prices for top 20 coins
router.get('/prices', async (req, res) => {
  try {
    const response = await axios.get(
      'https://pro-api.coinmarketcap.com/v1/cryptocurrency/listings/latest?limit=20',
      { headers: { 'X-CMC_PRO_API_KEY': CMC_API_KEY } }
    );
    res.json(response.data.data); // Just send the 'data' array to frontend
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch prices' });
  }
});

module.exports = router;
