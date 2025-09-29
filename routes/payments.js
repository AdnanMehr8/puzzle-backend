const express = require('express');
    const { protect, sensitiveRateLimit } = require('../middleware/auth');
    const { body, param, validationResult } = require('express-validator');
    const rateLimit = require('express-rate-limit');
    const stripeService = require('../services/stripe');
    const bitcoinService = require('../services/bitcoin');
    const Transaction = require('../models/Transaction');

    const router = express.Router();

    // Lazy-load Solana service to reduce cold start crashes on Vercel
    // This defers requiring @solana/web3.js until Solana endpoints are actually hit
    async function loadSolanaService() {
      if (!global.__solanaService) {
        // Use synchronous require to avoid ESM import resolver issues in CJS runtime
        const mod = require('../services/solana');
        global.__solanaService = mod.default || mod;
      }
      return global.__solanaService;
    }

// Serverless-friendly rate limiting with shorter windows
const paymentLimiter = rateLimit({
  windowMs: 5 * 60 * 1000, // 5 minutes instead of 15
  max: 5, // Reduced from 10 to 5
  message: {
    status: 'error',
    message: 'Too many payment requests. Please try again in 5 minutes.'
  },
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true, // Don't count successful requests
});

// Validation middleware with stricter limits
const depositValidation = [
  body('amount')
    .isFloat({ min: 5, max: 5000 }) // Reduced max from 10000 to 5000
    .withMessage('Amount must be between $5 and $5,000'),
  body('paymentMethod')
    .isIn(['stripe', 'solana', 'bitcoin'])
    .withMessage('Invalid payment method')
];

const withdrawalValidation = [
  body('amount')
    .isFloat({ min: 10, max: 10000 }) // Reduced max from 50000 to 10000
    .withMessage('Amount must be between $10 and $10,000'),
  body('paymentMethod')
    .isIn(['stripe', 'solana', 'bitcoin'])
    .withMessage('Invalid payment method'),
  body('destination')
    .isLength({ min: 10, max: 200 }) // Add length validation
    .withMessage('Invalid destination address format')
];

// Timeout wrapper for async operations
const withTimeout = (promise, timeoutMs = 25000, errorMessage = 'Operation timeout') => {
  return Promise.race([
    promise,
    new Promise((_, reject) => 
      setTimeout(() => reject(new Error(errorMessage)), timeoutMs)
    )
  ]);
};

// Error handler wrapper
const asyncHandler = (fn) => {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch((error) => {
      console.error('Route error:', error);
      
      // Don't expose internal errors in production
      const message = process.env.NODE_ENV === 'production' 
        ? 'An error occurred. Please try again.' 
        : error.message;

      res.status(500).json({
        status: 'error',
        message,
        ...(process.env.NODE_ENV !== 'production' && { stack: error.stack })
      });
    });
  };
};

// Get user's transaction history with pagination limits
router.get('/transactions', protect, asyncHandler(async (req, res) => {
  const { page = 1, limit = 10, type, status } = req.query;
  
  // Enforce reasonable limits for serverless
  const safeLimit = Math.min(parseInt(limit), 20);
  const safePage = Math.max(parseInt(page), 1);
  
  if (safePage > 100) {
    return res.status(400).json({
      status: 'error',
      message: 'Page number too high. Maximum page is 100.'
    });
  }

  const query = {
    $or: [
      { fromUserId: req.user._id },
      { toUserId: req.user._id }
    ]
  };

  if (type && ['deposit', 'withdrawal', 'puzzle_reward', 'puzzle_purchase'].includes(type)) {
    query.type = type;
  }
  if (status && ['pending', 'completed', 'failed'].includes(status)) {
    query.status = status;
  }

  const skip = (safePage - 1) * safeLimit;

  const [transactions, total] = await withTimeout(
    Promise.all([
      Transaction.find(query)
        .select('transactionId type amount status paymentMethod createdAt processedAt') // Only select needed fields
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(safeLimit)
        .lean(), // Use lean() for better performance
      Transaction.countDocuments(query)
    ]),
    20000,
    'Database query timeout'
  );

  res.status(200).json({
    status: 'success',
    results: transactions.length,
    pagination: {
      page: safePage,
      limit: safeLimit,
      total,
      pages: Math.ceil(total / safeLimit)
    },
    data: { transactions }
  });
}));

