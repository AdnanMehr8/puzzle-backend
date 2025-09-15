const express = require('express');
const Puzzle = require('../models/Puzzle');
const User = require('../models/User');
const Transaction = require('../models/Transaction');
const { 
  protect, 
  optionalAuth, 
  validateOwnership, 
  sensitiveRateLimit 
} = require('../middleware/auth');
const { body, param, query, validationResult } = require('express-validator');
const rateLimit = require('express-rate-limit');

const router = express.Router();

// Rate limiting for puzzle creation
const createPuzzleLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5, // limit each user to 5 puzzle creations per hour
  message: {
    status: 'error',
    message: 'Too many puzzles created. Please try again later.'
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Rate limiting for puzzle attempts
const attemptLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // limit each IP to 10 attempts per 15 minutes
  message: {
    status: 'error',
    message: 'Too many puzzle attempts. Please try again later.'
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// Validation middleware
const createPuzzleValidation = [
  body('title')
    .trim()
    .isLength({ min: 1, max: 200 })
    .withMessage('Title is required and must be less than 200 characters'),
  body('description')
    .trim()
    .isLength({ min: 1, max: 1000 })
    .withMessage('Description is required and must be less than 1000 characters'),
  body('clue')
    .trim()
    .isLength({ min: 1, max: 2000 })
    .withMessage('Clue is required and must be less than 2000 characters'),
  body('answer')
    .trim()
    .isLength({ min: 1, max: 100 })
    .withMessage('Answer is required and must be less than 100 characters'),
  body('inheritance')
    .trim()
    .isLength({ min: 1, max: 1000 })
    .withMessage('Inheritance description is required and must be less than 1000 characters'),
  body('value')
    .isFloat({ min: 1, max: 10000 })
    .withMessage('Value must be between $1 and $10,000'),
  body('category')
    .optional()
    .isIn(['social-media', 'crypto', 'gaming', 'music', 'art', 'tech', 'personal', 'other'])
    .withMessage('Invalid category'),
  body('difficulty')
    .optional()
    .isIn(['easy', 'medium', 'hard', 'expert'])
    .withMessage('Invalid difficulty level'),
  body('tags')
    .optional()
    .isArray({ max: 10 })
    .withMessage('Tags must be an array with maximum 10 items'),
  body('expiresAt')
    .optional()
    .isISO8601()
    .toDate()
    .withMessage('Invalid expiration date')
];

const solvePuzzleValidation = [
  param('id')
    .isMongoId()
    .withMessage('Invalid puzzle ID'),
  body('answer')
    .trim()
    .isLength({ min: 1, max: 100 })
    .withMessage('Answer is required and must be less than 100 characters')
];

// Get all puzzles (public route with optional auth)
router.get('/', optionalAuth, [
  query('page')
    .optional()
    .isInt({ min: 1 })
    .withMessage('Page must be a positive integer'),
  query('limit')
    .optional()
    .isInt({ min: 1, max: 50 })
    .withMessage('Limit must be between 1 and 50'),
  query('category')
    .optional()
    .isIn(['social-media', 'crypto', 'gaming', 'music', 'art', 'tech', 'personal', 'other'])
    .withMessage('Invalid category'),
  query('difficulty')
    .optional()
    .isIn(['easy', 'medium', 'hard', 'expert'])
    .withMessage('Invalid difficulty'),
  query('solved')
    .optional()
    .isBoolean()
    .withMessage('Solved must be true or false'),
  query('minValue')
    .optional()
    .isFloat({ min: 0 })
    .withMessage('Minimum value must be a positive number'),
  query('maxValue')
    .optional()
    .isFloat({ min: 0 })
    .withMessage('Maximum value must be a positive number'),
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
      category,
      difficulty,
      solved,
      minValue,
      maxValue,
      search
    } = req.query;

    // Build query
    const query = { status: 'active' };
    
    // Add expiration filter
    query.$or = [
      { expiresAt: null },
      { expiresAt: { $gt: new Date() } }
    ];

    if (category) query.category = category;
    if (difficulty) query.difficulty = difficulty;
    if (solved !== undefined) query.solved = solved === 'true';
    
    if (minValue || maxValue) {
      query.value = {};
      if (minValue) query.value.$gte = parseFloat(minValue);
      if (maxValue) query.value.$lte = parseFloat(maxValue);
    }

    if (search) {
      query.$and = [
        query.$and || {},
        {
          $or: [
            { title: { $regex: search, $options: 'i' } },
            { description: { $regex: search, $options: 'i' } },
            { tags: { $in: [new RegExp(search, 'i')] } }
          ]
        }
      ];
    }

    const skip = (parseInt(page) - 1) * parseInt(limit);

    const [puzzles, total] = await Promise.all([
      Puzzle.find(query)
        .populate('creatorId', 'profile.firstName profile.lastName')
        .populate('solverInfo.solverId', 'profile.firstName profile.lastName')
        .select('-answer') // Never return the answer
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
    console.error('Get puzzles error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Something went wrong while fetching puzzles'
    });
  }
});

// Get trending puzzles
router.get('/trending', async (req, res) => {
  try {
    const puzzles = await Puzzle.getTrending(10);

    res.status(200).json({
      status: 'success',
      results: puzzles.length,
      data: {
        puzzles
      }
    });

  } catch (error) {
    console.error('Get trending puzzles error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Something went wrong while fetching trending puzzles'
    });
  }
});

