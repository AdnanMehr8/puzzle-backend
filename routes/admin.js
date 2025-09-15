const express = require('express');
const User = require('../models/User');
const Puzzle = require('../models/Puzzle');
const Transaction = require('../models/Transaction');
const { protect, restrictTo } = require('../middleware/auth');
const { body, param, query, validationResult } = require('express-validator');

const router = express.Router();

// All routes require admin authentication
router.use(protect);
router.use(restrictTo('admin'));

// Get platform statistics
router.get('/statistics', async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    
    const dateFilter = {};
    if (startDate || endDate) {
      dateFilter.createdAt = {};
      if (startDate) dateFilter.createdAt.$gte = new Date(startDate);
      if (endDate) dateFilter.createdAt.$lte = new Date(endDate);
    }

    // Get user statistics
    const userStats = await User.aggregate([
      { $match: dateFilter },
      {
        $group: {
          _id: null,
          totalUsers: { $sum: 1 },
          activeUsers: {
            $sum: { $cond: [{ $eq: ['$status', 'active'] }, 1, 0] }
          },
          suspendedUsers: {
            $sum: { $cond: [{ $eq: ['$status', 'suspended'] }, 1, 0] }
          },
          totalWalletBalance: { $sum: '$wallet.balance' },
          totalEarnings: { $sum: '$wallet.totalEarnings' },
          totalSpent: { $sum: '$wallet.totalSpent' }
        }
      }
    ]);

    // Get puzzle statistics
    const puzzleStats = await Puzzle.getStatistics();

    // Get transaction statistics
    const transactionStats = await Transaction.getStatistics(
      startDate ? new Date(startDate) : null,
      endDate ? new Date(endDate) : null
    );

    // Get recent activity
    const recentUsers = await User.find(dateFilter)
      .select('profile.firstName profile.lastName email createdAt status')
      .sort({ createdAt: -1 })
      .limit(10);

    const recentPuzzles = await Puzzle.find(dateFilter)
      .populate('creatorId', 'profile.firstName profile.lastName')
      .select('title value solved createdAt')
      .sort({ createdAt: -1 })
      .limit(10);

    const recentTransactions = await Transaction.find(dateFilter)
      .populate('fromUserId', 'profile.firstName profile.lastName')
      .populate('toUserId', 'profile.firstName profile.lastName')
      .sort({ createdAt: -1 })
      .limit(10);

    res.status(200).json({
      status: 'success',
      data: {
        users: userStats[0] || {
          totalUsers: 0,
          activeUsers: 0,
          suspendedUsers: 0,
          totalWalletBalance: 0,
          totalEarnings: 0,
          totalSpent: 0
        },
        puzzles: puzzleStats,
        transactions: transactionStats,
        recentActivity: {
          users: recentUsers,
          puzzles: recentPuzzles,
          transactions: recentTransactions
        }
      }
    });

  } catch (error) {
    console.error('Get admin statistics error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Something went wrong while fetching statistics'
    });
  }
});

// Get all users with pagination and filters
router.get('/users', [
  query('page')
    .optional()
    .isInt({ min: 1 })
    .withMessage('Page must be a positive integer'),
  query('limit')
    .optional()
    .isInt({ min: 1, max: 100 })
    .withMessage('Limit must be between 1 and 100'),
  query('status')
    .optional()
    .isIn(['active', 'suspended', 'banned'])
    .withMessage('Invalid status'),
  query('role')
    .optional()
    .isIn(['user', 'admin'])
    .withMessage('Invalid role'),
  query('search')
    .optional()
    .trim()
    .isLength({ min: 1, max: 100 })
    .withMessage('Search term must be between 1 and 100 characters')
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

    const {
      page = 1,
      limit = 20,
      status,
      role,
      search
    } = req.query;

    const query = {};
    if (status) query.status = status;
    if (role) query.role = role;

    if (search) {
      query.$or = [
        { email: { $regex: search, $options: 'i' } },
        { 'profile.firstName': { $regex: search, $options: 'i' } },
        { 'profile.lastName': { $regex: search, $options: 'i' } }
      ];
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const [users, total] = await Promise.all([
      User.find(query)
        .select('-password -passwordResetToken -emailVerificationToken -security.twoFactorSecret')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit)),
      User.countDocuments(query)
    ]);

    res.status(200).json({
      status: 'success',
      results: users.length,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit))
      },
      data: {
        users
      }
    });

  } catch (error) {
    console.error('Get users error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Something went wrong while fetching users'
    });
  }
});

// Get single user details
router.get('/users/:id', [
  param('id').isMongoId().withMessage('Invalid user ID')
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

    const user = await User.findById(req.params.id)
      .select('-password -passwordResetToken -emailVerificationToken -security.twoFactorSecret');

    if (!user) {
      return res.status(404).json({
        status: 'error',
        message: 'User not found'
      });
    }

    // Get user's puzzles and transactions
    const [puzzles, transactions] = await Promise.all([
      Puzzle.findByCreator(user._id),
      Transaction.getUserHistory(user._id, 20)
    ]);

    res.status(200).json({
      status: 'success',
      data: {
        user,
        puzzles,
        transactions
      }
    });

  } catch (error) {
    console.error('Get user details error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Something went wrong while fetching user details'
    });
  }
});

