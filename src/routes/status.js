const express = require('express');
const { body, validationResult } = require('express-validator');
const Status = require('../models/Status');
const User = require('../models/User');
const Connection = require('../models/Connection');
const { auth } = require('../middleware/auth');
const { checkFreeSlots, checkPremiumSlots } = require('../middleware/premium');
const { sendToUsers } = require('../config/socket');
const { cacheStatuses } = require('../middleware/cache');
const { CacheService } = require('../services/cache');

const router = express.Router();

// Get all available statuses (default + custom)
router.get('/', auth, cacheStatuses, async (req, res) => {
  try {
    // Get default statuses
    const defaultStatuses = await Status.getDefaultStatuses();

    // Get user's custom statuses
    const user = await User.findById(req.user._id);

    res.json({
      defaultStatuses: defaultStatuses.map(s => ({
        id: s._id,
        name: s.name,
        emoji: s.emoji,
        isDefault: true
      })),
      customStatuses: user.customStatuses.map(s => ({
        id: s._id,
        name: s.name,
        emoji: s.emoji,
        isPremium: s.isPremium,
        isCustom: true
      })),
      slots: {
        freeUsed: user.customStatuses.filter(s => !s.isPremium).length,
        freeTotal: 2,
        premiumUsed: user.customStatuses.filter(s => s.isPremium).length,
        premiumTotal: user.isPremium ? 5 : 0
      }
    });
  } catch (error) {
    console.error('Get statuses error:', error);
    res.status(500).json({ error: 'Failed to get statuses' });
  }
});

// Get current status
router.get('/current', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user._id).populate('currentStatus');

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

    res.json({ status: statusInfo });
  } catch (error) {
    console.error('Get current status error:', error);
    res.status(500).json({ error: 'Failed to get current status' });
  }
});

// Set current status (default status)
router.put('/current', auth, [
  body('statusId').isMongoId()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { statusId } = req.body;

    // Verify it's a valid default status
    const status = await Status.findOne({ _id: statusId, isDefault: true });
    if (!status) {
      return res.status(404).json({ error: 'Status not found' });
    }

    // Update user's status
    await User.findByIdAndUpdate(req.user._id, {
      currentStatus: statusId,
      currentCustomStatus: null
    });

    // Invalidate cache
    await CacheService.invalidateStatuses(req.user._id.toString());

    // Notify connected users
    await notifyStatusChange(req.user._id, {
      id: status._id,
      name: status.name,
      emoji: status.emoji,
      isDefault: true
    });

    res.json({
      message: 'Status updated',
      status: {
        id: status._id,
        name: status.name,
        emoji: status.emoji
      }
    });
  } catch (error) {
    console.error('Set status error:', error);
    res.status(500).json({ error: 'Failed to set status' });
  }
});

// Set current custom status
router.put('/current/custom', auth, [
  body('customStatusId').isMongoId()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { customStatusId } = req.body;

    const user = await User.findById(req.user._id);
    const customStatus = user.customStatuses.id(customStatusId);

    if (!customStatus) {
      return res.status(404).json({ error: 'Custom status not found' });
    }

    // Check premium requirement
    if (customStatus.isPremium && !user.isPremium) {
      return res.status(403).json({
        error: 'Premium subscription required',
        code: 'PREMIUM_REQUIRED'
      });
    }

    // Update user's status
    user.currentStatus = null;
    user.currentCustomStatus = customStatusId;
    await user.save();

    // Invalidate cache
    await CacheService.invalidateStatuses(req.user._id.toString());

    // Notify connected users
    await notifyStatusChange(req.user._id, {
      id: customStatus._id,
      name: customStatus.name,
      emoji: customStatus.emoji,
      isCustom: true
    });

    res.json({
      message: 'Status updated',
      status: {
        id: customStatus._id,
        name: customStatus.name,
        emoji: customStatus.emoji
      }
    });
  } catch (error) {
    console.error('Set custom status error:', error);
    res.status(500).json({ error: 'Failed to set custom status' });
  }
});

