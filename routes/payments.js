const express = require('express');
const { protect, sensitiveRateLimit } = require('../middleware/auth');
const { body, param, validationResult } = require('express-validator');
const rateLimit = require('express-rate-limit');
const stripeService = require('../services/stripe');
const solanaService = require('../services/solana');
const bitcoinService = require('../services/bitcoin');
const Transaction = require('../models/Transaction');

const router = express.Router();

// Rate limiting for payment operations
const paymentLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // limit each user to 10 payment operations per 15 minutes
  message: {
    status: 'error',
    message: 'Too many payment requests. Please try again later.'
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Validation middleware
const depositValidation = [
  body('amount')
    .isFloat({ min: 1, max: 10000 })
    .withMessage('Amount must be between $1 and $10,000'),
  body('paymentMethod')
    .isIn(['stripe', 'solana', 'bitcoin'])
    .withMessage('Invalid payment method')
];

const withdrawalValidation = [
  body('amount')
    .isFloat({ min: 10, max: 50000 })
    .withMessage('Amount must be between $10 and $50,000'),
  body('paymentMethod')
    .isIn(['stripe', 'solana', 'bitcoin'])
    .withMessage('Invalid payment method'),
  body('destination')
    .notEmpty()
    .withMessage('Destination address/account is required')
];

// Get user's transaction history
router.get('/transactions', protect, async (req, res) => {
  try {
    const { page = 1, limit = 20, type, status } = req.query;
    
    const query = {
      $or: [
        { fromUserId: req.user._id },
        { toUserId: req.user._id }
      ]
    };

    if (type) query.type = type;
    if (status) query.status = status;

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const [transactions, total] = await Promise.all([
      Transaction.find(query)
        .populate('puzzleId', 'title value')
        .populate('fromUserId', 'profile.firstName profile.lastName')
        .populate('toUserId', 'profile.firstName profile.lastName')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit)),
      Transaction.countDocuments(query)
    ]);

    res.status(200).json({
      status: 'success',
      results: transactions.length,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit))
      },
      data: {
        transactions
      }
    });

  } catch (error) {
    console.error('Get transactions error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Something went wrong while fetching transactions'
    });
  }
});

// Get single transaction
router.get('/transactions/:id', protect, [
  param('id').notEmpty().withMessage('Transaction ID is required')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        status: 'error',
        message: 'Validation failed',
        errors: errors.array()
      });
    }

    const transaction = await Transaction.findOne({
      $or: [
        { transactionId: req.params.id },
        { _id: req.params.id }
      ],
      $or: [
        { fromUserId: req.user._id },
        { toUserId: req.user._id }
      ]
    })
      .populate('puzzleId', 'title value')
      .populate('fromUserId', 'profile.firstName profile.lastName')
      .populate('toUserId', 'profile.firstName profile.lastName');

    if (!transaction) {
      return res.status(404).json({
        status: 'error',
        message: 'Transaction not found'
      });
    }

    res.status(200).json({
      status: 'success',
      data: {
        transaction
      }
    });

  } catch (error) {
    console.error('Get transaction error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Something went wrong while fetching transaction'
    });
  }
});

// STRIPE ROUTES

// Create Stripe payment intent for deposit
router.post('/stripe/create-payment-intent', protect, paymentLimiter, [
  body('amount')
    .isFloat({ min: 1, max: 10000 })
    .withMessage('Amount must be between $1 and $10,000')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        status: 'error',
        message: 'Validation failed',
        errors: errors.array()
      });
    }

    const { amount } = req.body;

    const result = await stripeService.createPaymentIntent(req.user._id, amount);

    res.status(200).json({
      status: 'success',
      message: 'Payment intent created successfully',
      data: {
        clientSecret: result.clientSecret,
        transactionId: result.transaction.transactionId,
        amount
      }
    });

  } catch (error) {
    console.error('Stripe create payment intent error:', error);
    res.status(500).json({
      status: 'error',
      message: error.message || 'Failed to create payment intent'
    });
  }
});

// Confirm Stripe payment
router.post('/stripe/confirm-payment', protect, [
  body('paymentIntentId').notEmpty().withMessage('Payment intent ID is required')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        status: 'error',
        message: 'Validation failed',
        errors: errors.array()
      });
    }

    const { paymentIntentId } = req.body;

    const result = await stripeService.confirmPayment(paymentIntentId);

    if (result.alreadyProcessed) {
      return res.status(200).json({
        status: 'success',
        message: 'Payment already processed',
        data: {
          transaction: result.transaction
        }
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

  } catch (error) {
    console.error('Stripe confirm payment error:', error);
    res.status(500).json({
      status: 'error',
      message: error.message || 'Failed to confirm payment'
    });
  }
});