// Update user status
router.patch('/users/:id/status', [
  param('id').isMongoId().withMessage('Invalid user ID'),
  body('status')
    .isIn(['active', 'suspended', 'banned'])
    .withMessage('Invalid status'),
  body('reason')
    .optional()
    .trim()
    .isLength({ max: 500 })
    .withMessage('Reason must be less than 500 characters')
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

    const { status, reason } = req.body;

    const user = await User.findById(req.params.id);
    if (!user) {
      return res.status(404).json({
        status: 'error',
        message: 'User not found'
      });
    }

    // Don't allow changing admin status
    if (user.role === 'admin' && req.user._id.toString() !== user._id.toString()) {
      return res.status(403).json({
        status: 'error',
        message: 'Cannot modify other admin accounts'
      });
    }

    user.status = status;
    if (reason) {
      user.adminNotes = user.adminNotes || [];
      user.adminNotes.push({
        action: `Status changed to ${status}`,
        reason,
        adminId: req.user._id,
        timestamp: new Date()
      });
    }

    await user.save();

    res.status(200).json({
      status: 'success',
      message: 'User status updated successfully',
      data: {
        user: {
          _id: user._id,
          email: user.email,
          status: user.status,
          profile: user.profile
        }
      }
    });

  } catch (error) {
    console.error('Update user status error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Something went wrong while updating user status'
    });
  }
});

// Get all puzzles with admin filters
router.get('/puzzles', [
  query('page')
    .optional()
    .isInt({ min: 1 })
    .withMessage('Page must be a positive integer'),
  query('limit')
    .optional()
    .isInt({ min: 1, max: 100 })
    .withMessage('Limit must be between 1 and 100'),
  query('status')
    .optional()
    .isIn(['active', 'suspended', 'deleted'])
    .withMessage('Invalid status'),
  query('solved')
    .optional()
    .isBoolean()
    .withMessage('Solved must be true or false'),
  query('creatorId')
    .optional()
    .isMongoId()
    .withMessage('Invalid creator ID')
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

    const {
      page = 1,
      limit = 20,
      status,
      solved,
      creatorId
    } = req.query;

    const query = {};
    if (status) query.status = status;
    if (solved !== undefined) query.solved = solved === 'true';
    if (creatorId) query.creatorId = creatorId;

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const [puzzles, total] = await Promise.all([
      Puzzle.find(query)
        .populate('creatorId', 'profile.firstName profile.lastName email')
        .populate('solverInfo.solverId', 'profile.firstName profile.lastName email')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(parseInt(limit)),
      Puzzle.countDocuments(query)
    ]);

    res.status(200).json({
      status: 'success',
      results: puzzles.length,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit))
      },
      data: {
        puzzles
      }
    });

  } catch (error) {
    console.error('Get admin puzzles error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Something went wrong while fetching puzzles'
    });
  }
});

// Update puzzle status
router.patch('/puzzles/:id/status', [
  param('id').isMongoId().withMessage('Invalid puzzle ID'),
  body('status')
    .isIn(['active', 'suspended', 'deleted'])
    .withMessage('Invalid status'),
  body('reason')
    .optional()
    .trim()
    .isLength({ max: 500 })
    .withMessage('Reason must be less than 500 characters')
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

    const { status, reason } = req.body;

    const puzzle = await Puzzle.findById(req.params.id)
      .populate('creatorId', 'profile.firstName profile.lastName email');

    if (!puzzle) {
      return res.status(404).json({
        status: 'error',
        message: 'Puzzle not found'
      });
    }

    const oldStatus = puzzle.status;
    puzzle.status = status;

    // Add admin note
    puzzle.adminNotes = puzzle.adminNotes || [];
    puzzle.adminNotes.push({
      action: `Status changed from ${oldStatus} to ${status}`,
      reason,
      adminId: req.user._id,
      timestamp: new Date()
    });

    await puzzle.save();

    res.status(200).json({
      status: 'success',
      message: 'Puzzle status updated successfully',
      data: {
        puzzle: {
          _id: puzzle._id,
          title: puzzle.title,
          status: puzzle.status,
          creatorId: puzzle.creatorId
        }
      }
    });

  } catch (error) {
    console.error('Update puzzle status error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Something went wrong while updating puzzle status'
    });
  }
});