// Get puzzle statistics
router.get('/statistics', async (req, res) => {
  try {
    const stats = await Puzzle.getStatistics();

    res.status(200).json({
      status: 'success',
      data: {
        statistics: stats
      }
    });

  } catch (error) {
    console.error('Get puzzle statistics error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Something went wrong while fetching statistics'
    });
  }
});

// Get single puzzle by ID
router.get('/:id', optionalAuth, [
  param('id').isMongoId().withMessage('Invalid puzzle ID')
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

    const puzzle = await Puzzle.findOne({
      _id: req.params.id,
      status: 'active'
    })
      .populate('creatorId', 'profile.firstName profile.lastName')
      .populate('solverInfo.solverId', 'profile.firstName profile.lastName')
      .select('-answer'); // Never return the answer

    if (!puzzle) {
      return res.status(404).json({
        status: 'error',
        message: 'Puzzle not found'
      });
    }

    // Check if puzzle has expired
    if (puzzle.expiresAt && puzzle.expiresAt < new Date()) {
      return res.status(410).json({
        status: 'error',
        message: 'This puzzle has expired'
      });
    }

    // Add view (if user is authenticated, use user ID, otherwise use IP)
    const userId = req.user ? req.user._id : null;
    const ipAddress = req.ip || req.connection.remoteAddress;
    
    await puzzle.addView(userId, ipAddress);

    res.status(200).json({
      status: 'success',
      data: {
        puzzle
      }
    });

  } catch (error) {
    console.error('Get puzzle error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Something went wrong while fetching puzzle'
    });
  }
});

// Create new puzzle
router.post('/', protect, createPuzzleLimiter, createPuzzleValidation, async (req, res) => {
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
      title,
      description,
      clue,
      answer,
      inheritance,
      value,
      category = 'other',
      difficulty = 'medium',
      tags = [],
      expiresAt
    } = req.body;

    // Check if user has sufficient balance (value + $1 admin fee)
    const totalCost = parseFloat(value) + 1; // $1 admin fee
    if (req.user.wallet.balance < totalCost) {
      return res.status(400).json({
        status: 'error',
        message: `Insufficient balance. You need $${totalCost} to create this puzzle (puzzle value: $${value} + admin fee: $1)`
      });
    }

    // Create puzzle
    const puzzle = new Puzzle({
      title,
      description,
      clue,
      answer,
      inheritance,
      value: parseFloat(value),
      creatorId: req.user._id,
      category,
      difficulty,
      tags: tags.map(tag => tag.toLowerCase().trim()),
      expiresAt
    });

    await puzzle.save();

    // Deduct cost from user's balance
    await req.user.updateBalance(-totalCost);

    // Create transaction record
    const transaction = Transaction.createPuzzleCreation(
      req.user._id,
      puzzle._id,
      parseFloat(value),
      { type: 'internal', details: { source: 'wallet_balance' } }
    );
    
    transaction.status = 'completed';
    transaction.processedAt = new Date();
    await transaction.save();

    // Create admin fee transaction
    const adminFeeTransaction = Transaction.createAdminFee(
      req.user._id,
      1,
      transaction.transactionId
    );
    adminFeeTransaction.status = 'completed';
    adminFeeTransaction.processedAt = new Date();
    await adminFeeTransaction.save();

    // Populate creator info for response
    await puzzle.populate('creatorId', 'profile.firstName profile.lastName');

    res.status(201).json({
      status: 'success',
      message: 'Puzzle created successfully',
      data: {
        puzzle: {
          ...puzzle.toObject(),
          answer: undefined // Don't return answer even to creator
        },
        transaction: {
          id: transaction.transactionId,
          amount: totalCost,
          newBalance: req.user.wallet.balance
        }
      }
    });

  } catch (error) {
    console.error('Create puzzle error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Something went wrong while creating puzzle'
    });
  }
});