// Create custom status (free slot)
router.post('/custom', auth, checkFreeSlots('status'), [
  body('name').trim().isLength({ min: 1, max: 30 }),
  body('emoji').optional().isLength({ min: 1, max: 4 })
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { name, emoji } = req.body;

    const user = await User.findById(req.user._id);

    // Check if name already exists
    const exists = user.customStatuses.some(s => s.name.toLowerCase() === name.toLowerCase());
    if (exists) {
      return res.status(400).json({ error: 'Status with this name already exists' });
    }

    user.customStatuses.push({
      name,
      emoji: emoji || '📌',
      isPremium: false
    });

    await user.save();

    // Invalidate cache
    await CacheService.invalidateStatuses(req.user._id.toString());

    const newStatus = user.customStatuses[user.customStatuses.length - 1];

    res.status(201).json({
      message: 'Custom status created',
      status: {
        id: newStatus._id,
        name: newStatus.name,
        emoji: newStatus.emoji,
        isPremium: false
      }
    });
  } catch (error) {
    console.error('Create custom status error:', error);
    res.status(500).json({ error: 'Failed to create custom status' });
  }
});

// Create premium custom status
router.post('/custom/premium', auth, checkPremiumSlots('status'), [
  body('name').trim().isLength({ min: 1, max: 30 }),
  body('emoji').optional().isLength({ min: 1, max: 4 })
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { name, emoji } = req.body;

    const user = await User.findById(req.user._id);

    // Check if name already exists
    const exists = user.customStatuses.some(s => s.name.toLowerCase() === name.toLowerCase());
    if (exists) {
      return res.status(400).json({ error: 'Status with this name already exists' });
    }

    user.customStatuses.push({
      name,
      emoji: emoji || '📌',
      isPremium: true
    });

    await user.save();

    // Invalidate cache
    await CacheService.invalidateStatuses(req.user._id.toString());

    const newStatus = user.customStatuses[user.customStatuses.length - 1];

    res.status(201).json({
      message: 'Premium custom status created',
      status: {
        id: newStatus._id,
        name: newStatus.name,
        emoji: newStatus.emoji,
        isPremium: true
      }
    });
  } catch (error) {
    console.error('Create premium status error:', error);
    res.status(500).json({ error: 'Failed to create premium status' });
  }
});

// Update custom status
router.put('/custom/:statusId', auth, [
  body('name').optional().trim().isLength({ min: 1, max: 30 }),
  body('emoji').optional().isLength({ min: 1, max: 4 })
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { statusId } = req.params;
    const { name, emoji } = req.body;

    const user = await User.findById(req.user._id);
    const customStatus = user.customStatuses.id(statusId);

    if (!customStatus) {
      return res.status(404).json({ error: 'Custom status not found' });
    }

    if (name) customStatus.name = name;
    if (emoji) customStatus.emoji = emoji;

    await user.save();

    // Invalidate cache
    await CacheService.invalidateStatuses(req.user._id.toString());

    res.json({
      message: 'Custom status updated',
      status: {
        id: customStatus._id,
        name: customStatus.name,
        emoji: customStatus.emoji
      }
    });
  } catch (error) {
    console.error('Update custom status error:', error);
    res.status(500).json({ error: 'Failed to update custom status' });
  }
});

// Delete custom status
router.delete('/custom/:statusId', auth, async (req, res) => {
  try {
    const { statusId } = req.params;

    const user = await User.findById(req.user._id);
    const customStatus = user.customStatuses.id(statusId);

    if (!customStatus) {
      return res.status(404).json({ error: 'Custom status not found' });
    }

    // If this is the current status, clear it
    if (user.currentCustomStatus?.toString() === statusId) {
      user.currentCustomStatus = null;
      // Set to default Available status
      const defaultStatus = await Status.findOne({ name: 'Available', isDefault: true });
      if (defaultStatus) {
        user.currentStatus = defaultStatus._id;
      }
    }

    user.customStatuses.pull(statusId);
    await user.save();

    // Invalidate cache
    await CacheService.invalidateStatuses(req.user._id.toString());

    res.json({ message: 'Custom status deleted' });
  } catch (error) {
    console.error('Delete custom status error:', error);
    res.status(500).json({ error: 'Failed to delete custom status' });
  }
});

// Helper function to notify connected users of status change
async function notifyStatusChange(userId, status) {
  try {
    const connections = await Connection.getConnections(userId);
    const connectedUserIds = connections.map(conn => {
      const isInitiator = conn.userId._id.toString() === userId.toString();
      return (isInitiator ? conn.connectedUserId._id : conn.userId._id).toString();
    });

    if (connectedUserIds.length > 0) {
      const user = await User.findById(userId);
      sendToUsers(connectedUserIds, 'status:update', {
        userId: userId.toString(),
        userName: user.name,
        status
      });
    }
  } catch (error) {
    console.error('Error notifying status change:', error);
  }
}

module.exports = router;