// Add Stripe payment method
router.post('/stripe/add-payment-method', protect, [
  body('paymentMethodId').notEmpty().withMessage('Payment method ID is required')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        status: 'error',
        message: 'Validation failed',
        errors: errors.array()
      });
    }

    const { paymentMethodId } = req.body;

    const paymentMethod = await stripeService.addPaymentMethod(req.user._id, paymentMethodId);

    res.status(200).json({
      status: 'success',
      message: 'Payment method added successfully',
      data: {
        paymentMethod
      }
    });

  } catch (error) {
    console.error('Add Stripe payment method error:', error);
    res.status(500).json({
      status: 'error',
      message: error.message || 'Failed to add payment method'
    });
  }
});

// SOLANA ROUTES

// Add Solana wallet
router.post('/solana/add-wallet', protect, [
  body('walletAddress').notEmpty().withMessage('Wallet address is required')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        status: 'error',
        message: 'Validation failed',
        errors: errors.array()
      });
    }

    const { walletAddress } = req.body;

    const wallet = await solanaService.addWallet(req.user._id, walletAddress);

    res.status(200).json({
      status: 'success',
      message: 'Solana wallet added successfully',
      data: {
        wallet
      }
    });

  } catch (error) {
    console.error('Add Solana wallet error:', error);
    res.status(500).json({
      status: 'error',
      message: error.message || 'Failed to add Solana wallet'
    });
  }
});

// Create Solana deposit transaction
router.post('/solana/create-deposit', protect, paymentLimiter, [
  body('amount')
    .isFloat({ min: 1, max: 10000 })
    .withMessage('Amount must be between $1 and $10,000')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        status: 'error',
        message: 'Validation failed',
        errors: errors.array()
      });
    }

    const { amount } = req.body;

    const result = await solanaService.createDepositTransaction(req.user._id, amount);

    res.status(200).json({
      status: 'success',
      message: 'Solana deposit transaction created',
      data: result.depositInfo
    });

  } catch (error) {
    console.error('Solana create deposit error:', error);
    res.status(500).json({
      status: 'error',
      message: error.message || 'Failed to create Solana deposit'
    });
  }
});

// Confirm Solana deposit
router.post('/solana/confirm-deposit', protect, [
  body('transactionId').notEmpty().withMessage('Transaction ID is required'),
  body('txHash').notEmpty().withMessage('Transaction hash is required')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        status: 'error',
        message: 'Validation failed',
        errors: errors.array()
      });
    }

    const { transactionId, txHash } = req.body;

    const result = await solanaService.confirmDeposit(transactionId, txHash);

    if (result.alreadyProcessed) {
      return res.status(200).json({
        status: 'success',
        message: 'Deposit already processed',
        data: {
          transaction: result.transaction
        }
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

  } catch (error) {
    console.error('Solana confirm deposit error:', error);
    res.status(500).json({
      status: 'error',
      message: error.message || 'Failed to confirm Solana deposit'
    });
  }
});

// BITCOIN ROUTES

// Add Bitcoin wallet
router.post('/bitcoin/add-wallet', protect, [
  body('walletAddress').notEmpty().withMessage('Wallet address is required')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        status: 'error',
        message: 'Validation failed',
        errors: errors.array()
      });
    }

    const { walletAddress } = req.body;

    const wallet = await bitcoinService.addWallet(req.user._id, walletAddress);

    res.status(200).json({
      status: 'success',
      message: 'Bitcoin wallet added successfully',
      data: {
        wallet
      }
    });

  } catch (error) {
    console.error('Add Bitcoin wallet error:', error);
    res.status(500).json({
      status: 'error',
      message: error.message || 'Failed to add Bitcoin wallet'
    });
  }
});

// Create Bitcoin deposit transaction
router.post('/bitcoin/create-deposit', protect, paymentLimiter, [
  body('amount')
    .isFloat({ min: 1, max: 10000 })
    .withMessage('Amount must be between $1 and $10,000')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        status: 'error',
        message: 'Validation failed',
        errors: errors.array()
      });
    }

    const { amount } = req.body;

    const result = await bitcoinService.createDepositTransaction(req.user._id, amount);

    res.status(200).json({
      status: 'success',
      message: 'Bitcoin deposit transaction created',
      data: result.depositInfo
    });

  } catch (error) {
    console.error('Bitcoin create deposit error:', error);
    res.status(500).json({
      status: 'error',
      message: error.message || 'Failed to create Bitcoin deposit'
    });
  }
});

