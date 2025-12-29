const express = require('express');
const jwt = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const User = require('../models/User');
const Status = require('../models/Status');
const { verifyFirebaseIdToken, isFirebaseInitialized } = require('../services/push');
const { auth } = require('../middleware/auth');

const router = express.Router();

// Generate tokens
const generateTokens = (userId) => {
  const accessToken = jwt.sign(
    { userId },
    process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_EXPIRES_IN || '7d' }
  );

  const refreshToken = jwt.sign(
    { userId, type: 'refresh' },
    process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET,
    { expiresIn: process.env.JWT_REFRESH_EXPIRES_IN || '30d' }
  );

  return { accessToken, refreshToken };
};

// Register with email
router.post('/register', [
  body('email').isEmail().normalizeEmail(),
  body('password').isLength({ min: 6 }),
  body('name').trim().isLength({ min: 2 }),
  body('phone').optional().isMobilePhone(),
  body('gender').optional().isIn(['male', 'female', 'other', 'prefer_not_to_say'])
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { email, password, name, phone, gender } = req.body;

    // Check if email already exists
    const existingUser = await User.findOne({ email });
    if (existingUser) {
      return res.status(400).json({ error: 'Email already registered' });
    }

    // Check if phone already exists (if provided)
    if (phone) {
      const existingPhone = await User.findOne({ phone });
      if (existingPhone) {
        return res.status(400).json({ error: 'Phone number already registered' });
      }
    }

    // Get default status
    const defaultStatus = await Status.findOne({ name: 'Available', isDefault: true });

    // Create user
    const userData = {
      email,
      password,
      name,
      isVerified: true, // Email users are verified by default
      currentStatus: defaultStatus?._id
    };
    if (phone) userData.phone = phone;
    if (gender) userData.gender = gender;

    const user = await User.create(userData);

    const tokens = generateTokens(user._id);

    res.status(201).json({
      message: 'Registration successful',
      user: {
        id: user._id,
        email: user.email,
        phone: user.phone,
        name: user.name,
        gender: user.gender,
        isPremium: user.isPremium
      },
      ...tokens
    });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Registration failed' });
  }
});

// Login with email
router.post('/login', [
  body('email').isEmail().normalizeEmail(),
  body('password').exists()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { email, password } = req.body;

    // Find user and include password
    const user = await User.findOne({ email }).select('+password');
    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    if (!user.password) {
      return res.status(401).json({ error: 'Please login with your phone number' });
    }

    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Update last active
    user.lastActive = new Date();
    await user.save();

    const tokens = generateTokens(user._id);

    res.json({
      message: 'Login successful',
      user: {
        id: user._id,
        email: user.email,
        phone: user.phone,
        name: user.name,
        gender: user.gender,
        avatar: user.avatar,
        isPremium: user.isPremium
      },
      ...tokens
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Login failed' });
  }
});

// Firebase Phone Authentication
// Verifies Firebase ID token and creates/logs in user
router.post('/firebase-phone', [
  body('firebaseIdToken').exists().withMessage('Firebase token is required'),
  body('phone').matches(/^\+[1-9]\d{6,14}$/).withMessage('Invalid phone number format'),
  body('name').optional().trim().isLength({ min: 2 }),
  body('gender').optional().isIn(['male', 'female', 'other', 'prefer_not_to_say'])
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      // Return first error in the expected format
      return res.status(400).json({ error: errors.array()[0].msg });
    }

    const { firebaseIdToken, phone, name, gender } = req.body;

    // Check if Firebase is configured
    if (!isFirebaseInitialized()) {
      return res.status(500).json({ error: 'Firebase not configured on server' });
    }

    // Verify Firebase ID token
    const firebaseResult = await verifyFirebaseIdToken(firebaseIdToken);
    if (!firebaseResult.success) {
      return res.status(401).json({ error: 'Invalid Firebase token' });
    }

    // Verify phone number matches
    if (firebaseResult.phone !== phone) {
      return res.status(401).json({ error: 'Phone number mismatch' });
    }

    // Find or create user
    let user = await User.findOne({ phone });
    let isNewUser = false;

    if (!user) {
      // New user - require name and gender
      if (!name) {
        return res.json({
          needsName: true,
          message: 'Name required for new users'
        });
      }

      const defaultStatus = await Status.findOne({ name: 'Available', isDefault: true });

      const userData = {
        phone,
        name,
        isVerified: true,
        firebaseUid: firebaseResult.uid,
        currentStatus: defaultStatus?._id
      };
      if (gender) userData.gender = gender;

      user = await User.create(userData);
      isNewUser = true;
    } else {
      // Existing user - update Firebase UID if not set
      if (!user.firebaseUid) {
        user.firebaseUid = firebaseResult.uid;
        await user.save();
      }
    }

    // Update last active
    user.lastActive = new Date();
    await user.save();

    const tokens = generateTokens(user._id);

    res.json({
      message: isNewUser ? 'Registration successful' : 'Login successful',
      isNewUser,
      user: {
        id: user._id,
        phone: user.phone,
        email: user.email,
        name: user.name,
        gender: user.gender,
        avatar: user.avatar,
        isPremium: user.isPremium
      },
      ...tokens
    });
  } catch (error) {
    console.error('Firebase phone auth error:', error);
    res.status(500).json({ error: 'Authentication failed' });
  }
});

