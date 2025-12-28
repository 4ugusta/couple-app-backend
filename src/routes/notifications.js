const express = require('express');
const { body, validationResult } = require('express-validator');
const Notification = require('../models/Notification');
const User = require('../models/User');
const Connection = require('../models/Connection');
const { auth } = require('../middleware/auth');
const { checkFreeSlots, checkPremiumSlots } = require('../middleware/premium');
const { sendToUser } = require('../config/socket');
const { sendPushNotification } = require('../services/push');

const router = express.Router();

// Get predefined notification templates
router.get('/templates', auth, async (req, res) => {
  try {
    const predefined = Notification.getPredefinedTemplates();
    const user = await User.findById(req.user._id);

    res.json({
      predefinedTemplates: predefined,
      customTemplates: user.customNotifications.map(n => ({
        id: n._id,
        title: n.title,
        message: n.message,
        isPremium: n.isPremium,
        isCustom: true
      })),
      slots: {
        freeUsed: user.customNotifications.filter(n => !n.isPremium).length,
        freeTotal: 2,
        premiumUsed: user.customNotifications.filter(n => n.isPremium).length,
        premiumTotal: user.isPremium ? 5 : 0
      }
    });
  } catch (error) {
    console.error('Get templates error:', error);
    res.status(500).json({ error: 'Failed to get templates' });
  }
});

// Get user's notifications
router.get('/', auth, async (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 50;
    const notifications = await Notification.getUserNotifications(req.user._id, limit);

    res.json({
      notifications: notifications.map(n => ({
        id: n._id,
        type: n.type,
        title: n.title,
        message: n.message,
        sender: n.senderId ? {
          id: n.senderId._id,
          name: n.senderId.name,
          avatar: n.senderId.avatar
        } : null,
        isRead: n.isRead,
        data: n.data,
        createdAt: n.createdAt
      })),
      unreadCount: notifications.filter(n => !n.isRead).length
    });
  } catch (error) {
    console.error('Get notifications error:', error);
    res.status(500).json({ error: 'Failed to get notifications' });
  }
});

// Send predefined notification
router.post('/send/predefined', auth, [
  body('receiverId').isMongoId(),
  body('templateId').isIn(['thinking_of_you', 'call_me', 'on_my_way'])
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { receiverId, templateId } = req.body;

    // Verify connection exists
    const connection = await Connection.findOne({
      $or: [
        { userId: req.user._id, connectedUserId: receiverId, status: 'accepted' },
        { userId: receiverId, connectedUserId: req.user._id, status: 'accepted' }
      ]
    });

    if (!connection) {
      return res.status(403).json({ error: 'You are not connected with this user' });
    }

    // Get template
    const templates = Notification.getPredefinedTemplates();
    const template = templates.find(t => t.id === templateId);

    if (!template) {
      return res.status(400).json({ error: 'Invalid template' });
    }

    // Create notification
    const notification = await Notification.create({
      senderId: req.user._id,
      receiverId,
      type: 'predefined',
      title: template.title,
      message: template.message,
      templateId
    });

    // Send real-time notification
    sendToUser(receiverId, 'notification:new', {
      id: notification._id,
      type: 'predefined',
      title: template.title,
      message: template.message,
      sender: {
        id: req.user._id,
        name: req.user.name,
        avatar: req.user.avatar
      },
      createdAt: notification.createdAt
    });

    // Send push notification
    const receiver = await User.findById(receiverId);
    if (receiver?.fcmToken) {
      await sendPushNotification(
        receiver.fcmToken,
        `${req.user.name}: ${template.title}`,
        template.message,
        { type: 'notification', notificationId: notification._id.toString() }
      );
    }

    res.status(201).json({
      message: 'Notification sent',
      notification: {
        id: notification._id,
        title: template.title,
        message: template.message
      }
    });
  } catch (error) {
    console.error('Send notification error:', error);
    res.status(500).json({ error: 'Failed to send notification' });
  }
});

