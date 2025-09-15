const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema({
  email: {
    type: String,
    required: [true, 'Email is required'],
    unique: true,
    lowercase: true,
    trim: true,
    match: [/^\w+([.-]?\w+)*@\w+([.-]?\w+)*(\.\w{2,3})+$/, 'Please enter a valid email']
  },
  password: {
    type: String,
    required: [true, 'Password is required'],
    minlength: [6, 'Password must be at least 6 characters'],
    select: false
  },
  role: {
    type: String,
    enum: ['user', 'admin'],
    default: 'user'
  },
  profile: {
    firstName: {
      type: String,
      required: [true, 'First name is required'],
      trim: true,
      maxlength: [50, 'First name cannot exceed 50 characters']
    },
    lastName: {
      type: String,
      required: [true, 'Last name is required'],
      trim: true,
      maxlength: [50, 'Last name cannot exceed 50 characters']
    },
    bio: {
      type: String,
      maxlength: [500, 'Bio cannot exceed 500 characters'],
      trim: true
    },
    avatar: {
      type: String,
      default: null
    }
  },
  wallet: {
    balance: {
      type: Number,
      default: 0,
      min: [0, 'Balance cannot be negative']
    },
    cryptoBalances: {
      solana: {
        type: Number,
        default: 0,
        min: [0, 'Solana balance cannot be negative']
      },
      bitcoin: {
        type: Number,
        default: 0,
        min: [0, 'Bitcoin balance cannot be negative']
      }
    },
    totalEarnings: {
      type: Number,
      default: 0,
      min: [0, 'Total earnings cannot be negative']
    },
    totalSpent: {
      type: Number,
      default: 0,
      min: [0, 'Total spent cannot be negative']
    }
  },
  paymentMethods: [{
    id: {
      type: String,
      required: true
    },
    type: {
      type: String,
      enum: ['stripe', 'solana', 'bitcoin'],
      required: true
    },
    details: {
      type: mongoose.Schema.Types.Mixed,
      required: true
    },
    isDefault: {
      type: Boolean,
      default: false
    },
    isVerified: {
      type: Boolean,
      default: false
    },
    createdAt: {
      type: Date,
      default: Date.now
    }
  }],
  security: {
    lastLogin: {
      type: Date,
      default: null
    },
    loginAttempts: {
      type: Number,
      default: 0
    },
    lockUntil: {
      type: Date,
      default: null
    },
    twoFactorEnabled: {
      type: Boolean,
      default: false
    },
    twoFactorSecret: {
      type: String,
      select: false
    }
  },
  preferences: {
    emailNotifications: {
      type: Boolean,
      default: true
    },
    marketingEmails: {
      type: Boolean,
      default: false
    },
    currency: {
      type: String,
      enum: ['USD', 'EUR', 'GBP'],
      default: 'USD'
    }
  },
  status: {
    type: String,
    enum: ['active', 'suspended', 'banned'],
    default: 'active'
  },
  emailVerified: {
    type: Boolean,
    default: false
  },
  emailVerificationToken: {
    type: String,
    select: false
  },
  passwordResetToken: {
    type: String,
    select: false
  },
  passwordResetExpires: {
    type: Date,
    select: false
  }
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// Indexes for performance
userSchema.index({ email: 1 });
userSchema.index({ 'security.lastLogin': -1 });
userSchema.index({ createdAt: -1 });
userSchema.index({ role: 1 });

// Virtual for full name
userSchema.virtual('profile.fullName').get(function() {
  return `${this.profile.firstName} ${this.profile.lastName}`;
});

// Virtual for account locked status
userSchema.virtual('security.isLocked').get(function() {
  return !!(this.security.lockUntil && this.security.lockUntil > Date.now());
});

// Pre-save middleware to hash password
userSchema.pre('save', async function(next) {
  // Only hash the password if it has been modified (or is new)
  if (!this.isModified('password')) return next();
  
  try {
    // Hash password with cost of 12
    const salt = await bcrypt.genSalt(parseInt(process.env.BCRYPT_ROUNDS) || 12);
    this.password = await bcrypt.hash(this.password, salt);
    next();
  } catch (error) {
    next(error);
  }
});

// Pre-save middleware to ensure only one default payment method
userSchema.pre('save', function(next) {
  if (this.isModified('paymentMethods')) {
    const defaultMethods = this.paymentMethods.filter(method => method.isDefault);
    if (defaultMethods.length > 1) {
      // Keep only the first default method
      this.paymentMethods.forEach((method, index) => {
        if (index > 0 && method.isDefault) {
          method.isDefault = false;
        }
      });
    }
  }
  next();
});

// Instance method to check password
userSchema.methods.comparePassword = async function(candidatePassword) {
  if (!this.password) return false;
  return bcrypt.compare(candidatePassword, this.password);
};

// Instance method to increment login attempts
userSchema.methods.incLoginAttempts = function() {
  // If we have a previous lock that has expired, restart at 1
  if (this.security.lockUntil && this.security.lockUntil < Date.now()) {
    return this.updateOne({
      $unset: { 'security.lockUntil': 1 },
      $set: { 'security.loginAttempts': 1 }
    });
  }
  
  const updates = { $inc: { 'security.loginAttempts': 1 } };
  
  // If we're at max attempts and not locked, lock account
  if (this.security.loginAttempts + 1 >= 5 && !this.security.isLocked) {
    updates.$set = { 'security.lockUntil': Date.now() + 2 * 60 * 60 * 1000 }; // 2 hours
  }
  
  return this.updateOne(updates);
};

// Instance method to reset login attempts
userSchema.methods.resetLoginAttempts = function() {
  return this.updateOne({
    $unset: { 
      'security.loginAttempts': 1,
      'security.lockUntil': 1
    },
    $set: {
      'security.lastLogin': new Date()
    }
  });
};

// Instance method to add payment method
userSchema.methods.addPaymentMethod = function(type, details, isDefault = false) {
  const paymentMethod = {
    id: new mongoose.Types.ObjectId().toString(),
    type,
    details,
    isDefault: isDefault || this.paymentMethods.length === 0, // First method is default
    isVerified: type === 'stripe' // Stripe methods are auto-verified
  };
  
  // If this is set as default, unset others
  if (paymentMethod.isDefault) {
    this.paymentMethods.forEach(method => {
      method.isDefault = false;
    });
  }
  
  this.paymentMethods.push(paymentMethod);
  return this.save();
};

// Instance method to remove payment method
userSchema.methods.removePaymentMethod = function(methodId) {
  const methodIndex = this.paymentMethods.findIndex(method => method.id === methodId);
  if (methodIndex === -1) {
    throw new Error('Payment method not found');
  }
  
  const wasDefault = this.paymentMethods[methodIndex].isDefault;
  this.paymentMethods.splice(methodIndex, 1);
  
  // If we removed the default method, make the first remaining method default
  if (wasDefault && this.paymentMethods.length > 0) {
    this.paymentMethods[0].isDefault = true;
  }
  
  return this.save();
};

// Instance method to update wallet balance
userSchema.methods.updateBalance = function(amount, type = 'usd') {
  if (type === 'usd') {
    this.wallet.balance += amount;
    if (amount > 0) {
      this.wallet.totalEarnings += amount;
    } else {
      this.wallet.totalSpent += Math.abs(amount);
    }
  } else if (type === 'solana') {
    this.wallet.cryptoBalances.solana += amount;
  } else if (type === 'bitcoin') {
    this.wallet.cryptoBalances.bitcoin += amount;
  }
  
  return this.save();
};

// Static method to find by email
userSchema.statics.findByEmail = function(email) {
  return this.findOne({ email: email.toLowerCase() });
};

// Static method to create admin user
userSchema.statics.createAdmin = async function(email, password, firstName, lastName) {
  const existingAdmin = await this.findOne({ email: email.toLowerCase() });
  if (existingAdmin) {
    throw new Error('Admin user already exists');
  }
  
  const admin = new this({
    email: email.toLowerCase(),
    password,
    role: 'admin',
    profile: {
      firstName,
      lastName,
      bio: 'System Administrator'
    },
    wallet: {
      balance: 10000 // Admin starts with $10,000
    },
    emailVerified: true,
    status: 'active'
  });
  
  return admin.save();
};

module.exports = mongoose.model('User', userSchema);
