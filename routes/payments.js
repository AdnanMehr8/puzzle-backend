// const express = require('express');
// const { protect, sensitiveRateLimit } = require('../middleware/auth');
// const { body, param, validationResult } = require('express-validator');
// const rateLimit = require('express-rate-limit');
// const stripeService = require('../services/stripe');
// const solanaService = require('../services/solana');
// const bitcoinService = require('../services/bitcoin');
// const Transaction = require('../models/Transaction');

// const router = express.Router();

// // Rate limiting for payment operations
// const paymentLimiter = rateLimit({
//   windowMs: 15 * 60 * 1000, // 15 minutes
//   max: 10, // limit each user to 10 payment operations per 15 minutes
//   message: {
//     status: 'error',
//     message: 'Too many payment requests. Please try again later.'
//   },
//   standardHeaders: true,
//   legacyHeaders: false,
// });

// // Validation middleware
// const depositValidation = [
//   body('amount')
//     .isFloat({ min: 1, max: 10000 })
//     .withMessage('Amount must be between $1 and $10,000'),
//   body('paymentMethod')
//     .isIn(['stripe', 'solana', 'bitcoin'])
//     .withMessage('Invalid payment method')
// ];

// const withdrawalValidation = [
//   body('amount')
//     .isFloat({ min: 10, max: 50000 })
//     .withMessage('Amount must be between $10 and $50,000'),
//   body('paymentMethod')
//     .isIn(['stripe', 'solana', 'bitcoin'])
//     .withMessage('Invalid payment method'),
//   body('destination')
//     .notEmpty()
//     .withMessage('Destination address/account is required')
// ];

// // Get user's transaction history
// router.get('/transactions', protect, async (req, res) => {
//   try {
//     const { page = 1, limit = 20, type, status } = req.query;
    
//     const query = {
//       $or: [
//         { fromUserId: req.user._id },
//         { toUserId: req.user._id }
//       ]
//     };

//     if (type) query.type = type;
//     if (status) query.status = status;

//     const skip = (parseInt(page) - 1) * parseInt(limit);

//     const [transactions, total] = await Promise.all([
//       Transaction.find(query)
//         .populate('puzzleId', 'title value')
//         .populate('fromUserId', 'profile.firstName profile.lastName')
//         .populate('toUserId', 'profile.firstName profile.lastName')
//         .sort({ createdAt: -1 })
//         .skip(skip)
//         .limit(parseInt(limit)),
//       Transaction.countDocuments(query)
//     ]);

//     res.status(200).json({
//       status: 'success',
//       results: transactions.length,
//       pagination: {
//         page: parseInt(page),
//         limit: parseInt(limit),
//         total,
//         pages: Math.ceil(total / parseInt(limit))
//       },
//       data: {
//         transactions
//       }
//     });

//   } catch (error) {
//     console.error('Get transactions error:', error);
//     res.status(500).json({
//       status: 'error',
//       message: 'Something went wrong while fetching transactions'
//     });
//   }
// });

// // Get single transaction
// router.get('/transactions/:id', protect, [
//   param('id').notEmpty().withMessage('Transaction ID is required')
// ], async (req, res) => {
//   try {
//     const errors = validationResult(req);
//     if (!errors.isEmpty()) {
//       return res.status(400).json({
//         status: 'error',
//         message: 'Validation failed',
//         errors: errors.array()
//       });
//     }

//     const transaction = await Transaction.findOne({
//       $or: [
//         { transactionId: req.params.id },
//         { _id: req.params.id }
//       ],
//       $or: [
//         { fromUserId: req.user._id },
//         { toUserId: req.user._id }
//       ]
//     })
//       .populate('puzzleId', 'title value')
//       .populate('fromUserId', 'profile.firstName profile.lastName')
//       .populate('toUserId', 'profile.firstName profile.lastName');

//     if (!transaction) {
//       return res.status(404).json({
//         status: 'error',
//         message: 'Transaction not found'
//       });
//     }

//     res.status(200).json({
//       status: 'success',
//       data: {
//         transaction
//       }
//     });