// Get all transactions with admin filters
router.get('/transactions', [
  query('page')
    .optional()
    .isInt({ min: 1 })
    .withMessage('Page must be a positive integer'),
  query('limit')
    .optional()
    .isInt({ min: 1, max: 100 })
    .withMessage('Limit must be between 1 and 100'),
  query('type')
    .optional()
    .isIn(['puzzle_creation', 'puzzle_solve', 'deposit', 'withdrawal', 'admin_fee', 'refund'])
    .withMessage('Invalid transaction type'),
  query('status')
    .optional()
    .isIn(['pending', 'completed', 'failed', 'cancelled', 'refunded'])
    .withMessage('Invalid status'),
  query('userId')
    .optional()
    .isMongoId()
    .withMessage('Invalid user ID')
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

    const {
      page = 1,
      limit = 20,
      type,
      status,
      userId
    } = req.query;

    const query = {};
    if (type) query.type = type;
    if (status) query.status = status;
    if (userId) {
      query.$or = [
        { fromUserId: userId },
        { toUserId: userId }
      ];
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const [transactions, total] = await Promise.all([
      Transaction.find(query)
        .populate('fromUserId', 'profile.firstName profile.lastName email')
        .populate('toUserId', 'profile.firstName profile.lastName email')
        .populate('puzzleId', 'title value')
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
    console.error('Get admin transactions error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Something went wrong while fetching transactions'
    });
  }
});

// Process refund
router.post('/transactions/:id/refund', [
  param('id').isMongoId().withMessage('Invalid transaction ID'),
  body('reason')
    .trim()
    .isLength({ min: 1, max: 500 })
    .withMessage('Refund reason is required and must be less than 500 characters')
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

    const { reason } = req.body;

    const transaction = await Transaction.findById(req.params.id)
      .populate('fromUserId')
      .populate('toUserId');

    if (!transaction) {
      return res.status(404).json({
        status: 'error',
        message: 'Transaction not found'
      });
    }

    if (transaction.status !== 'completed') {
      return res.status(400).json({
        status: 'error',
        message: 'Can only refund completed transactions'
      });
    }

    // Create refund transaction
    const refundTransaction = new Transaction({
      type: 'refund',
      fromUserId: transaction.toUserId?._id,
      toUserId: transaction.fromUserId?._id,
      puzzleId: transaction.puzzleId,
      amount: transaction.amount,
      fees: { adminFee: 0 },
      paymentMethod: { type: 'internal', details: { source: 'admin_refund' } },
      status: 'completed',
      processedAt: new Date(),
      metadata: {
        description: `Admin refund for transaction ${transaction.transactionId}`,
        reason,
        originalTransactionId: transaction.transactionId,
        adminId: req.user._id
      }
    });

    await refundTransaction.save();

    // Update balances
    if (transaction.fromUserId) {
      await transaction.fromUserId.updateBalance(transaction.amount.usd);
    }
    if (transaction.toUserId) {
      await transaction.toUserId.updateBalance(-transaction.amount.usd);
    }

    // Mark original transaction as refunded
    transaction.status = 'refunded';
    transaction.metadata = {
      ...transaction.metadata,
      refundTransactionId: refundTransaction.transactionId,
      refundReason: reason,
      refundedBy: req.user._id,
      refundedAt: new Date()
    };
    await transaction.save();

    res.status(200).json({
      status: 'success',
      message: 'Refund processed successfully',
      data: {
        refundTransaction,
        originalTransaction: transaction
      }
    });

  } catch (error) {
    console.error('Process refund error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Something went wrong while processing refund'
    });
  }
});

// Get platform settings
router.get('/settings', async (req, res) => {
  try {
    // In a real app, these would be stored in database
    const settings = {
      platformFees: {
        adminFee: 1.00,
        withdrawalFees: {
          stripe: 2.50,
          solana: 2.50,
          bitcoin: 5.00
        }
      },
      limits: {
        minDeposit: 1.00,
        maxDeposit: 10000.00,
        minWithdrawal: {
          stripe: 10.00,
          solana: 10.00,
          bitcoin: 25.00
        },
        maxWithdrawal: 50000.00,
        puzzleValue: {
          min: 1.00,
          max: 10000.00
        }
      },
      features: {
        registrationEnabled: true,
        puzzleCreationEnabled: true,
        depositsEnabled: true,
        withdrawalsEnabled: true,
        maintenanceMode: false
      }
    };

    res.status(200).json({
      status: 'success',
      data: {
        settings
      }
    });

  } catch (error) {
    console.error('Get settings error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Something went wrong while fetching settings'
    });
  }
});

// Update platform settings
router.patch('/settings', [
  body('platformFees.adminFee')
    .optional()
    .isFloat({ min: 0, max: 100 })
    .withMessage('Admin fee must be between $0 and $100'),
  body('features.registrationEnabled')
    .optional()
    .isBoolean()
    .withMessage('Registration enabled must be true or false'),
  body('features.maintenanceMode')
    .optional()
    .isBoolean()
    .withMessage('Maintenance mode must be true or false')
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

    // In a real app, you would update these in the database
    // For now, just return success
    res.status(200).json({
      status: 'success',
      message: 'Settings updated successfully',
      data: {
        updatedFields: Object.keys(req.body)
      }
    });

  } catch (error) {
    console.error('Update settings error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Something went wrong while updating settings'
    });
  }
});

module.exports = router;