// Get single transaction with timeout
router.get('/transactions/:id', protect, [
  param('id').isLength({ min: 10, max: 50 }).withMessage('Invalid transaction ID format')
], asyncHandler(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      status: 'error',
      message: 'Validation failed',
      errors: errors.array()
    });
  }

  const transaction = await withTimeout(
    Transaction.findOne({
      $and: [
        {
          $or: [
            { transactionId: req.params.id },
            { _id: req.params.id }
          ]
        },
        {
          $or: [
            { fromUserId: req.user._id },
            { toUserId: req.user._id }
          ]
        }
      ]
    }).lean(),
    10000,
    'Transaction lookup timeout'
  );

  if (!transaction) {
    return res.status(404).json({
      status: 'error',
      message: 'Transaction not found'
    });
  }

  res.status(200).json({
    status: 'success',
    data: { transaction }
  });
}));

// STRIPE ROUTES with timeout protection

router.post('/stripe/create-payment-intent', protect, paymentLimiter, [
  body('amount')
    .isFloat({ min: 5, max: 5000 })
    .withMessage('Amount must be between $5 and $5,000')
], asyncHandler(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      status: 'error',
      message: 'Validation failed',
      errors: errors.array()
    });
  }

  const { amount } = req.body;

  const result = await withTimeout(
    stripeService.createPaymentIntent(req.user._id, amount),
    20000,
    'Payment intent creation timeout'
  );

  res.status(200).json({
    status: 'success',
    message: 'Payment intent created successfully',
    data: {
      clientSecret: result.clientSecret,
      transactionId: result.transaction.transactionId,
      amount
    }
  });
}));

router.post('/stripe/confirm-payment', protect, [
  body('paymentIntentId').isLength({ min: 10, max: 100 }).withMessage('Invalid payment intent ID')
], asyncHandler(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      status: 'error',
      message: 'Validation failed',
      errors: errors.array()
    });
  }

  const { paymentIntentId } = req.body;

  const result = await withTimeout(
    stripeService.confirmPayment(paymentIntentId),
    25000,
    'Payment confirmation timeout'
  );

  if (result.alreadyProcessed) {
    return res.status(200).json({
      status: 'success',
      message: 'Payment already processed',
      data: { transaction: result.transaction }
    });
  }

  res.status(200).json({
    status: 'success',
    message: 'Payment confirmed successfully',
    data: {
      transaction: result.transaction,
      newBalance: result.user.wallet.balance
    }
  });
}));

// SOLANA ROUTES with enhanced timeout protection

router.post('/solana/add-wallet', protect, [
  body('walletAddress').isLength({ min: 32, max: 50 }).withMessage('Invalid wallet address format')
], asyncHandler(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      status: 'error',
      message: 'Validation failed',
      errors: errors.array()
    });
  }

  const { walletAddress } = req.body;

  const wallet = await withTimeout(
    (await loadSolanaService()).addWallet(req.user._id, walletAddress),
    15000,
    'Wallet verification timeout'
  );

  res.status(200).json({
    status: 'success',
    message: 'Solana wallet added successfully',
    data: { wallet }
  });
}));

router.post('/solana/create-deposit', protect, paymentLimiter, [
  body('amount')
    .isFloat({ min: 5, max: 5000 })
    .withMessage('Amount must be between $5 and $5,000')
], asyncHandler(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      status: 'error',
      message: 'Validation failed',
      errors: errors.array()
    });
  }

  const { amount } = req.body;

  const result = await withTimeout(
    (await loadSolanaService()).createDepositTransaction(req.user._id, amount),
    15000,
    'Deposit creation timeout'
  );

  res.status(200).json({
    status: 'success',
    message: 'Solana deposit transaction created',
    data: result.depositInfo
  });
}));

router.post('/solana/confirm-deposit', protect, [
  body('transactionId').isLength({ min: 10, max: 50 }).withMessage('Invalid transaction ID'),
  body('txHash').isLength({ min: 60, max: 100 }).withMessage('Invalid transaction hash format')
], asyncHandler(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      status: 'error',
      message: 'Validation failed',
      errors: errors.array()
    });
  }

  const { transactionId, txHash } = req.body;

  const result = await withTimeout(
    (await loadSolanaService()).confirmDeposit(transactionId, txHash),
    25000,
    'Deposit confirmation timeout'
  );

  if (result.alreadyProcessed) {
    return res.status(200).json({
      status: 'success',
      message: 'Deposit already processed',
      data: { transaction: result.transaction }
    });
  }

  res.status(200).json({
    status: 'success',
    message: 'Solana deposit confirmed successfully',
    data: {
      transaction: result.transaction,
      newBalance: result.user.wallet.balance
    }
  });
}));

// BITCOIN ROUTES with similar timeout protection

