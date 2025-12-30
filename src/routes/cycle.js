const express = require('express');
const mongoose = require('mongoose');
const { body, validationResult } = require('express-validator');
const Cycle = require('../models/Cycle');
const User = require('../models/User');
const Connection = require('../models/Connection');
const Notification = require('../models/Notification');
const { auth } = require('../middleware/auth');
const { sendToUser } = require('../config/socket');
const { sendPushNotification } = require('../services/push');
const { cacheCycle } = require('../middleware/cache');
const { CacheService } = require('../services/cache');

const router = express.Router();

// Get or create cycle data
router.get('/', auth, cacheCycle, async (req, res) => {
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
    const lastPeriod = cycle.getLastPeriod();
    const nextPeriod = cycle.getNextPeriod();
    const fertileWindow = cycle.getFertileWindow();

    // Check if there's an ongoing period
    const latestPeriod = cycle.periods[cycle.periods.length - 1];
    const hasOngoingPeriod = latestPeriod && !latestPeriod.endDate;

    res.json({
      cycle: {
        id: cycle._id,
        cycleLength: cycle.cycleLength,
        periodLength: cycle.periodLength,
        isTracking: cycle.isTracking,
        currentPhase,
        lastPeriod,
        nextPeriod,
        hasOngoingPeriod,
        ongoingPeriod: hasOngoingPeriod ? {
          startDate: latestPeriod.startDate,
          flow: latestPeriod.flow,
          dayCount: Math.ceil((new Date() - latestPeriod.startDate) / (1000 * 60 * 60 * 24)) + 1
        } : null,
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

    // Check if period came early (before expected)
    let cameEarly = false;
    if (cycle.expectedNextPeriod && cycle.expectedNextPeriod.isManuallySet && cycle.expectedNextPeriod.startDate) {
      const expectedStart = new Date(cycle.expectedNextPeriod.startDate);
      expectedStart.setHours(0, 0, 0, 0);
      const actualStart = new Date(startDate);
      actualStart.setHours(0, 0, 0, 0);
      cameEarly = actualStart < expectedStart;
    }

    // Add new period
    cycle.periods.push({
      startDate,
      endDate: null,
      flow
    });

    cycle.lastPeriodStart = startDate;

    // Clear expected period since actual period has started
    cycle.expectedNextPeriod = {
      startDate: null,
      endDate: null,
      isManuallySet: false
    };

    await cycle.save();

    // Invalidate cache
    await CacheService.invalidateCycle(req.user._id.toString());

    // Notify users who can see cycle
    await notifyCycleUpdate(req.user._id, cycle, cameEarly ? 'period_started_early' : 'period_started');

    const currentPhase = cycle.getCurrentPhase();
    const nextPeriod = cycle.getNextPeriod();

    res.json({
      message: cameEarly ? 'Period started (earlier than expected)' : 'Period started',
      period: cycle.periods[cycle.periods.length - 1],
      cameEarly,
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
    cycle.lastPeriodEnd = endDate;

    // Update average period length
    if (periodDays >= 1 && periodDays <= 10) {
      cycle.periodLength = Math.round((cycle.periodLength * 0.7) + (periodDays * 0.3));
    }

    await cycle.save();

    // Invalidate cache
    await CacheService.invalidateCycle(req.user._id.toString());

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

// Log past period (manual entry)
router.post('/period/log', auth, [
  body('startDate').isISO8601(),
  body('endDate').optional().isISO8601(),
  body('flow').optional().isIn(['light', 'medium', 'heavy'])
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const startDate = new Date(req.body.startDate);
    const endDate = req.body.endDate ? new Date(req.body.endDate) : null;
    const flow = req.body.flow || 'medium';

    // Validate dates
    if (endDate && endDate < startDate) {
      return res.status(400).json({ error: 'End date cannot be before start date' });
    }

    // Allow dates up to 1 year in past and 1 year in future (for predictions/planning)
    const oneYearAgo = new Date();
    oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
    const oneYearAhead = new Date();
    oneYearAhead.setFullYear(oneYearAhead.getFullYear() + 1);

    if (startDate < oneYearAgo || startDate > oneYearAhead) {
      return res.status(400).json({ error: 'Date must be within 1 year of today' });
    }

    let cycle = await Cycle.findOne({ userId: req.user._id });

    if (!cycle) {
      cycle = await Cycle.create({
        userId: req.user._id,
        cycleLength: 28,
        periodLength: 5,
        isTracking: true
      });
    }

    // Check for overlapping periods
    const newEndDate = endDate || new Date(startDate.getTime() + 7 * 24 * 60 * 60 * 1000); // Default 7 days if no end
    const overlappingPeriod = cycle.periods.find(existingPeriod => {
      const existingStart = new Date(existingPeriod.startDate);
      const existingEnd = existingPeriod.endDate
        ? new Date(existingPeriod.endDate)
        : new Date(existingStart.getTime() + 7 * 24 * 60 * 60 * 1000);

      // Check if date ranges overlap
      return startDate <= existingEnd && newEndDate >= existingStart;
    });

    if (overlappingPeriod) {
      const existingStartStr = new Date(overlappingPeriod.startDate).toISOString().split('T')[0];
      return res.status(400).json({
        error: 'This period overlaps with an existing period',
        overlapsWithStart: existingStartStr,
        message: `You already have a period logged starting ${existingStartStr}. Delete it first or choose different dates.`
      });
    }

    // Add the period
    const newPeriod = {
      startDate,
      endDate,
      flow
    };

    cycle.periods.push(newPeriod);

    // Sort periods by start date
    cycle.periods.sort((a, b) => a.startDate - b.startDate);

    // Update lastPeriodStart and lastPeriodEnd if this is the most recent period
    const mostRecentPeriod = cycle.periods[cycle.periods.length - 1];
    if (mostRecentPeriod.startDate.getTime() === startDate.getTime()) {
      cycle.lastPeriodStart = startDate;
      cycle.lastPeriodEnd = endDate; // Also set end date (can be null if ongoing)
    }

    // Update cycle length if we have multiple periods
    if (cycle.periods.length >= 2) {
      const recentPeriods = cycle.periods.slice(-3);
      if (recentPeriods.length >= 2) {
        let totalDays = 0;
        let count = 0;
        for (let i = 1; i < recentPeriods.length; i++) {
          const daysBetween = Math.round(
            (recentPeriods[i].startDate - recentPeriods[i - 1].startDate) / (1000 * 60 * 60 * 24)
          );
          if (daysBetween >= 21 && daysBetween <= 45) {
            totalDays += daysBetween;
            count++;
          }
        }
        if (count > 0) {
          cycle.cycleLength = Math.round(totalDays / count);
        }
      }
    }

    // Update period length if we have end date
    if (endDate) {
      const periodDays = Math.round((endDate - startDate) / (1000 * 60 * 60 * 24)) + 1;
      if (periodDays >= 1 && periodDays <= 10) {
        cycle.periodLength = Math.round((cycle.periodLength * 0.7) + (periodDays * 0.3));
      }
    }

    await cycle.save();

    // Invalidate cache
    await CacheService.invalidateCycle(req.user._id.toString());

    // Notify users who can see cycle
    await notifyCycleUpdate(req.user._id, cycle, 'period_logged');

    res.json({
      message: 'Period logged',
      period: newPeriod
    });
  } catch (error) {
    console.error('Log period error:', error);
    res.status(500).json({ error: 'Failed to log period' });
  }
});

// Delete a specific period
router.delete('/period/:periodId', auth, async (req, res) => {
  try {
    const { periodId } = req.params;

    const cycle = await Cycle.findOne({ userId: req.user._id });

    if (!cycle) {
      return res.status(404).json({ error: 'Cycle data not found' });
    }

    const periodIndex = cycle.periods.findIndex(p => p._id.toString() === periodId);

    if (periodIndex === -1) {
      return res.status(404).json({ error: 'Period not found' });
    }

    // Remove the period
    cycle.periods.splice(periodIndex, 1);

    // Recalculate lastPeriodStart and lastPeriodEnd from remaining periods
    if (cycle.periods.length > 0) {
      // Sort and get most recent completed period
      cycle.periods.sort((a, b) => a.startDate - b.startDate);
      const completedPeriods = cycle.periods.filter(p => p.endDate);

      if (completedPeriods.length > 0) {
        const mostRecent = completedPeriods[completedPeriods.length - 1];
        cycle.lastPeriodStart = mostRecent.startDate;
        cycle.lastPeriodEnd = mostRecent.endDate;
      } else {
        // No completed periods, use most recent start
        const mostRecent = cycle.periods[cycle.periods.length - 1];
        cycle.lastPeriodStart = mostRecent.startDate;
        cycle.lastPeriodEnd = null;
      }
    } else {
      cycle.lastPeriodStart = null;
      cycle.lastPeriodEnd = null;
    }

    await cycle.save();

    // Invalidate cache
    await CacheService.invalidateCycle(req.user._id.toString());

    res.json({
      message: 'Period deleted',
      remainingPeriods: cycle.periods.length
    });
  } catch (error) {
    console.error('Delete period error:', error);
    res.status(500).json({ error: 'Failed to delete period' });
  }
});

// Clear all periods (reset cycle data)
router.delete('/periods', auth, async (req, res) => {
  try {
    const cycle = await Cycle.findOne({ userId: req.user._id });

    if (!cycle) {
      return res.status(404).json({ error: 'Cycle data not found' });
    }

    const deletedCount = cycle.periods.length;

    // Clear all periods and reset related fields
    cycle.periods = [];
    cycle.lastPeriodStart = null;
    cycle.lastPeriodEnd = null;
    cycle.expectedNextPeriod = {
      startDate: null,
      endDate: null,
      isManuallySet: false
    };
    // Reset to defaults
    cycle.cycleLength = 28;
    cycle.periodLength = 5;

    await cycle.save();

    // Invalidate cache
    await CacheService.invalidateCycle(req.user._id.toString());

    res.json({
      message: 'All periods cleared',
      deletedCount
    });
  } catch (error) {
    console.error('Clear periods error:', error);
    res.status(500).json({ error: 'Failed to clear periods' });
  }
});

// Log symptom
router.post('/symptom', auth, [
  body('date').optional().isISO8601(),
  body('type').isIn(['cramps', 'headache', 'mood_swings', 'bloating', 'fatigue', 'breast_tenderness', 'acne', 'back_pain', 'nausea', 'cravings', 'anxiety', 'other']),
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

    // Invalidate cache
    await CacheService.invalidateCycle(req.user._id.toString());

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

    // Invalidate cache
    await CacheService.invalidateCycle(req.user._id.toString());

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

// Set expected upcoming period
router.put('/expected', auth, [
  body('startDate').isISO8601(),
  body('endDate').optional().isISO8601()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const startDate = new Date(req.body.startDate);
    const endDate = req.body.endDate ? new Date(req.body.endDate) : null;

    // Validate dates
    if (endDate && endDate < startDate) {
      return res.status(400).json({ error: 'End date cannot be before start date' });
    }

    // Start date should be in the future (or at most today)
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const startDateNormalized = new Date(startDate);
    startDateNormalized.setHours(0, 0, 0, 0);

    if (startDateNormalized < today) {
      return res.status(400).json({ error: 'Expected period start date must be today or in the future' });
    }

    // Limit to 60 days in the future
    const sixtyDaysAhead = new Date();
    sixtyDaysAhead.setDate(sixtyDaysAhead.getDate() + 60);

    if (startDate > sixtyDaysAhead) {
      return res.status(400).json({ error: 'Expected period date must be within 60 days from today' });
    }

    let cycle = await Cycle.findOne({ userId: req.user._id });

    if (!cycle) {
      cycle = await Cycle.create({
        userId: req.user._id,
        cycleLength: 28,
        periodLength: 5,
        isTracking: true
      });
    }

    cycle.expectedNextPeriod = {
      startDate,
      endDate,
      isManuallySet: true
    };

    await cycle.save();

    // Invalidate cache
    await CacheService.invalidateCycle(req.user._id.toString());

    // Notify users who can see cycle
    await notifyCycleUpdate(req.user._id, cycle, 'expected_period_set');

    res.json({
      message: 'Expected period set',
      expectedNextPeriod: {
        startDate: cycle.expectedNextPeriod.startDate,
        endDate: cycle.expectedNextPeriod.endDate,
        isManuallySet: true
      }
    });
  } catch (error) {
    console.error('Set expected period error:', error);
    res.status(500).json({ error: 'Failed to set expected period' });
  }
});

// Clear expected period (revert to calculated)
router.delete('/expected', auth, async (req, res) => {
  try {
    const cycle = await Cycle.findOne({ userId: req.user._id });

    if (!cycle) {
      return res.status(404).json({ error: 'Cycle data not found' });
    }

    cycle.expectedNextPeriod = {
      startDate: null,
      endDate: null,
      isManuallySet: false
    };

    await cycle.save();

    // Invalidate cache
    await CacheService.invalidateCycle(req.user._id.toString());

    const nextPeriod = cycle.getNextPeriod();

    res.json({
      message: 'Expected period cleared, using calculated prediction',
      nextPeriod
    });
  } catch (error) {
    console.error('Clear expected period error:', error);
    res.status(500).json({ error: 'Failed to clear expected period' });
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

    // Invalidate cache
    await CacheService.invalidateCycle(req.user._id.toString());

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

    // Convert string userId to ObjectId for proper query matching
    const targetUserId = new mongoose.Types.ObjectId(userId);

    // Check if connected
    const connection = await Connection.findOne({
      $or: [
        { userId: req.user._id, connectedUserId: targetUserId, status: 'accepted' },
        { userId: targetUserId, connectedUserId: req.user._id, status: 'accepted' }
      ]
    });

    if (!connection) {
      return res.status(403).json({ error: 'You are not connected with this user' });
    }

    // Check if user is sharing cycle with requester
    const cycle = await Cycle.findOne({
      userId: targetUserId,
      shareWith: req.user._id
    });

    if (!cycle) {
      return res.status(403).json({
        error: 'User is not sharing cycle data with you',
        code: 'NOT_SHARING'
      });
    }

    const currentPhase = cycle.getCurrentPhase();
    const lastPeriod = cycle.getLastPeriod();
    const nextPeriod = cycle.getNextPeriod();
    const fertileWindow = cycle.getFertileWindow();

    // Check if there's an ongoing period
    const latestPeriod = cycle.periods[cycle.periods.length - 1];
    const hasOngoingPeriod = latestPeriod && !latestPeriod.endDate;

    // Get recent symptoms (last 7 days)
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const recentSymptoms = cycle.symptoms
      .filter(s => s.date >= sevenDaysAgo)
      .sort((a, b) => b.date - a.date)
      .slice(0, 10);

    // Get the user's name
    const targetUser = await User.findById(targetUserId).select('name');

    // Return in same format as main cycle endpoint for consistency
    res.json({
      user: {
        id: targetUserId,
        name: targetUser.name
      },
      cycle: {
        id: cycle._id,
        cycleLength: cycle.cycleLength,
        periodLength: cycle.periodLength,
        isTracking: cycle.isTracking,
        currentPhase,
        lastPeriod,
        nextPeriod,
        hasOngoingPeriod,
        ongoingPeriod: hasOngoingPeriod ? {
          startDate: latestPeriod.startDate,
          flow: latestPeriod.flow,
          dayCount: Math.ceil((new Date() - latestPeriod.startDate) / (1000 * 60 * 60 * 24)) + 1
        } : null,
        fertileWindow,
        recentPeriods: cycle.periods.slice(-6).reverse(),
        recentSymptoms
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
    } else if (type === 'period_started_early') {
      title = `${user.name}'s Cycle Update`;
      message = `${user.name}'s period started earlier than expected`;
    } else if (type === 'period_ended') {
      title = `${user.name}'s Cycle Update`;
      message = `${user.name}'s period has ended`;
    } else if (type === 'period_logged') {
      title = `${user.name}'s Cycle Update`;
      message = `${user.name} logged a past period`;
    } else if (type === 'expected_period_set') {
      title = `${user.name}'s Cycle Update`;
      message = `${user.name} updated their expected period`;
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
