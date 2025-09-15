const express = require('express');
const { protect } = require('../middleware/auth');
const { param, query, validationResult } = require('express-validator');
const Transaction = require('../models/Transaction');

const router = express.Router();

// Get user's transaction history
router.get('/', protect, async (req, res) => {
  try {
    const { page = 1, limit = 20, type, status } = req.query;
    
    const filter = {
      $or: [
        { fromUserId: req.user._id },
        { toUserId: req.user._id }
      ]
    };
    
    if (type) filter.type = type;
    if (status) filter.status = status;
    
    const options = {
      page: parseInt(page),
      limit: parseInt(limit),
      sort: { createdAt: -1 },
      populate: [
        { path: 'fromUserId', select: 'username email' },
        { path: 'toUserId', select: 'username email' }
      ]
    };
    
    const transactions = await Transaction.paginate(filter, options);
    
    res.json({
      status: 'success',
      data: {
        transactions: transactions.docs,
        pagination: {
          page: transactions.page,
          pages: transactions.totalPages,
          total: transactions.totalDocs,
          limit: transactions.limit
        }
      }
    });
  } catch (error) {
    console.error('Get transactions error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Failed to fetch transactions'
    });
  }
});

// Get specific transaction by ID
router.get('/:id', protect, [
  param('id').isMongoId().withMessage('Invalid transaction ID')
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
      _id: req.params.id,
      $or: [
        { fromUserId: req.user._id },
        { toUserId: req.user._id }
      ]
    }).populate([
      { path: 'fromUserId', select: 'username email' },
      { path: 'toUserId', select: 'username email' }
    ]);

    if (!transaction) {
      return res.status(404).json({
        status: 'error',
        message: 'Transaction not found'
      });
    }

    res.json({
      status: 'success',
      data: { transaction }
    });
  } catch (error) {
    console.error('Get transaction error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Failed to fetch transaction'
    });
  }
});

// Get transaction statistics for user
router.get('/stats/summary', protect, async (req, res) => {
  try {
    const userId = req.user._id;
    
    // Get transaction counts and totals
    const stats = await Transaction.aggregate([
      {
        $match: {
          $or: [
            { fromUserId: userId },
            { toUserId: userId }
          ]
        }
      },
      {
        $group: {
          _id: '$type',
          count: { $sum: 1 },
          totalAmount: { $sum: '$amount.usd' },
          completedCount: {
            $sum: { $cond: [{ $eq: ['$status', 'completed'] }, 1, 0] }
          },
          completedAmount: {
            $sum: { $cond: [{ $eq: ['$status', 'completed'] }, '$amount.usd', 0] }
          }
        }
      }
    ]);

    // Get recent transactions
    const recentTransactions = await Transaction.find({
      $or: [
        { fromUserId: userId },
        { toUserId: userId }
      ]
    })
    .sort({ createdAt: -1 })
    .limit(5)
    .populate([
      { path: 'fromUserId', select: 'username email' },
      { path: 'toUserId', select: 'username email' }
    ]);

    res.json({
      status: 'success',
      data: {
        stats,
        recentTransactions
      }
    });
  } catch (error) {
    console.error('Get transaction stats error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Failed to fetch transaction statistics'
    });
  }
});

module.exports = router;