//   } catch (error) {
//     console.error('Get transaction error:', error);
//     res.status(500).json({
//       status: 'error',
//       message: 'Something went wrong while fetching transaction'
//     });
//   }
// });

// // STRIPE ROUTES

// // Create Stripe payment intent for deposit
// router.post('/stripe/create-payment-intent', protect, paymentLimiter, [
//   body('amount')
//     .isFloat({ min: 1, max: 10000 })
//     .withMessage('Amount must be between $1 and $10,000')
// ], async (req, res) => {
//   try {
//     const errors = validationResult(req);
//     if (!errors.isEmpty()) {
//       return res.status(400).json({
//         status: 'error',
//         message: 'Validation failed',
//         errors: errors.array()
//       });
//     }

//     const { amount } = req.body;

//     const result = await stripeService.createPaymentIntent(req.user._id, amount);

//     res.status(200).json({
//       status: 'success',
//       message: 'Payment intent created successfully',
//       data: {
//         clientSecret: result.clientSecret,
//         transactionId: result.transaction.transactionId,
//         amount
//       }
//     });

//   } catch (error) {
//     console.error('Stripe create payment intent error:', error);
//     res.status(500).json({
//       status: 'error',
//       message: error.message || 'Failed to create payment intent'
//     });
//   }
// });

// // Confirm Stripe payment
// router.post('/stripe/confirm-payment', protect, [
//   body('paymentIntentId').notEmpty().withMessage('Payment intent ID is required')
// ], async (req, res) => {
//   try {
//     const errors = validationResult(req);
//     if (!errors.isEmpty()) {
//       return res.status(400).json({
//         status: 'error',
//         message: 'Validation failed',
//         errors: errors.array()
//       });
//     }

//     const { paymentIntentId } = req.body;

//     const result = await stripeService.confirmPayment(paymentIntentId);

//     if (result.alreadyProcessed) {
//       return res.status(200).json({
//         status: 'success',
//         message: 'Payment already processed',
//         data: {
//           transaction: result.transaction
//         }
//       });
//     }

//     res.status(200).json({
//       status: 'success',
//       message: 'Payment confirmed successfully',
//       data: {
//         transaction: result.transaction,
//         newBalance: result.user.wallet.balance
//       }
//     });

//   } catch (error) {
//     console.error('Stripe confirm payment error:', error);
//     res.status(500).json({
//       status: 'error',
//       message: error.message || 'Failed to confirm payment'
//     });
//   }
// });

// // Add Stripe payment method
// router.post('/stripe/add-payment-method', protect, [
//   body('paymentMethodId').notEmpty().withMessage('Payment method ID is required')
// ], async (req, res) => {
//   try {
//     const errors = validationResult(req);
//     if (!errors.isEmpty()) {
//       return res.status(400).json({
//         status: 'error',
//         message: 'Validation failed',
//         errors: errors.array()
//       });
//     }

//     const { paymentMethodId } = req.body;

//     const paymentMethod = await stripeService.addPaymentMethod(req.user._id, paymentMethodId);

//     res.status(200).json({
//       status: 'success',
//       message: 'Payment method added successfully',
//       data: {
//         paymentMethod
//       }
//     });

//   } catch (error) {
//     console.error('Add Stripe payment method error:', error);
//     res.status(500).json({
//       status: 'error',
//       message: error.message || 'Failed to add payment method'
//     });
//   }
// });

// // SOLANA ROUTES

// // Add Solana wallet
// router.post('/solana/add-wallet', protect, [
//   body('walletAddress').notEmpty().withMessage('Wallet address is required')
// ], async (req, res) => {
//   try {
//     const errors = validationResult(req);
//     if (!errors.isEmpty()) {
//       return res.status(400).json({
//         status: 'error',
//         message: 'Validation failed',
//         errors: errors.array()
//       });
//     }

//     const { walletAddress } = req.body;

//     const wallet = await solanaService.addWallet(req.user._id, walletAddress);

