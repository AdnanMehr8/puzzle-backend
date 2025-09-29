const express = require('express');
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

// Security middleware
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" }
}));
app.use(compression());
app.use(mongoSanitize());
app.use(hpp());

// CORS configuration
{{ ... }}
// Test route to verify basic functionality
app.get('/api/test', (req, res) => {
  res.json({ message: 'Auth route added - testing...' });
  // Log error
  logger.error(err);

  // Mongoose bad ObjectId
  if (err.name === 'CastError') {
    const message = 'Resource not found';
    error = { message, statusCode: 404 };
  }

  // Mongoose duplicate key
  if (err.code === 11000) {
    const message = 'Duplicate field value entered';
    error = { message, statusCode: 400 };
  }

  // Mongoose validation error
  if (err.name === 'ValidationError') {
    const message = Object.values(err.errors).map(val => val.message).join(', ');
    error = { message, statusCode: 400 };
  }

  // JWT errors
  if (err.name === 'JsonWebTokenError') {
    const message = 'Invalid token';
    error = { message, statusCode: 401 };
  }

  if (err.name === 'TokenExpiredError') {
    const message = 'Token expired';
    error = { message, statusCode: 401 };
  }

  res.status(error.statusCode || 500).json({
    status: 'error',
    message: error.message || 'Server Error',
    ...(process.env.NODE_ENV === 'development' && { stack: err.stack })
  });
};

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
    console.error('Handler error:', error);
    logger.error('Handler error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
};

// Also export the app for local development
module.exports.app = app;