// Solve puzzle
router.post('/:id/solve', protect, attemptLimiter, solvePuzzleValidation, async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({
        status: 'error',
        message: 'Validation failed',
        errors: errors.array()
      });
    }

    const { answer } = req.body;
    const puzzleId = req.params.id;

    // Find puzzle with answer
    const puzzle = await Puzzle.findOne({
      _id: puzzleId,
      status: 'active'
    }).select('+answer').populate('creatorId', 'profile.firstName profile.lastName wallet.balance');

    if (!puzzle) {
      return res.status(404).json({
        status: 'error',
        message: 'Puzzle not found'
      });
    }

    // Check if puzzle has expired
    if (puzzle.expiresAt && puzzle.expiresAt < new Date()) {
      return res.status(410).json({
        status: 'error',
        message: 'This puzzle has expired'
      });
    }

    // Check if puzzle is already solved
    if (puzzle.solved) {
      return res.status(400).json({
        status: 'error',
        message: 'This puzzle has already been solved'
      });
    }

    // Check if user is trying to solve their own puzzle
    if (puzzle.creatorId._id.toString() === req.user._id.toString()) {
      return res.status(400).json({
        status: 'error',
        message: 'You cannot solve your own puzzle'
      });
    }

    // Add attempt
    const ipAddress = req.ip || req.connection.remoteAddress;
    const { isCorrect, attempt } = puzzle.addAttempt(req.user._id, answer, ipAddress);

    await puzzle.save();

    if (isCorrect) {
      // Update solver info with user name
      puzzle.solverInfo.solverName = `${req.user.profile.firstName} ${req.user.profile.lastName}`;
      await puzzle.save();

      // Transfer money from creator to solver
      await req.user.updateBalance(puzzle.value); // Add to solver
      await puzzle.creatorId.updateBalance(-puzzle.value); // Deduct from creator

      // Create solve transaction
      const transaction = Transaction.createPuzzleSolve(
        puzzle.creatorId._id,
        req.user._id,
        puzzle._id,
        puzzle.value,
        { type: 'internal', details: { source: 'puzzle_solve' } }
      );
      
      transaction.status = 'completed';
      transaction.processedAt = new Date();
      await transaction.save();

      // Update puzzle payment status
      puzzle.payment.payoutProcessed = true;
      await puzzle.save();

      res.status(200).json({
        status: 'success',
        message: 'Congratulations! You solved the puzzle!',
        data: {
          puzzle: {
            ...puzzle.toObject(),
            answer: undefined // Don't return answer in response
          },
          reward: puzzle.value,
          inheritance: puzzle.inheritance,
          transaction: {
            id: transaction.transactionId,
            amount: puzzle.value,
            newBalance: req.user.wallet.balance
          }
        }
      });

    } else {
      res.status(200).json({
        status: 'success',
        message: 'Incorrect answer. Try again!',
        data: {
          isCorrect: false,
          attemptsCount: puzzle.attempts.filter(a => a.userId.toString() === req.user._id.toString()).length,
          totalAttempts: puzzle.analytics.totalAttempts
        }
      });
    }

  } catch (error) {
    console.error('Solve puzzle error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Something went wrong while solving puzzle'
    });
  }
});

// Get user's puzzles
router.get('/user/my-puzzles', protect, [
  query('status')
    .optional()
    .isIn(['active', 'suspended', 'deleted'])
    .withMessage('Invalid status'),
  query('solved')
    .optional()
    .isBoolean()
    .withMessage('Solved must be true or false')
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

    const { status, solved } = req.query;
    const query = { creatorId: req.user._id };
    
    if (status) query.status = status;
    if (solved !== undefined) query.solved = solved === 'true';

    const puzzles = await Puzzle.find(query)
      .populate('solverInfo.solverId', 'profile.firstName profile.lastName')
      .select('-answer') // Don't return answers even to creator
      .sort({ createdAt: -1 });

    res.status(200).json({
      status: 'success',
      results: puzzles.length,
      data: {
        puzzles
      }
    });

  } catch (error) {
    console.error('Get user puzzles error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Something went wrong while fetching your puzzles'
    });
  }
});