//     res.status(200).json({
//       status: 'success',
//       message: 'Solana wallet added successfully',
//       data: {
//         wallet
//       }
//     });

//   } catch (error) {
//     console.error('Add Solana wallet error:', error);
//     res.status(500).json({
//       status: 'error',
//       message: error.message || 'Failed to add Solana wallet'
//     });
//   }
// });

// // Create Solana deposit transaction
// router.post('/solana/create-deposit', protect, paymentLimiter, [
//   body('amount')
//     .isFloat({ min: 1, max: 10000 })
//     .withMessage('Amount must be between $1 and $10,000')
// ], async (req, res) => {
//   try {
//     const errors = validationResult(req);
//     if (!errors.isEmpty()) {
//       return res.status(400).json({
//         status: 'error',
//         message: 'Validation failed',
//         errors: errors.array()
//       });
//     }

//     const { amount } = req.body;

//     const result = await solanaService.createDepositTransaction(req.user._id, amount);

//     res.status(200).json({
//       status: 'success',
//       message: 'Solana deposit transaction created',
//       data: result.depositInfo
//     });

//   } catch (error) {
//     console.error('Solana create deposit error:', error);
//     res.status(500).json({
//       status: 'error',
//       message: error.message || 'Failed to create Solana deposit'
//     });
//   }
// });

// // Confirm Solana deposit
// router.post('/solana/confirm-deposit', protect, [
//   body('transactionId').notEmpty().withMessage('Transaction ID is required'),
//   body('txHash').notEmpty().withMessage('Transaction hash is required')
// ], async (req, res) => {
//   try {
//     const errors = validationResult(req);
//     if (!errors.isEmpty()) {
//       return res.status(400).json({
//         status: 'error',
//         message: 'Validation failed',
//         errors: errors.array()
//       });
//     }

//     const { transactionId, txHash } = req.body;

//     const result = await solanaService.confirmDeposit(transactionId, txHash);

//     if (result.alreadyProcessed) {
//       return res.status(200).json({
//         status: 'success',
//         message: 'Deposit already processed',
//         data: {
//           transaction: result.transaction
//         }
//       });
//     }

//     res.status(200).json({
//       status: 'success',
//       message: 'Solana deposit confirmed successfully',
//       data: {
//         transaction: result.transaction,
//         newBalance: result.user.wallet.balance
//       }
//     });

//   } catch (error) {
//     console.error('Solana confirm deposit error:', error);
//     res.status(500).json({
//       status: 'error',
//       message: error.message || 'Failed to confirm Solana deposit'
//     });
//   }
// });

// // BITCOIN ROUTES

// // Add Bitcoin wallet
// router.post('/bitcoin/add-wallet', protect, [
//   body('walletAddress').notEmpty().withMessage('Wallet address is required')
// ], async (req, res) => {
//   try {
//     const errors = validationResult(req);
//     if (!errors.isEmpty()) {
//       return res.status(400).json({
//         status: 'error',
//         message: 'Validation failed',
//         errors: errors.array()
//       });
//     }

//     const { walletAddress } = req.body;

//     const wallet = await bitcoinService.addWallet(req.user._id, walletAddress);

//     res.status(200).json({
//       status: 'success',
//       message: 'Bitcoin wallet added successfully',
//       data: {
//         wallet
//       }
//     });

//   } catch (error) {
//     console.error('Add Bitcoin wallet error:', error);
//     res.status(500).json({
//       status: 'error',
//       message: error.message || 'Failed to add Bitcoin wallet'
//     });
//   }
// });

// // Create Bitcoin deposit transaction
// router.post('/bitcoin/create-deposit', protect, paymentLimiter, [
//   body('amount')
//     .isFloat({ min: 1, max: 10000 })
//     .withMessage('Amount must be between $1 and $10,000')
// ], async (req, res) => {
//   try {
//     const errors = validationResult(req);
//     if (!errors.isEmpty()) {
//       return res.status(400).json({
//         status: 'error',
//         message: 'Validation failed',
//         errors: errors.array()
//       });
//     }

//     const { amount } = req.body;