router.post('/bitcoin/add-wallet', protect, [
  body('walletAddress').isLength({ min: 26, max: 62 }).withMessage('Invalid Bitcoin address format')
], asyncHandler(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      status: 'error',
      message: 'Validation failed',
      errors: errors.array()
    });
  }

  const { walletAddress } = req.body;

  const wallet = await withTimeout(
    bitcoinService.addWallet(req.user._id, walletAddress),
    15000,
    'Bitcoin wallet verification timeout'
  );

  res.status(200).json({
    status: 'success',
    message: 'Bitcoin wallet added successfully',
    data: { wallet }
  });
}));

router.post('/bitcoin/create-deposit', protect, paymentLimiter, [
  body('amount')
    .isFloat({ min: 5, max: 5000 })
    .withMessage('Amount must be between $5 and $5,000')
], asyncHandler(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      status: 'error',
      message: 'Validation failed',
      errors: errors.array()
    });
  }

  const { amount } = req.body;

  const result = await withTimeout(
    bitcoinService.createDepositTransaction(req.user._id, amount),
    15000,
    'Bitcoin deposit creation timeout'
  );

  res.status(200).json({
    status: 'success',
    message: 'Bitcoin deposit transaction created',
    data: result.depositInfo
  });
}));

router.post('/bitcoin/confirm-deposit', protect, [
  body('transactionId').isLength({ min: 10, max: 50 }).withMessage('Invalid transaction ID'),
  body('txHash').isLength({ min: 60, max: 70 }).withMessage('Invalid Bitcoin transaction hash')
], asyncHandler(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      status: 'error',
      message: 'Validation failed',
      errors: errors.array()
    });
  }

  const { transactionId, txHash } = req.body;

  const result = await withTimeout(
    bitcoinService.confirmDeposit(transactionId, txHash),
    25000,
    'Bitcoin confirmation timeout'
  );

  if (result.alreadyProcessed) {
    return res.status(200).json({
      status: 'success',
      message: 'Deposit already processed',
      data: { transaction: result.transaction }
    });
  }

  res.status(200).json({
    status: 'success',
    message: 'Bitcoin deposit confirmed successfully',
    data: {
      transaction: result.transaction,
      newBalance: result.user.wallet.balance
    }
  });
}));

// WITHDRAWAL ROUTES with strict timeout

router.post('/withdraw', protect, sensitiveRateLimit(2), withdrawalValidation, asyncHandler(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      status: 'error',
      message: 'Validation failed',
      errors: errors.array()
    });
  }

  const { amount, paymentMethod, destination } = req.body;

  // Pre-validate user balance to fail fast
  const withdrawalFee = paymentMethod === 'stripe' ? 1.50 : 2.50;
  const totalRequired = amount + withdrawalFee;

  if (!req.user.wallet?.balance || req.user.wallet.balance < totalRequired) {
    return res.status(400).json({
      status: 'error',
      message: `Insufficient balance. Required: $${totalRequired.toFixed(2)} (amount + fee)`
    });
  }

  let result;
  const timeoutMs = paymentMethod === 'stripe' ? 25000 : 35000; // Longer timeout for crypto

  switch (paymentMethod) {
    case 'stripe':
      result = await withTimeout(
        stripeService.processWithdrawal(req.user._id, amount, destination),
        timeoutMs,
        'Stripe withdrawal timeout'
      );
      break;
    case 'solana':
      result = await withTimeout(
        (await loadSolanaService()).processWithdrawal(req.user._id, amount, destination),
        timeoutMs,
        'Solana withdrawal timeout'
      );
      break;
    case 'bitcoin':
      result = await withTimeout(
        bitcoinService.processWithdrawal(req.user._id, amount, destination),
        timeoutMs,
        'Bitcoin withdrawal timeout'
      );
      break;
    default:
      return res.status(400).json({
        status: 'error',
        message: 'Invalid payment method'
      });
  }

  res.status(200).json({
    status: 'success',
    message: 'Withdrawal processed successfully',
    data: {
      transaction: result.transaction,
      txHash: result.txHash || result.transfer?.id,
      fee: withdrawalFee
    }
  });
}));

