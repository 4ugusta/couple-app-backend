const express = require('express');
const { body, validationResult } = require('express-validator');
const Cycle = require('../models/Cycle');
const User = require('../models/User');
const Connection = require('../models/Connection');
const Notification = require('../models/Notification');
const { auth } = require('../middleware/auth');
const { sendToUser } = require('../config/socket');
const { sendPushNotification } = require('../services/push');

const router = express.Router();

// Get or create cycle data
router.get('/', auth, async (req, res) => {
  try {
    let cycle = await Cycle.findOne({ userId: req.user._id })
      .populate('shareWith', 'name avatar');

    // Create default cycle if doesn't exist
    if (!cycle) {
      cycle = await Cycle.create({
        userId: req.user._id,
        cycleLength: 28,
        periodLength: 5,
        isTracking: true
      });
    }

    const currentPhase = cycle.getCurrentPhase();
    const nextPeriod = cycle.getPredictedNextPeriod();
    const fertileWindow = cycle.getFertileWindow();

    res.json({
      cycle: {
        id: cycle._id,
        cycleLength: cycle.cycleLength,
        periodLength: cycle.periodLength,
        lastPeriodStart: cycle.lastPeriodStart,
        isTracking: cycle.isTracking,
        currentPhase,
        nextPeriod,
        fertileWindow,
        recentPeriods: cycle.periods.slice(-6).reverse(),
        shareWith: cycle.shareWith.map(u => ({
          id: u._id,
          name: u.name,
          avatar: u.avatar
        }))
      }
    });
  } catch (error) {
    console.error('Get cycle error:', error);
    res.status(500).json({ error: 'Failed to get cycle data' });
  }
});

// Start period
router.post('/period/start', auth, [
  body('date').optional().isISO8601(),
  body('flow').optional().isIn(['light', 'medium', 'heavy'])
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const startDate = req.body.date ? new Date(req.body.date) : new Date();
    const flow = req.body.flow || 'medium';

    let cycle = await Cycle.findOne({ userId: req.user._id });

    if (!cycle) {
      cycle = await Cycle.create({
        userId: req.user._id,
        cycleLength: 28,
        periodLength: 5,
        isTracking: true
      });
    }

    // Check if there's an ongoing period
    const lastPeriod = cycle.periods[cycle.periods.length - 1];
    if (lastPeriod && !lastPeriod.endDate) {
      return res.status(400).json({ error: 'There is already an ongoing period. Please end it first.' });
    }

    // Calculate cycle length from previous period
    if (cycle.lastPeriodStart) {
      const daysBetween = Math.round((startDate - cycle.lastPeriodStart) / (1000 * 60 * 60 * 24));
      if (daysBetween >= 21 && daysBetween <= 45) {
        // Update cycle length with weighted average
        cycle.cycleLength = Math.round((cycle.cycleLength * 0.7) + (daysBetween * 0.3));
      }
    }

    // Add new period
    cycle.periods.push({
      startDate,
      endDate: null,
      flow
    });

    cycle.lastPeriodStart = startDate;
    await cycle.save();

    // Notify users who can see cycle
    await notifyCycleUpdate(req.user._id, cycle, 'period_started');

    const currentPhase = cycle.getCurrentPhase();
    const nextPeriod = cycle.getPredictedNextPeriod();

    res.json({
      message: 'Period started',
      period: cycle.periods[cycle.periods.length - 1],
      currentPhase,
      nextPeriod
    });
  } catch (error) {
    console.error('Start period error:', error);
    res.status(500).json({ error: 'Failed to start period' });
  }
});

