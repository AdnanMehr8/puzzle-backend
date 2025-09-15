const mongoose = require('mongoose');

const puzzleSchema = new mongoose.Schema({
  title: {
    type: String,
    required: [true, 'Puzzle title is required'],
    trim: true,
    maxlength: [200, 'Title cannot exceed 200 characters']
  },
  description: {
    type: String,
    required: [true, 'Puzzle description is required'],
    trim: true,
    maxlength: [1000, 'Description cannot exceed 1000 characters']
  },
  clue: {
    type: String,
    required: [true, 'Puzzle clue is required'],
    trim: true,
    maxlength: [2000, 'Clue cannot exceed 2000 characters']
  },
  answer: {
    type: String,
    required: [true, 'Puzzle answer is required'],
    trim: true,
    select: false // Never return the answer in queries
  },
  inheritance: {
    type: String,
    required: [true, 'Inheritance description is required'],
    trim: true,
    maxlength: [1000, 'Inheritance description cannot exceed 1000 characters']
  },
  value: {
    type: Number,
    required: [true, 'Puzzle value is required'],
    min: [1, 'Puzzle value must be at least $1'],
    max: [10000, 'Puzzle value cannot exceed $10,000']
  },
  creatorId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  solved: {
    type: Boolean,
    default: false
  },
  solverInfo: {
    solverId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null
    },
    solverName: {
      type: String,
      default: null
    },
    solvedAt: {
      type: Date,
      default: null
    },
    attempts: {
      type: Number,
      default: 0
    }
  },
  attempts: [{
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true
    },
    answer: {
      type: String,
      required: true
    },
    isCorrect: {
      type: Boolean,
      required: true
    },
    attemptedAt: {
      type: Date,
      default: Date.now
    },
    ipAddress: {
      type: String,
      required: true
    }
  }],
  analytics: {
    views: {
      type: Number,
      default: 0
    },
    uniqueViews: [{
      userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
      },
      ipAddress: String,
      viewedAt: {
        type: Date,
        default: Date.now
      }
    }],
    shares: {
      type: Number,
      default: 0
    },
    totalAttempts: {
      type: Number,
      default: 0
    }
  },
  payment: {
    transactionId: {
      type: String,
      default: null
    },
    paymentMethod: {
      type: String,
      enum: ['stripe', 'solana', 'bitcoin'],
      default: null
    },
    adminFeeCollected: {
      type: Boolean,
      default: false
    },
    payoutProcessed: {
      type: Boolean,
      default: false
    }
  },
  status: {
    type: String,
    enum: ['active', 'suspended', 'deleted'],
    default: 'active'
  },
  tags: [{
    type: String,
    trim: true,
    lowercase: true
  }],
  difficulty: {
    type: String,
    enum: ['easy', 'medium', 'hard', 'expert'],
    default: 'medium'
  },
  category: {
    type: String,
    enum: ['social-media', 'crypto', 'gaming', 'music', 'art', 'tech', 'personal', 'other'],
    default: 'other'
  },
  expiresAt: {
    type: Date,
    default: null // Puzzles can optionally expire
  }
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// Indexes for performance
puzzleSchema.index({ creatorId: 1 });
puzzleSchema.index({ solved: 1 });
puzzleSchema.index({ createdAt: -1 });
puzzleSchema.index({ value: -1 });
puzzleSchema.index({ category: 1 });
puzzleSchema.index({ difficulty: 1 });
puzzleSchema.index({ status: 1 });
puzzleSchema.index({ expiresAt: 1 });

// Compound indexes
puzzleSchema.index({ solved: 1, status: 1, createdAt: -1 });
puzzleSchema.index({ creatorId: 1, solved: 1 });

// Virtual for puzzle age
puzzleSchema.virtual('age').get(function() {
  return Date.now() - this.createdAt.getTime();
});

// Virtual for time remaining (if expires)
puzzleSchema.virtual('timeRemaining').get(function() {
  if (!this.expiresAt) return null;
  const remaining = this.expiresAt.getTime() - Date.now();
  return remaining > 0 ? remaining : 0;
});