// Update puzzle (only creator or admin)
router.patch('/:id', protect, [
  param('id').isMongoId().withMessage('Invalid puzzle ID'),
  body('title')
    .optional()
    .trim()
    .isLength({ min: 1, max: 200 })
    .withMessage('Title must be less than 200 characters'),
  body('description')
    .optional()
    .trim()
    .isLength({ min: 1, max: 1000 })
    .withMessage('Description must be less than 1000 characters'),
  body('clue')
    .optional()
    .trim()
    .isLength({ min: 1, max: 2000 })
    .withMessage('Clue must be less than 2000 characters')
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

    const puzzle = await Puzzle.findById(req.params.id);
    
    if (!puzzle) {
      return res.status(404).json({
        status: 'error',
        message: 'Puzzle not found'
      });
    }

    // Check ownership (creator or admin)
    if (puzzle.creatorId.toString() !== req.user._id.toString() && req.user.role !== 'admin') {
      return res.status(403).json({
        status: 'error',
        message: 'You can only update your own puzzles'
      });
    }

    // Don't allow updates if puzzle is solved
    if (puzzle.solved) {
      return res.status(400).json({
        status: 'error',
        message: 'Cannot update a solved puzzle'
      });
    }

    // Only allow certain fields to be updated
    const allowedFields = ['title', 'description', 'clue', 'tags'];
    const updates = {};
    
    allowedFields.forEach(field => {
      if (req.body[field] !== undefined) {
        updates[field] = req.body[field];
      }
    });

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({
        status: 'error',
        message: 'No valid fields to update'
      });
    }

    const updatedPuzzle = await Puzzle.findByIdAndUpdate(
      req.params.id,
      updates,
      { new: true, runValidators: true }
    ).populate('creatorId', 'profile.firstName profile.lastName');

    res.status(200).json({
      status: 'success',
      message: 'Puzzle updated successfully',
      data: {
        puzzle: {
          ...updatedPuzzle.toObject(),
          answer: undefined // Don't return answer
        }
      }
    });

  } catch (error) {
    console.error('Update puzzle error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Something went wrong while updating puzzle'
    });
  }
});

// Delete puzzle (only creator or admin)
router.delete('/:id', protect, [
  param('id').isMongoId().withMessage('Invalid puzzle ID')
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

    const puzzle = await Puzzle.findById(req.params.id);
    
    if (!puzzle) {
      return res.status(404).json({
        status: 'error',
        message: 'Puzzle not found'
      });
    }

    // Check ownership (creator or admin)
    if (puzzle.creatorId.toString() !== req.user._id.toString() && req.user.role !== 'admin') {
      return res.status(403).json({
        status: 'error',
        message: 'You can only delete your own puzzles'
      });
    }

    // Don't allow deletion if puzzle is solved
    if (puzzle.solved) {
      return res.status(400).json({
        status: 'error',
        message: 'Cannot delete a solved puzzle'
      });
    }

    // Soft delete - mark as deleted instead of removing
    puzzle.status = 'deleted';
    await puzzle.save();

    // Refund the creator (puzzle value + admin fee)
    const refundAmount = puzzle.value + 1;
    await req.user.updateBalance(refundAmount);

    // Create refund transaction
    const transaction = new Transaction({
      type: 'refund',
      toUserId: req.user._id,
      puzzleId: puzzle._id,
      amount: { usd: refundAmount },
      fees: { adminFee: 0 },
      paymentMethod: { type: 'internal', details: { source: 'puzzle_deletion_refund' } },
      status: 'completed',
      processedAt: new Date(),
      metadata: {
        description: `Refund for deleted puzzle: ${puzzle.title}`
      }
    });
    await transaction.save();

    res.status(200).json({
      status: 'success',
      message: 'Puzzle deleted successfully and refund processed',
      data: {
        refund: {
          amount: refundAmount,
          transactionId: transaction.transactionId,
          newBalance: req.user.wallet.balance
        }
      }
    });

  } catch (error) {
    console.error('Delete puzzle error:', error);
    res.status(500).json({
      status: 'error',
      message: 'Something went wrong while deleting puzzle'
    });
  }
});

module.exports = router;