// End period
router.post('/period/end', auth, [
  body('date').optional().isISO8601()
], async (req, res) => {
  try {
    const endDate = req.body.date ? new Date(req.body.date) : new Date();

    const cycle = await Cycle.findOne({ userId: req.user._id });

    if (!cycle) {
      return res.status(404).json({ error: 'Cycle data not found' });
    }

    const lastPeriod = cycle.periods[cycle.periods.length - 1];
    if (!lastPeriod || lastPeriod.endDate) {
      return res.status(400).json({ error: 'No ongoing period to end' });
    }

    // Calculate period length
    const periodDays = Math.round((endDate - lastPeriod.startDate) / (1000 * 60 * 60 * 24)) + 1;

    if (periodDays < 1) {
      return res.status(400).json({ error: 'End date cannot be before start date' });
    }

    lastPeriod.endDate = endDate;

    // Update average period length
    if (periodDays >= 1 && periodDays <= 10) {
      cycle.periodLength = Math.round((cycle.periodLength * 0.7) + (periodDays * 0.3));
    }

    await cycle.save();

    // Notify users who can see cycle
    await notifyCycleUpdate(req.user._id, cycle, 'period_ended');

    res.json({
      message: 'Period ended',
      period: lastPeriod,
      periodLength: cycle.periodLength
    });
  } catch (error) {
    console.error('End period error:', error);
    res.status(500).json({ error: 'Failed to end period' });
  }
});

// Log symptom
router.post('/symptom', auth, [
  body('date').optional().isISO8601(),
  body('type').isIn(['cramps', 'headache', 'mood_swings', 'bloating', 'fatigue', 'breast_tenderness', 'acne', 'back_pain', 'nausea', 'other']),
  body('severity').optional().isInt({ min: 1, max: 5 }),
  body('notes').optional().trim().isLength({ max: 200 })
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const date = req.body.date ? new Date(req.body.date) : new Date();
    const { type, severity, notes } = req.body;

    let cycle = await Cycle.findOne({ userId: req.user._id });

    if (!cycle) {
      cycle = await Cycle.create({
        userId: req.user._id,
        cycleLength: 28,
        periodLength: 5,
        isTracking: true
      });
    }

    cycle.symptoms.push({
      date,
      type,
      severity: severity || 3,
      notes
    });

    await cycle.save();

    res.json({
      message: 'Symptom logged',
      symptom: cycle.symptoms[cycle.symptoms.length - 1]
    });
  } catch (error) {
    console.error('Log symptom error:', error);
    res.status(500).json({ error: 'Failed to log symptom' });
  }
});

// Get symptoms for date range
router.get('/symptoms', auth, async (req, res) => {
  try {
    const { startDate, endDate } = req.query;

    const start = startDate ? new Date(startDate) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const end = endDate ? new Date(endDate) : new Date();

    const cycle = await Cycle.findOne({ userId: req.user._id });

    if (!cycle) {
      return res.json({ symptoms: [] });
    }

    const symptoms = cycle.symptoms.filter(s =>
      s.date >= start && s.date <= end
    ).sort((a, b) => b.date - a.date);

    res.json({ symptoms });
  } catch (error) {
    console.error('Get symptoms error:', error);
    res.status(500).json({ error: 'Failed to get symptoms' });
  }
});

// Update cycle settings
router.put('/settings', auth, [
  body('cycleLength').optional().isInt({ min: 21, max: 45 }),
  body('periodLength').optional().isInt({ min: 1, max: 10 }),
  body('isTracking').optional().isBoolean()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { cycleLength, periodLength, isTracking } = req.body;

    let cycle = await Cycle.findOne({ userId: req.user._id });

    if (!cycle) {
      cycle = await Cycle.create({
        userId: req.user._id,
        cycleLength: cycleLength || 28,
        periodLength: periodLength || 5,
        isTracking: isTracking !== undefined ? isTracking : true
      });
    } else {
      if (cycleLength !== undefined) cycle.cycleLength = cycleLength;
      if (periodLength !== undefined) cycle.periodLength = periodLength;
      if (isTracking !== undefined) cycle.isTracking = isTracking;
      await cycle.save();
    }

    res.json({
      message: 'Settings updated',
      settings: {
        cycleLength: cycle.cycleLength,
        periodLength: cycle.periodLength,
        isTracking: cycle.isTracking
      }
    });
  } catch (error) {
    console.error('Update settings error:', error);
    res.status(500).json({ error: 'Failed to update settings' });
  }
});

