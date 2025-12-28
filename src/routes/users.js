const express = require('express');
const { body, query, validationResult } = require('express-validator');
const User = require('../models/User');
const { auth } = require('../middleware/auth');

const router = express.Router();

// Search users by phone number
router.get('/search', auth, [
  query('phone').optional().isMobilePhone(),
  query('email').optional().isEmail()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { phone, email } = req.query;

    if (!phone && !email) {
      return res.status(400).json({ error: 'Please provide phone or email to search' });
    }

    const query = {};
    if (phone) query.phone = phone;
    if (email) query.email = email.toLowerCase();

    const user = await User.findOne(query).select('name avatar phone email');

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Don't return own profile
    if (user._id.toString() === req.user._id.toString()) {
      return res.status(400).json({ error: 'Cannot search for yourself' });
    }

    res.json({ user });
  } catch (error) {
    console.error('Search user error:', error);
    res.status(500).json({ error: 'Search failed' });
  }
});

// Get user profile by ID (for connected users only)
router.get('/:userId', auth, async (req, res) => {
  try {
    const { userId } = req.params;

    const user = await User.findById(userId)
      .populate('currentStatus')
      .select('name avatar currentStatus currentCustomStatus customStatuses lastActive');

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Get current status details
    let statusInfo = null;
    if (user.currentStatus) {
      statusInfo = {
        id: user.currentStatus._id,
        name: user.currentStatus.name,
        emoji: user.currentStatus.emoji,
        isDefault: user.currentStatus.isDefault
      };
    } else if (user.currentCustomStatus) {
      const customStatus = user.customStatuses.id(user.currentCustomStatus);
      if (customStatus) {
        statusInfo = {
          id: customStatus._id,
          name: customStatus.name,
          emoji: customStatus.emoji,
          isCustom: true
        };
      }
    }

    res.json({
      user: {
        id: user._id,
        name: user.name,
        avatar: user.avatar,
        status: statusInfo,
        lastActive: user.lastActive
      }
    });
  } catch (error) {
    console.error('Get user error:', error);
    res.status(500).json({ error: 'Failed to get user' });
  }
});

// Check if phone numbers exist (for contact sync)
router.post('/check-contacts', auth, [
  body('phones').isArray()
], async (req, res) => {
  try {
    const { phones } = req.body;

    if (!phones || phones.length === 0) {
      return res.json({ users: [] });
    }

    // Limit to 100 phones per request
    const limitedPhones = phones.slice(0, 100);

    const users = await User.find({
      phone: { $in: limitedPhones },
      _id: { $ne: req.user._id }
    }).select('name avatar phone');

    res.json({ users });
  } catch (error) {
    console.error('Check contacts error:', error);
    res.status(500).json({ error: 'Failed to check contacts' });
  }
});

module.exports = router;