//     const result = await bitcoinService.createDepositTransaction(req.user._id, amount);

//     res.status(200).json({
//       status: 'success',
//       message: 'Bitcoin deposit transaction created',
//       data: result.depositInfo
//     });

//   } catch (error) {
//     console.error('Bitcoin create deposit error:', error);
//     res.status(500).json({
//       status: 'error',
//       message: error.message || 'Failed to create Bitcoin deposit'
//     });
//   }
// });

// // Confirm Bitcoin deposit
// router.post('/bitcoin/confirm-deposit', protect, [
//   body('transactionId').notEmpty().withMessage('Transaction ID is required'),
//   body('txHash').notEmpty().withMessage('Transaction hash is required')
// ], async (req, res) => {
//   try {
//     const errors = validationResult(req);
//     if (!errors.isEmpty()) {
//       return res.status(400).json({
//         status: 'error',
//         message: 'Validation failed',
//         errors: errors.array()
//       });
//     }

//     const { transactionId, txHash } = req.body;

//     const result = await bitcoinService.confirmDeposit(transactionId, txHash);

//     if (result.alreadyProcessed) {
//       return res.status(200).json({
//         status: 'success',
//         message: 'Deposit already processed',
//         data: {
//           transaction: result.transaction
//         }
//       });
//     }

//     res.status(200).json({
//       status: 'success',
//       message: 'Bitcoin deposit confirmed successfully',
//       data: {
//         transaction: result.transaction,
//         newBalance: result.user.wallet.balance
//       }
//     });

//   } catch (error) {
//     console.error('Bitcoin confirm deposit error:', error);
//     res.status(500).json({
//       status: 'error',
//       message: error.message || 'Failed to confirm Bitcoin deposit'
//     });
//   }
// });

// // WITHDRAWAL ROUTES

// // Process withdrawal
// router.post('/withdraw', protect, sensitiveRateLimit(3), withdrawalValidation, async (req, res) => {
//   try {
//     const errors = validationResult(req);
//     if (!errors.isEmpty()) {
//       return res.status(400).json({
//         status: 'error',
//         message: 'Validation failed',
//         errors: errors.array()
//       });
//     }

//     const { amount, paymentMethod, destination } = req.body;

//     let result;
//     switch (paymentMethod) {
//       case 'stripe':
//         result = await stripeService.processWithdrawal(req.user._id, amount, destination);
//         break;
//       case 'solana':
//         result = await solanaService.processWithdrawal(req.user._id, amount, destination);
//         break;
//       case 'bitcoin':
//         result = await bitcoinService.processWithdrawal(req.user._id, amount, destination);
//         break;
//       default:
//         return res.status(400).json({
//           status: 'error',
//           message: 'Invalid payment method'
//         });
//     }

//     res.status(200).json({
//       status: 'success',
//       message: 'Withdrawal processed successfully',
//       data: {
//         transaction: result.transaction,
//         txHash: result.txHash || result.transfer?.id,
//         newBalance: req.user.wallet.balance
//       }
//     });

//   } catch (error) {
//     console.error('Withdrawal error:', error);
//     res.status(500).json({
//       status: 'error',
//       message: error.message || 'Failed to process withdrawal'
//     });
//   }
// });

// // Get wallet balances
// router.get('/balances', protect, async (req, res) => {
//   try {
//     const balances = {
//       usd: req.user.wallet.balance,
//       crypto: req.user.wallet.cryptoBalances,
//       totalEarnings: req.user.wallet.totalEarnings,
//       totalSpent: req.user.wallet.totalSpent
//     };

//     // Get external wallet balances if addresses are provided
//     const externalBalances = {};
    
//     for (const paymentMethod of req.user.paymentMethods) {
//       if (paymentMethod.type === 'solana' && paymentMethod.details.address) {
//         try {
//           externalBalances.solana = await solanaService.getWalletBalance(paymentMethod.details.address);
//         } catch (error) {
//           console.error('Error fetching Solana balance:', error);
//         }
//       } else if (paymentMethod.type === 'bitcoin' && paymentMethod.details.address) {
//         try {
//           externalBalances.bitcoin = await bitcoinService.getWalletBalance(paymentMethod.details.address);
//         } catch (error) {
//           console.error('Error fetching Bitcoin balance:', error);
//         }
//       }
//     }