// Send custom notification
router.post('/send/custom', auth, [
  body('receiverId').isMongoId(),
  body('customNotificationId').isMongoId()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { receiverId, customNotificationId } = req.body;

    // Verify connection exists
    const connection = await Connection.findOne({
      $or: [
        { userId: req.user._id, connectedUserId: receiverId, status: 'accepted' },
        { userId: receiverId, connectedUserId: req.user._id, status: 'accepted' }
      ]
    });

    if (!connection) {
      return res.status(403).json({ error: 'You are not connected with this user' });
    }

    // Get custom notification template
    const user = await User.findById(req.user._id);
    const customTemplate = user.customNotifications.id(customNotificationId);

    if (!customTemplate) {
      return res.status(404).json({ error: 'Custom notification not found' });
    }

    // Check premium requirement
    if (customTemplate.isPremium && !user.isPremium) {
      return res.status(403).json({
        error: 'Premium subscription required',
        code: 'PREMIUM_REQUIRED'
      });
    }

    // Create notification
    const notification = await Notification.create({
      senderId: req.user._id,
      receiverId,
      type: 'custom',
      title: customTemplate.title,
      message: customTemplate.message,
      templateId: customNotificationId.toString()
    });

    // Send real-time notification
    sendToUser(receiverId, 'notification:new', {
      id: notification._id,
      type: 'custom',
      title: customTemplate.title,
      message: customTemplate.message,
      sender: {
        id: req.user._id,
        name: req.user.name,
        avatar: req.user.avatar
      },
      createdAt: notification.createdAt
    });

    // Send push notification
    const receiver = await User.findById(receiverId);
    if (receiver?.fcmToken) {
      await sendPushNotification(
        receiver.fcmToken,
        `${req.user.name}: ${customTemplate.title}`,
        customTemplate.message,
        { type: 'notification', notificationId: notification._id.toString() }
      );
    }

    res.status(201).json({
      message: 'Notification sent',
      notification: {
        id: notification._id,
        title: customTemplate.title,
        message: customTemplate.message
      }
    });
  } catch (error) {
    console.error('Send custom notification error:', error);
    res.status(500).json({ error: 'Failed to send notification' });
  }
});

// Create custom notification template (free slot)
router.post('/custom', auth, checkFreeSlots('notification'), [
  body('title').trim().isLength({ min: 1, max: 50 }),
  body('message').trim().isLength({ min: 1, max: 200 })
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { title, message } = req.body;

    const user = await User.findById(req.user._id);

    user.customNotifications.push({
      title,
      message,
      isPremium: false
    });

    await user.save();

    const newNotification = user.customNotifications[user.customNotifications.length - 1];

    res.status(201).json({
      message: 'Custom notification created',
      template: {
        id: newNotification._id,
        title: newNotification.title,
        message: newNotification.message,
        isPremium: false
      }
    });
  } catch (error) {
    console.error('Create custom notification error:', error);
    res.status(500).json({ error: 'Failed to create custom notification' });
  }
});

// Create premium custom notification template
router.post('/custom/premium', auth, checkPremiumSlots('notification'), [
  body('title').trim().isLength({ min: 1, max: 50 }),
  body('message').trim().isLength({ min: 1, max: 200 })
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { title, message } = req.body;

    const user = await User.findById(req.user._id);

    user.customNotifications.push({
      title,
      message,
      isPremium: true
    });

    await user.save();

    const newNotification = user.customNotifications[user.customNotifications.length - 1];

    res.status(201).json({
      message: 'Premium custom notification created',
      template: {
        id: newNotification._id,
        title: newNotification.title,
        message: newNotification.message,
        isPremium: true
      }
    });
  } catch (error) {
    console.error('Create premium notification error:', error);
    res.status(500).json({ error: 'Failed to create premium notification' });
  }
});

// Update custom notification template
router.put('/custom/:notificationId', auth, [
  body('title').optional().trim().isLength({ min: 1, max: 50 }),
  body('message').optional().trim().isLength({ min: 1, max: 200 })
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { notificationId } = req.params;
    const { title, message } = req.body;

    const user = await User.findById(req.user._id);
    const customNotification = user.customNotifications.id(notificationId);

    if (!customNotification) {
      return res.status(404).json({ error: 'Custom notification not found' });
    }

    if (title) customNotification.title = title;
    if (message) customNotification.message = message;

    await user.save();

    res.json({
      message: 'Custom notification updated',
      template: {
        id: customNotification._id,
        title: customNotification.title,
        message: customNotification.message
      }
    });
  } catch (error) {
    console.error('Update custom notification error:', error);
    res.status(500).json({ error: 'Failed to update custom notification' });
  }
});

// Delete custom notification template
router.delete('/custom/:notificationId', auth, async (req, res) => {
  try {
    const { notificationId } = req.params;

    const user = await User.findById(req.user._id);
    const customNotification = user.customNotifications.id(notificationId);

    if (!customNotification) {
      return res.status(404).json({ error: 'Custom notification not found' });
    }

    user.customNotifications.pull(notificationId);
    await user.save();

    res.json({ message: 'Custom notification deleted' });
  } catch (error) {
    console.error('Delete custom notification error:', error);
    res.status(500).json({ error: 'Failed to delete custom notification' });
  }
});

// Mark notifications as read
router.put('/read', auth, [
  body('notificationIds').isArray()
], async (req, res) => {
  try {
    const { notificationIds } = req.body;

    await Notification.markAsRead(notificationIds, req.user._id);

    res.json({ message: 'Notifications marked as read' });
  } catch (error) {
    console.error('Mark as read error:', error);
    res.status(500).json({ error: 'Failed to mark notifications as read' });
  }
});

// Mark all as read
router.put('/read-all', auth, async (req, res) => {
  try {
    await Notification.updateMany(
      { receiverId: req.user._id, isRead: false },
      { isRead: true }
    );

    res.json({ message: 'All notifications marked as read' });
  } catch (error) {
    console.error('Mark all as read error:', error);
    res.status(500).json({ error: 'Failed to mark all as read' });
  }
});

module.exports = router;
