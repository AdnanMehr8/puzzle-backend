const mongoose = require('mongoose');

const transactionSchema = new mongoose.Schema({
  transactionId: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  type: {
    type: String,
    enum: ['puzzle_creation', 'puzzle_solve', 'deposit', 'withdrawal', 'admin_fee', 'refund'],
    required: true
  },
  status: {
    type: String,
    enum: ['pending', 'completed', 'failed', 'cancelled', 'refunded'],
    default: 'pending'
  },
  fromUserId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: function() {
      return ['puzzle_creation', 'puzzle_solve', 'withdrawal'].includes(this.type);
    }
  },
  toUserId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: function() {
      return ['puzzle_solve', 'deposit'].includes(this.type);
    }
  },
  puzzleId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Puzzle',
    required: function() {
      return ['puzzle_creation', 'puzzle_solve'].includes(this.type);
    }
  },
  amount: {
    usd: {
      type: Number,
      required: true,
      min: [0, 'Amount cannot be negative']
    },
    crypto: {
      amount: {
        type: Number,
        default: 0
      },
      currency: {
        type: String,
        enum: ['SOL', 'BTC', 'ETH'],
        default: null
      },
      exchangeRate: {
        type: Number,
        default: null
      }
    }
  },
  fees: {
    adminFee: {
      type: Number,
      default: 1 // $1 admin fee
    },
    processingFee: {
      type: Number,
      default: 0
    },
    networkFee: {
      type: Number,
      default: 0
    }
  },
  paymentMethod: {
    type: {
      type: String,
      enum: ['stripe', 'solana', 'bitcoin', 'internal'],
      required: true
    },
    details: {
      type: mongoose.Schema.Types.Mixed,
      required: true
    }
  },
  externalTransactionId: {
    type: String,
    default: null
  },
  blockchainTxHash: {
    type: String,
    default: null
  },
  metadata: {
    ipAddress: String,
    userAgent: String,
    description: String,
    notes: String
  },
  webhookData: {
    type: mongoose.Schema.Types.Mixed,
    default: null
  },
  processedAt: {
    type: Date,
    default: null
  },
  failureReason: {
    type: String,
    default: null
  }
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// Indexes for performance
transactionSchema.index({ fromUserId: 1, createdAt: -1 });
transactionSchema.index({ toUserId: 1, createdAt: -1 });
transactionSchema.index({ puzzleId: 1 });
transactionSchema.index({ status: 1 });
transactionSchema.index({ type: 1 });
transactionSchema.index({ 'paymentMethod.type': 1 });
transactionSchema.index({ externalTransactionId: 1 });
transactionSchema.index({ blockchainTxHash: 1 });

// Compound indexes
transactionSchema.index({ type: 1, status: 1, createdAt: -1 });
transactionSchema.index({ fromUserId: 1, type: 1, status: 1 });

// Virtual for total amount including fees
transactionSchema.virtual('totalAmount').get(function() {
  return this.amount.usd + this.fees.adminFee + this.fees.processingFee + this.fees.networkFee;
});

// Virtual for net amount (excluding fees)
transactionSchema.virtual('netAmount').get(function() {
  if (this.type === 'puzzle_solve') {
    return this.amount.usd; // Solver gets full amount
  }
  return this.amount.usd - this.fees.adminFee - this.fees.processingFee - this.fees.networkFee;
});

// Virtual for processing time
transactionSchema.virtual('processingTime').get(function() {
  if (!this.processedAt) return null;
  return this.processedAt.getTime() - this.createdAt.getTime();
});

// Pre-save middleware to generate transaction ID
transactionSchema.pre('save', function(next) {
  if (!this.transactionId) {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substring(2, 8);
    this.transactionId = `tx_${timestamp}_${random}`.toUpperCase();
  }
  next();
});

// Instance method to mark as completed
transactionSchema.methods.markCompleted = function(externalTxId = null, blockchainTxHash = null) {
  this.status = 'completed';
  this.processedAt = new Date();
  if (externalTxId) this.externalTransactionId = externalTxId;
  if (blockchainTxHash) this.blockchainTxHash = blockchainTxHash;
  return this.save();
};

// Instance method to mark as failed
transactionSchema.methods.markFailed = function(reason) {
  this.status = 'failed';
  this.processedAt = new Date();
  this.failureReason = reason;
  return this.save();
};

// Instance method to add webhook data
transactionSchema.methods.addWebhookData = function(data) {
  this.webhookData = {
    ...this.webhookData,
    ...data,
    receivedAt: new Date()
  };
  return this.save();
};

// Static method to create puzzle creation transaction
transactionSchema.statics.createPuzzleCreation = function(userId, puzzleId, amount, paymentMethod) {
  return new this({
    type: 'puzzle_creation',
    fromUserId: userId,
    puzzleId,
    amount: { usd: amount },
    fees: { adminFee: 1 },
    paymentMethod,
    metadata: {
      description: `Puzzle creation payment for puzzle ${puzzleId}`
    }
  });
};