// Refresh token
router.post('/refresh-token', [
  body('refreshToken').exists()
], async (req, res) => {
  try {
    const { refreshToken } = req.body;

    const decoded = jwt.verify(
      refreshToken,
      process.env.JWT_REFRESH_SECRET || process.env.JWT_SECRET
    );

    if (decoded.type !== 'refresh') {
      return res.status(401).json({ error: 'Invalid refresh token' });
    }

    const user = await User.findById(decoded.userId);
    if (!user) {
      return res.status(401).json({ error: 'User not found' });
    }

    const tokens = generateTokens(user._id);

    res.json({
      message: 'Token refreshed',
      ...tokens
    });
  } catch (error) {
    console.error('Refresh token error:', error);
    res.status(401).json({ error: 'Invalid refresh token' });
  }
});

// Get current user
router.get('/me', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user._id)
      .populate('currentStatus')
      .select('-password');

    res.json({ user });
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ error: 'Failed to get user' });
  }
});

// Update profile
router.put('/profile', auth, [
  body('name').optional().trim().isLength({ min: 2 }),
  body('avatar').optional().isURL(),
  body('phone').optional().isMobilePhone(),
  body('gender').optional().isIn(['male', 'female', 'other', 'prefer_not_to_say'])
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const updates = {};
    if (req.body.name) updates.name = req.body.name;
    if (req.body.avatar) updates.avatar = req.body.avatar;
    if (req.body.gender) updates.gender = req.body.gender;

    // Only allow setting phone if user doesn't have one
    if (req.body.phone) {
      const currentUser = await User.findById(req.user._id);
      if (currentUser.phone) {
        return res.status(400).json({ error: 'Phone number cannot be changed once set' });
      }
      // Check if phone already exists
      const existingPhone = await User.findOne({ phone: req.body.phone });
      if (existingPhone) {
        return res.status(400).json({ error: 'Phone number already registered' });
      }
      updates.phone = req.body.phone;
    }

    const user = await User.findByIdAndUpdate(
      req.user._id,
      updates,
      { new: true }
    ).select('-password');

    res.json({ user });
  } catch (error) {
    console.error('Update profile error:', error);
    res.status(500).json({ error: 'Failed to update profile' });
  }
});

// Update FCM token
router.put('/fcm-token', auth, [
  body('fcmToken').exists()
], async (req, res) => {
  try {
    const { fcmToken } = req.body;

    await User.findByIdAndUpdate(req.user._id, { fcmToken });

    res.json({ message: 'FCM token updated' });
  } catch (error) {
    console.error('Update FCM token error:', error);
    res.status(500).json({ error: 'Failed to update FCM token' });
  }
});

// Logout (just for clearing FCM token)
router.post('/logout', auth, async (req, res) => {
  try {
    await User.findByIdAndUpdate(req.user._id, { fcmToken: null });
    res.json({ message: 'Logged out successfully' });
  } catch (error) {
    console.error('Logout error:', error);
    res.status(500).json({ error: 'Logout failed' });
  }
});

module.exports = router;
