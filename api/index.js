/* const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const mongoSanitize = require('express-mongo-sanitize');
const hpp = require('hpp');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

// Import routes (adding back one by one)
const puzzleRoutes = require('../routes/puzzles');
const paymentRoutes = require('../routes/payments');
const adminRoutes = require('../routes/admin');
const transactionRoutes = require('../routes/transactions');

  const app = express();

  // Create a serverless-compatible logger
  const logger = {
    info: (message) => console.log(`INFO: ${message}`),
    error: (message) => console.error(`ERROR: ${message}`),
    warn: (message) => console.warn(`WARN: ${message}`),
    debug: (message) => console.log(`DEBUG: ${message}`)
  };

// Mount webhooks BEFORE any body parsers so Stripe signature verification sees raw body
app.use('/api/webhooks', require('../routes/webhooks'));
// CORS configuration
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
// Test route to verify basic functionality
app.get('/api/test', (req, res) => {
  res.json({ message: 'OK' });
});

// 404 handler
app.use('*', (req, res) => {
  res.status(404).json({
    error: 'Route not found',
    path: req.originalUrl
  });
});

// Global error handler
app.use(errorHandler);

// Export for Vercel
module.exports = async (req, res) => {
  try {
    await connectDB();
    return app(req, res);
  } catch (error) {
    return res.status(500).json({ error: 'Internal server error' });
  }
};

// Also export the app for local development
module.exports = require('../index.js').app;
*/

// Minimal proxy used only for IDE friendliness; Vercel routes to api/proxy.js
module.exports = require('../index.js');