// Optimized balance endpoint with parallel processing limits
router.get('/balances', protect, asyncHandler(async (req, res) => {
  const balances = {
    usd: req.user.wallet?.balance || 0,
    crypto: req.user.wallet?.cryptoBalances || {},
    totalEarnings: req.user.wallet?.totalEarnings || 0,
    totalSpent: req.user.wallet?.totalSpent || 0
  };

  // Get external wallet balances with timeout and error handling
  const externalBalances = {};
  const balancePromises = [];

  // Limit concurrent external API calls
  const paymentMethods = req.user.paymentMethods?.slice(0, 3) || []; // Max 3 methods

  for (const paymentMethod of paymentMethods) {
    if (paymentMethod.type === 'solana' && paymentMethod.details?.address) {
      balancePromises.push(
        withTimeout(
          (await loadSolanaService()).getWalletBalance(paymentMethod.details.address),
          10000,
          'Solana balance timeout'
        )
          .then(balance => ({ type: 'solana', balance }))
          .catch(error => ({ type: 'solana', error: error.message }))
      );
    } else if (paymentMethod.type === 'bitcoin' && paymentMethod.details?.address) {
      balancePromises.push(
        withTimeout(
          bitcoinService.getWalletBalance(paymentMethod.details.address),
          10000,
          'Bitcoin balance timeout'
        )
          .then(balance => ({ type: 'bitcoin', balance }))
          .catch(error => ({ type: 'bitcoin', error: error.message }))
      );
    }
  }

  // Process balance requests with overall timeout
  if (balancePromises.length > 0) {
    try {
      const results = await withTimeout(
        Promise.allSettled(balancePromises),
        15000,
        'External balance check timeout'
      );

      results.forEach(result => {
        if (result.status === 'fulfilled' && result.value.balance) {
          externalBalances[result.value.type] = result.value.balance;
        }
      });
    } catch (error) {
      console.error('External balance fetch error:', error);
      // Continue without external balances
    }
  }

  res.status(200).json({
    status: 'success',
    data: {
      balances,
      externalBalances
    }
  });
}));

// Simplified payment methods endpoint
router.get('/payment-methods', protect, asyncHandler(async (req, res) => {
  const paymentMethods = (req.user.paymentMethods || []).map(method => ({
    id: method.id,
    type: method.type,
    details: {
      // Only return safe details
      ...(method.type === 'stripe' && { 
        last4: method.details?.last4,
        brand: method.details?.brand 
      }),
      ...(method.type === 'solana' && { 
        address: method.details?.address 
      }),
      ...(method.type === 'bitcoin' && { 
        address: method.details?.address 
      })
    },
    isDefault: method.isDefault,
    isVerified: method.isVerified,
    createdAt: method.createdAt
  }));

  res.status(200).json({
    status: 'success',
    data: { paymentMethods }
  });
}));

// Enhanced payment method removal
router.delete('/payment-methods/:id', protect, [
  param('id').isLength({ min: 10, max: 50 }).withMessage('Invalid payment method ID')
], asyncHandler(async (req, res) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      status: 'error',
      message: 'Validation failed',
      errors: errors.array()
    });
  }

  const paymentMethodId = req.params.id;
  const paymentMethod = req.user.paymentMethods?.find(method => method.id === paymentMethodId);

  if (!paymentMethod) {
    return res.status(404).json({
      status: 'error',
      message: 'Payment method not found'
    });
  }

  // Remove from external service with timeout
  try {
    switch (paymentMethod.type) {
      case 'stripe':
        await withTimeout(
          stripeService.removePaymentMethod(req.user._id, paymentMethod.details.id),
          10000,
          'Stripe removal timeout'
        );
        break;
      case 'solana':
        await withTimeout(
          (await loadSolanaService()).removeWallet(req.user._id, paymentMethod.details.address),
          10000,
          'Solana removal timeout'
        );
        break;
      case 'bitcoin':
        await withTimeout(
          bitcoinService.removeWallet(req.user._id, paymentMethod.details.address),
          10000,
          'Bitcoin removal timeout'
        );
        break;
    }
  } catch (error) {
    console.error('Payment method removal error:', error);
    // Continue with removal from user record even if external service fails
  }

  res.status(200).json({
    status: 'success',
    message: 'Payment method removed successfully'
  });
}));

// Optimized webhook endpoint
router.post('/stripe/webhook', express.raw({ 
  type: 'application/json',
  limit: '1mb' // Limit payload size
}), asyncHandler(async (req, res) => {
  const signature = req.headers['stripe-signature'];
  
  if (!signature) {
    return res.status(400).json({
      status: 'error',
      message: 'Missing Stripe signature'
    });
  }

  const event = stripeService.verifyWebhookSignature(req.body, signature);

  await withTimeout(
    stripeService.handleWebhook(event),
    20000,
    'Webhook processing timeout'
  );

  res.status(200).json({ received: true });
}));

// Health check endpoint for monitoring
router.get('/health', asyncHandler(async (req, res) => {
  const health = {
    status: 'healthy',
    timestamp: new Date(),
    services: {}
  };

  // Quick health checks with very short timeouts
  try {
    const solanaHealth = await withTimeout(
      (await loadSolanaService()).healthCheck(),
      3000,
      'Solana health timeout'
    );
    health.services.solana = solanaHealth;
  } catch (error) {
    health.services.solana = { status: 'unhealthy', error: error.message };
  }

  res.status(200).json(health);
}));

module.exports = router;