// Confirm Bitcoin deposit
router.post('/bitcoin/confirm-deposit', protect, [
  body('transactionId').notEmpty().withMessage('Transaction ID is required'),
  body('txHash').notEmpty().withMessage('Transaction hash is required')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        status: 'error',
        message: 'Validation failed',
        errors: errors.array()
      });
    }

    const { transactionId, txHash } = req.body;

    const result = await bitcoinService.confirmDeposit(transactionId, txHash);

    if (result.alreadyProcessed) {
      return res.status(200).json({
        status: 'success',
        message: 'Deposit already processed',
        data: {
          transaction: result.transaction
        }
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

  } catch (error) {
    console.error('Bitcoin confirm deposit error:', error);
    res.status(500).json({
      status: 'error',
      message: error.message || 'Failed to confirm Bitcoin deposit'
    });
  }
});

// WITHDRAWAL ROUTES

// Process withdrawal
router.post('/withdraw', protect, sensitiveRateLimit(3), withdrawalValidation, async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        status: 'error',
        message: 'Validation failed',
        errors: errors.array()
      });
    }

    const { amount, paymentMethod, destination } = req.body;

    let result;
    switch (paymentMethod) {
      case 'stripe':
        result = await stripeService.processWithdrawal(req.user._id, amount, destination);
        break;
      case 'solana':
        result = await solanaService.processWithdrawal(req.user._id, amount, destination);
        break;
      case 'bitcoin':
        result = await bitcoinService.processWithdrawal(req.user._id, amount, destination);
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
        newBalance: req.user.wallet.balance
      }
    });

  } catch (error) {
    console.error('Withdrawal error:', error);
    res.status(500).json({
      status: 'error',
      message: error.message || 'Failed to process withdrawal'
    });
  }
});

// Get wallet balances
router.get('/balances', protect, async (req, res) => {
  try {
    const balances = {
      usd: req.user.wallet.balance,
      crypto: req.user.wallet.cryptoBalances,
      totalEarnings: req.user.wallet.totalEarnings,
      totalSpent: req.user.wallet.totalSpent
    };

    // Get external wallet balances if addresses are provided
    const externalBalances = {};
    
    for (const paymentMethod of req.user.paymentMethods) {
      if (paymentMethod.type === 'solana' && paymentMethod.details.address) {
        try {
          externalBalances.solana = await solanaService.getWalletBalance(paymentMethod.details.address);
        } catch (error) {
          console.error('Error fetching Solana balance:', error);
        }
      } else if (paymentMethod.type === 'bitcoin' && paymentMethod.details.address) {
        try {
          externalBalances.bitcoin = await bitcoinService.getWalletBalance(paymentMethod.details.address);
        } catch (error) {
          console.error('Error fetching Bitcoin balance:', error);
        }
      }
    }

    res.status(200).json({
      status: 'success',
      data: {
        balances,
        externalBalances
      }
    });

  } catch (error) {
    console.error('Get balances error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Something went wrong while fetching balances'
    });
  }
});

// Get payment methods
router.get('/payment-methods', protect, async (req, res) => {
  try {
    const paymentMethods = req.user.paymentMethods.map(method => ({
      id: method.id,
      type: method.type,
      details: method.details,
      isDefault: method.isDefault,
      isVerified: method.isVerified,
      createdAt: method.createdAt
    }));

    res.status(200).json({
      status: 'success',
      data: {
        paymentMethods
      }
    });

  } catch (error) {
    console.error('Get payment methods error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Something went wrong while fetching payment methods'
    });
  }
});

// Remove payment method
router.delete('/payment-methods/:id', protect, [
  param('id').notEmpty().withMessage('Payment method ID is required')
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        status: 'error',
        message: 'Validation failed',
        errors: errors.array()
      });
    }

    const paymentMethodId = req.params.id;
    const paymentMethod = req.user.paymentMethods.find(method => method.id === paymentMethodId);

    if (!paymentMethod) {
      return res.status(404).json({
        status: 'error',
        message: 'Payment method not found'
      });
    }

    // Remove from external service if needed
    if (paymentMethod.type === 'stripe') {
      await stripeService.removePaymentMethod(req.user._id, paymentMethod.details.id);
    } else if (paymentMethod.type === 'solana') {
      await solanaService.removeWallet(req.user._id, paymentMethod.details.address);
    } else if (paymentMethod.type === 'bitcoin') {
      await bitcoinService.removeWallet(req.user._id, paymentMethod.details.address);
    }

    res.status(200).json({
      status: 'success',
      message: 'Payment method removed successfully'
    });

  } catch (error) {
    console.error('Remove payment method error:', error);
    res.status(500).json({
      status: 'error',
      message: error.message || 'Failed to remove payment method'
    });
  }
});

// Stripe webhook endpoint
router.post('/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  try {
    const signature = req.headers['stripe-signature'];
    const event = stripeService.verifyWebhookSignature(req.body, signature);

    await stripeService.handleWebhook(event);

    res.status(200).json({ received: true });

  } catch (error) {
    console.error('Stripe webhook error:', error);
    res.status(400).json({
      status: 'error',
      message: 'Webhook signature verification failed'
    });
  }
});

module.exports = router;
