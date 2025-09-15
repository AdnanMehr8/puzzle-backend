const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { promisify } = require('util');

// Generate JWT token
const signToken = (id) => {
  return jwt.sign({ id }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
    issuer: 'puzzle-platform',
    audience: 'puzzle-users'
  });
};

// Generate refresh token
const signRefreshToken = (id) => {
  return jwt.sign({ id, type: 'refresh' }, process.env.JWT_REFRESH_SECRET, {
    expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '30d',
    issuer: 'puzzle-platform',
    audience: 'puzzle-users'
  });
};

// Create and send token response
const createSendToken = (user, statusCode, res, message = 'Success') => {
  const token = signToken(user._id);
  const refreshToken = signRefreshToken(user._id);
  
  const cookieOptions = {
    expires: new Date(
      Date.now() + parseInt(process.env.JWT_COOKIE_EXPIRES_IN || '7') * 24 * 60 * 60 * 1000
    ),
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'strict'
  };

  res.cookie('jwt', token, cookieOptions);
  res.cookie('refreshToken', refreshToken, {
    ...cookieOptions,
    expires: new Date(
      Date.now() + 30 * 24 * 60 * 60 * 1000 // 30 days in milliseconds
    )
  });

  // Remove password from output
  user.password = undefined;

  res.status(statusCode).json({
    status: 'success',
    message,
    token,
    refreshToken,
    data: {
      user
    }
  });
};

// Protect middleware - verify JWT token
const protect = async (req, res, next) => {
  try {
    // 1) Getting token and check if it exists
    let token;
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
      token = req.headers.authorization.split(' ')[1];
    } else if (req.cookies.jwt) {
      token = req.cookies.jwt;
    }

    if (!token) {
      return res.status(401).json({
        status: 'error',
        message: 'You are not logged in! Please log in to get access.'
      });
    }

    // 2) Verification token
    const decoded = await promisify(jwt.verify)(token, process.env.JWT_SECRET);

    // 3) Check if user still exists
    const currentUser = await User.findById(decoded.id).select('+password');
    if (!currentUser) {
      return res.status(401).json({
        status: 'error',
        message: 'The user belonging to this token does no longer exist.'
      });
    }

    // 4) Check if user account is locked
    if (currentUser.security.isLocked) {
      return res.status(423).json({
        status: 'error',
        message: 'Your account is temporarily locked due to multiple failed login attempts. Please try again later.'
      });
    }

    // 5) Check if user account is active
    if (currentUser.status !== 'active') {
      return res.status(403).json({
        status: 'error',
        message: 'Your account has been suspended. Please contact support.'
      });
    }

    // Grant access to protected route
    req.user = currentUser;
    next();
  } catch (error) {
    if (error.name === 'JsonWebTokenError') {
      return res.status(401).json({
        status: 'error',
        message: 'Invalid token. Please log in again!'
      });
    } else if (error.name === 'TokenExpiredError') {
      return res.status(401).json({
        status: 'error',
        message: 'Your token has expired! Please log in again.'
      });
    }
    
    return res.status(500).json({
      status: 'error',
      message: 'Something went wrong during authentication'
    });
  }
};

// Restrict to certain roles
const restrictTo = (...roles) => {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({
        status: 'error',
        message: 'You do not have permission to perform this action'
      });
    }
    next();
  };
};

// Optional authentication - doesn't fail if no token
const optionalAuth = async (req, res, next) => {
  try {
    let token;
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
      token = req.headers.authorization.split(' ')[1];
    } else if (req.cookies.jwt) {
      token = req.cookies.jwt;
    }

    if (token) {
      const decoded = await promisify(jwt.verify)(token, process.env.JWT_SECRET);
      const currentUser = await User.findById(decoded.id);
      
      if (currentUser && currentUser.status === 'active' && !currentUser.security.isLocked) {
        req.user = currentUser;
      }
    }
    
    next();
  } catch (error) {
    // Silently fail for optional auth
    next();
  }
};

// Refresh token middleware
const refreshToken = async (req, res, next) => {
  try {
    let refreshToken;
    if (req.body.refreshToken) {
      refreshToken = req.body.refreshToken;
    } else if (req.cookies.refreshToken) {
      refreshToken = req.cookies.refreshToken;
    }

    if (!refreshToken) {
      return res.status(401).json({
        status: 'error',
        message: 'No refresh token provided'
      });
    }

    const decoded = await promisify(jwt.verify)(refreshToken, process.env.JWT_REFRESH_SECRET);
    
    if (decoded.type !== 'refresh') {
      return res.status(401).json({
        status: 'error',
        message: 'Invalid refresh token'
      });
    }

    const currentUser = await User.findById(decoded.id);
    if (!currentUser) {
      return res.status(401).json({
        status: 'error',
        message: 'The user belonging to this token does no longer exist.'
      });
    }

    if (currentUser.status !== 'active' || currentUser.security.isLocked) {
      return res.status(403).json({
        status: 'error',
        message: 'Account is not accessible'
      });
    }

    // Generate new tokens
    createSendToken(currentUser, 200, res, 'Token refreshed successfully');
  } catch (error) {
    if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
      return res.status(401).json({
        status: 'error',
        message: 'Invalid or expired refresh token'
      });
    }
    
    return res.status(500).json({
      status: 'error',
      message: 'Something went wrong during token refresh'
    });
  }
};

// Rate limiting for sensitive operations
const sensitiveRateLimit = (maxAttempts = 5, windowMs = 15 * 60 * 1000) => {
  const attempts = new Map();
  
  return (req, res, next) => {
    const key = req.ip + (req.user ? req.user._id : '');
    const now = Date.now();
    
    if (!attempts.has(key)) {
      attempts.set(key, { count: 1, resetTime: now + windowMs });
      return next();
    }
    
    const userAttempts = attempts.get(key);
    
    if (now > userAttempts.resetTime) {
      attempts.set(key, { count: 1, resetTime: now + windowMs });
      return next();
    }
    
    if (userAttempts.count >= maxAttempts) {
      return res.status(429).json({
        status: 'error',
        message: 'Too many attempts. Please try again later.',
        retryAfter: Math.ceil((userAttempts.resetTime - now) / 1000)
      });
    }
    
    userAttempts.count++;
    next();
  };
};

// Validate user ownership
const validateOwnership = (resourceField = 'creatorId') => {
  return (req, res, next) => {
    if (req.user.role === 'admin') {
      return next(); // Admins can access everything
    }
    
    // For routes that haven't loaded the resource yet
    if (!req.resource && req.params.id) {
      return next(); // Will be validated in the route handler
    }
    
    if (req.resource && req.resource[resourceField].toString() !== req.user._id.toString()) {
      return res.status(403).json({
        status: 'error',
        message: 'You can only access your own resources'
      });
    }
    
    next();
  };
};

module.exports = {
  signToken,
  signRefreshToken,
  createSendToken,
  protect,
  restrictTo,
  optionalAuth,
  refreshToken,
  sensitiveRateLimit,
  validateOwnership
};