// Update sharing settings
router.put('/sharing', auth, [
  body('shareWith').isArray()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { shareWith } = req.body;

    // Validate that shareWith contains only connected users
    const connections = await Connection.find({
      $or: [
        { userId: req.user._id, status: 'accepted' },
        { connectedUserId: req.user._id, status: 'accepted' }
      ]
    });

    const connectedUserIds = connections.map(conn => {
      const isInitiator = conn.userId.toString() === req.user._id.toString();
      return (isInitiator ? conn.connectedUserId : conn.userId).toString();
    });

    const validShareWith = shareWith.filter(id => connectedUserIds.includes(id));

    let cycle = await Cycle.findOne({ userId: req.user._id });

    if (!cycle) {
      cycle = await Cycle.create({
        userId: req.user._id,
        shareWith: validShareWith
      });
    } else {
      cycle.shareWith = validShareWith;
      await cycle.save();
    }

    const updatedCycle = await Cycle.findById(cycle._id)
      .populate('shareWith', 'name avatar');

    res.json({
      message: 'Sharing settings updated',
      shareWith: updatedCycle.shareWith.map(u => ({
        id: u._id,
        name: u.name,
        avatar: u.avatar
      }))
    });
  } catch (error) {
    console.error('Update sharing error:', error);
    res.status(500).json({ error: 'Failed to update sharing settings' });
  }
});

// Get connected user's cycle (if shared)
router.get('/user/:userId', auth, async (req, res) => {
  try {
    const { userId } = req.params;

    // Check if connected
    const connection = await Connection.findOne({
      $or: [
        { userId: req.user._id, connectedUserId: userId, status: 'accepted' },
        { userId: userId, connectedUserId: req.user._id, status: 'accepted' }
      ]
    });

    if (!connection) {
      return res.status(403).json({ error: 'You are not connected with this user' });
    }

    // Check if user is sharing cycle with requester
    const cycle = await Cycle.findOne({
      userId,
      shareWith: req.user._id
    });

    if (!cycle) {
      return res.status(403).json({
        error: 'User is not sharing cycle data with you',
        code: 'NOT_SHARING'
      });
    }

    const currentPhase = cycle.getCurrentPhase();
    const nextPeriod = cycle.getPredictedNextPeriod();
    const fertileWindow = cycle.getFertileWindow();

    // Get the user's name
    const targetUser = await User.findById(userId).select('name');

    res.json({
      user: {
        id: userId,
        name: targetUser.name
      },
      cycle: {
        currentPhase,
        nextPeriod,
        fertileWindow,
        cycleLength: cycle.cycleLength,
        periodLength: cycle.periodLength,
        lastPeriodStart: cycle.lastPeriodStart,
        isTracking: cycle.isTracking
      }
    });
  } catch (error) {
    console.error('Get user cycle error:', error);
    res.status(500).json({ error: 'Failed to get user cycle data' });
  }
});

// Helper function to notify users about cycle updates
async function notifyCycleUpdate(userId, cycle, type) {
  try {
    if (!cycle.shareWith || cycle.shareWith.length === 0) return;

    const user = await User.findById(userId);
    const sharedUsers = await User.find({ _id: { $in: cycle.shareWith } });

    let title, message;
    const currentPhase = cycle.getCurrentPhase();

    if (type === 'period_started') {
      title = `${user.name}'s Cycle Update`;
      message = `${user.name}'s period has started`;
    } else if (type === 'period_ended') {
      title = `${user.name}'s Cycle Update`;
      message = `${user.name}'s period has ended`;
    }

    for (const sharedUser of sharedUsers) {
      // Create notification in database
      await Notification.create({
        senderId: userId,
        receiverId: sharedUser._id,
        type: 'cycle',
        title,
        message,
        data: { cyclePhase: currentPhase?.phase }
      });

      // Send real-time notification
      sendToUser(sharedUser._id.toString(), 'cycle:update', {
        userId: userId.toString(),
        userName: user.name,
        type,
        currentPhase
      });

      // Send push notification
      if (sharedUser.fcmToken) {
        await sendPushNotification(
          sharedUser.fcmToken,
          title,
          message,
          { type: 'cycle_update', userId: userId.toString() }
        );
      }
    }
  } catch (error) {
    console.error('Error notifying cycle update:', error);
  }
}

module.exports = router;