// Static method to create puzzle solve transaction
transactionSchema.statics.createPuzzleSolve = function(fromUserId, toUserId, puzzleId, amount, paymentMethod) {
  return new this({
    type: 'puzzle_solve',
    fromUserId, // Creator pays solver
    toUserId,   // Solver receives payment
    puzzleId,
    amount: { usd: amount },
    fees: { adminFee: 1 },
    paymentMethod,
    metadata: {
      description: `Puzzle solve reward payment for puzzle ${puzzleId}`
    }
  });
};

// Static method to create admin fee transaction
transactionSchema.statics.createAdminFee = function(fromUserId, amount, relatedTransactionId) {
  return new this({
    type: 'admin_fee',
    fromUserId,
    toUserId: null, // Admin fees go to system
    amount: { usd: amount },
    fees: { adminFee: 0 }, // No fee on fees
    paymentMethod: { type: 'internal', details: { source: 'admin_fee_collection' } },
    metadata: {
      description: `Admin fee collection`,
      relatedTransactionId
    }
  });
};

// Helper method to generate transaction ID
transactionSchema.statics.generateTransactionId = function() {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `tx_${timestamp}_${random}`.toUpperCase();
};

// Static method to create deposit transaction
// transactionSchema.statics.createDeposit = function(userId, amount, paymentMethod, externalTxId) {
//   return new this({
//     type: 'deposit',
//     toUserId: userId,
//     amount: { usd: amount },
//     fees: { processingFee: amount * 0.029 + 0.30 }, // Stripe fees
//     paymentMethod,
//     externalTransactionId: externalTxId,
//     metadata: {
//       description: `Wallet deposit via ${paymentMethod.type}`
//     }
//   });
// };
transactionSchema.statics.createDeposit = function(userId, amount, paymentMethod, externalTxId) {
  // Generate transactionId manually before creating the document
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  const transactionId = `tx_${timestamp}_${random}`.toUpperCase();
  
  return new this({
    transactionId, // Add this line
    type: 'deposit',
    toUserId: userId,
    amount: { usd: amount },
    fees: { processingFee: amount * 0.029 + 0.30 }, // Stripe fees
    paymentMethod,
    externalTransactionId: externalTxId,
    metadata: {
      description: `Wallet deposit via ${paymentMethod.type}`
    }
  });
};

// Static method to create withdrawal transaction
transactionSchema.statics.createWithdrawal = function(userId, amount, paymentMethod) {
  return new this({
    type: 'withdrawal',
    fromUserId: userId,
    amount: { usd: amount },
    fees: { processingFee: 2.50 }, // Flat withdrawal fee
    paymentMethod,
    metadata: {
      description: `Wallet withdrawal to ${paymentMethod.type}`
    }
  });
};

// Static method to get transaction statistics
transactionSchema.statics.getStatistics = async function(startDate = null, endDate = null) {
  const matchStage = { status: 'completed' };
  if (startDate || endDate) {
    matchStage.createdAt = {};
    if (startDate) matchStage.createdAt.$gte = startDate;
    if (endDate) matchStage.createdAt.$lte = endDate;
  }

  const stats = await this.aggregate([
    { $match: matchStage },
    {
      $group: {
        _id: '$type',
        count: { $sum: 1 },
        totalAmount: { $sum: '$amount.usd' },
        totalFees: { $sum: '$fees.adminFee' },
        avgAmount: { $avg: '$amount.usd' }
      }
    }
  ]);

  const summary = await this.aggregate([
    { $match: matchStage },
    {
      $group: {
        _id: null,
        totalTransactions: { $sum: 1 },
        totalVolume: { $sum: '$amount.usd' },
        totalAdminFees: { $sum: '$fees.adminFee' },
        totalProcessingFees: { $sum: '$fees.processingFee' }
      }
    }
  ]);

  return {
    byType: stats,
    summary: summary[0] || {
      totalTransactions: 0,
      totalVolume: 0,
      totalAdminFees: 0,
      totalProcessingFees: 0
    }
  };
};

// Static method to get user transaction history
transactionSchema.statics.getUserHistory = function(userId, limit = 50, offset = 0) {
  return this.find({
    $or: [
      { fromUserId: userId },
      { toUserId: userId }
    ]
  })
  .sort({ createdAt: -1 })
  .limit(limit)
  .skip(offset)
  .populate('puzzleId', 'title value')
  .populate('fromUserId', 'profile.firstName profile.lastName')
  .populate('toUserId', 'profile.firstName profile.lastName');
};

module.exports = mongoose.model('Transaction', transactionSchema);