//     res.status(200).json({
//       status: 'success',
//       data: {
//         balances,
//         externalBalances
//       }
//     });

//   } catch (error) {
//     console.error('Get balances error:', error);
//     res.status(500).json({
//       status: 'error',
//       message: 'Something went wrong while fetching balances'
//     });
//   }
// });

// // Get payment methods
// router.get('/payment-methods', protect, async (req, res) => {
//   try {
//     const paymentMethods = req.user.paymentMethods.map(method => ({
//       id: method.id,
//       type: method.type,
//       details: method.details,
//       isDefault: method.isDefault,
//       isVerified: method.isVerified,
//       createdAt: method.createdAt
//     }));

//     res.status(200).json({
//       status: 'success',
//       data: {
//         paymentMethods
//       }
//     });

//   } catch (error) {
//     console.error('Get payment methods error:', error);
//     res.status(500).json({
//       status: 'error',
//       message: 'Something went wrong while fetching payment methods'
//     });
//   }
// });

// // Remove payment method
// router.delete('/payment-methods/:id', protect, [
//   param('id').notEmpty().withMessage('Payment method ID is required')
// ], async (req, res) => {
//   try {
//     const errors = validationResult(req);
//     if (!errors.isEmpty()) {
//       return res.status(400).json({
//         status: 'error',
//         message: 'Validation failed',
//         errors: errors.array()
//       });
//     }

//     const paymentMethodId = req.params.id;
//     const paymentMethod = req.user.paymentMethods.find(method => method.id === paymentMethodId);

//     if (!paymentMethod) {
//       return res.status(404).json({
//         status: 'error',
//         message: 'Payment method not found'
//       });
//     }

//     // Remove from external service if needed
//     if (paymentMethod.type === 'stripe') {
//       await stripeService.removePaymentMethod(req.user._id, paymentMethod.details.id);
//     } else if (paymentMethod.type === 'solana') {
//       await solanaService.removeWallet(req.user._id, paymentMethod.details.address);
//     } else if (paymentMethod.type === 'bitcoin') {
//       await bitcoinService.removeWallet(req.user._id, paymentMethod.details.address);
//     }

//     res.status(200).json({
//       status: 'success',
//       message: 'Payment method removed successfully'
//     });

//   } catch (error) {
//     console.error('Remove payment method error:', error);
//     res.status(500).json({
//       status: 'error',
//       message: error.message || 'Failed to remove payment method'
//     });
//   }
// });

// // Stripe webhook endpoint
// router.post('/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
//   try {
//     const signature = req.headers['stripe-signature'];
//     const event = stripeService.verifyWebhookSignature(req.body, signature);

//     await stripeService.handleWebhook(event);

//     res.status(200).json({ received: true });

//   } catch (error) {
//     console.error('Stripe webhook error:', error);
//     res.status(400).json({
//       status: 'error',
//       message: 'Webhook signature verification failed'
//     });
//   }
// });

// module.exports = router;
const express = require('express');
const { protect, sensitiveRateLimit } = require('../middleware/auth');
const { body, param, validationResult } = require('express-validator');
const rateLimit = require('express-rate-limit');
const stripeService = require('../services/stripe');
const solanaService = require('../services/solana');
const bitcoinService = require('../services/bitcoin');
const Transaction = require('../models/Transaction');

const router = express.Router();

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
    solanaService.addWallet(req.user._id, walletAddress),
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
    solanaService.createDepositTransaction(req.user._id, amount),
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
    solanaService.confirmDeposit(transactionId, txHash),
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
        solanaService.processWithdrawal(req.user._id, amount, destination),
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
          solanaService.getWalletBalance(paymentMethod.details.address),
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
          solanaService.removeWallet(req.user._id, paymentMethod.details.address),
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
      solanaService.healthCheck(),
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