// Virtual for success rate
puzzleSchema.virtual('successRate').get(function() {
  if (this.analytics.totalAttempts === 0) return 0;
  return this.solved ? (1 / this.analytics.totalAttempts) * 100 : 0;
});

// Pre-save middleware to update total attempts
puzzleSchema.pre('save', function(next) {
  if (this.isModified('attempts')) {
    this.analytics.totalAttempts = this.attempts.length;
  }
  next();
});

// Instance method to add attempt
puzzleSchema.methods.addAttempt = function(userId, answer, ipAddress) {
  const isCorrect = answer.toLowerCase().trim() === this.answer.toLowerCase().trim();
  
  const attempt = {
    userId,
    answer: answer.trim(),
    isCorrect,
    ipAddress,
    attemptedAt: new Date()
  };
  
  this.attempts.push(attempt);
  this.analytics.totalAttempts = this.attempts.length;
  
  if (isCorrect && !this.solved) {
    this.solved = true;
    this.solverInfo = {
      solverId: userId,
      solvedAt: new Date(),
      attempts: this.attempts.filter(a => a.userId.toString() === userId.toString()).length
    };
  }
  
  return { isCorrect, attempt };
};

// Instance method to add view
puzzleSchema.methods.addView = function(userId = null, ipAddress) {
  // Check if this is a unique view
  const existingView = this.analytics.uniqueViews.find(view => {
    if (userId) {
      return view.userId && view.userId.toString() === userId.toString();
    }
    return view.ipAddress === ipAddress;
  });
  
  if (!existingView) {
    this.analytics.uniqueViews.push({
      userId,
      ipAddress,
      viewedAt: new Date()
    });
  }
  
  this.analytics.views += 1;
  return this.save();
};

// Instance method to increment shares
puzzleSchema.methods.incrementShares = function() {
  this.analytics.shares += 1;
  return this.save();
};

// Static method to find active puzzles
puzzleSchema.statics.findActive = function(filters = {}) {
  return this.find({
    status: 'active',
    $or: [
      { expiresAt: null },
      { expiresAt: { $gt: new Date() } }
    ],
    ...filters
  });
};

// Static method to find unsolved puzzles
puzzleSchema.statics.findUnsolved = function(filters = {}) {
  return this.findActive({
    solved: false,
    ...filters
  });
};

// Static method to find by creator
puzzleSchema.statics.findByCreator = function(creatorId, includeDeleted = false) {
  const query = { creatorId };
  if (!includeDeleted) {
    query.status = { $ne: 'deleted' };
  }
  return this.find(query).sort({ createdAt: -1 });
};

// Static method to get puzzle statistics
puzzleSchema.statics.getStatistics = async function() {
  const stats = await this.aggregate([
    {
      $group: {
        _id: null,
        totalPuzzles: { $sum: 1 },
        solvedPuzzles: {
          $sum: { $cond: [{ $eq: ['$solved', true] }, 1, 0] }
        },
        totalValue: { $sum: '$value' },
        averageValue: { $avg: '$value' },
        totalViews: { $sum: '$analytics.views' },
        totalAttempts: { $sum: '$analytics.totalAttempts' }
      }
    }
  ]);
  
  return stats[0] || {
    totalPuzzles: 0,
    solvedPuzzles: 0,
    totalValue: 0,
    averageValue: 0,
    totalViews: 0,
    totalAttempts: 0
  };
};

// Static method to get trending puzzles
puzzleSchema.statics.getTrending = function(limit = 10) {
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  
  return this.findActive({
    createdAt: { $gte: oneDayAgo }
  })
  .sort({ 'analytics.views': -1, 'analytics.totalAttempts': -1 })
  .limit(limit)
  .populate('creatorId', 'profile.firstName profile.lastName');
};

module.exports = mongoose.model('Puzzle', puzzleSchema);
