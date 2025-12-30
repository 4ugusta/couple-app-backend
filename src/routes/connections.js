const express = require('express');
const { body, validationResult } = require('express-validator');
const Connection = require('../models/Connection');
const User = require('../models/User');
const { auth } = require('../middleware/auth');
const { sendToUser } = require('../config/socket');
const { sendPushNotification } = require('../services/push');
const { cacheConnections } = require('../middleware/cache');
const { CacheService } = require('../services/cache');

const router = express.Router();

// Get all connections (with caching)
router.get('/', auth, cacheConnections, async (req, res) => {
  try {
    const connections = await Connection.find({
      $or: [
        { userId: req.user._id, status: 'accepted' },
        { connectedUserId: req.user._id, status: 'accepted' }
      ]
    }).populate({
      path: 'userId connectedUserId',
      select: 'name avatar phone email currentStatus lastActive',
      populate: {
        path: 'currentStatus',
        select: 'name emoji'
      }
    });

    // Format connections
    const formattedConnections = connections.map(conn => {
      const isInitiator = conn.userId._id.toString() === req.user._id.toString();
      const otherUser = isInitiator ? conn.connectedUserId : conn.userId;

      return {
        id: conn._id,
        type: conn.type,
        status: conn.status,
        nickname: conn.nickname,
        user: {
          id: otherUser._id,
          name: otherUser.name,
          avatar: otherUser.avatar,
          phone: otherUser.phone,
          email: otherUser.email,
          lastActive: otherUser.lastActive,
          status: otherUser.currentStatus ? {
            id: otherUser.currentStatus._id,
            name: otherUser.currentStatus.name,
            emoji: otherUser.currentStatus.emoji
          } : null
        },
        createdAt: conn.createdAt
      };
    });

    res.json({ connections: formattedConnections });
  } catch (error) {
    console.error('Get connections error:', error);
    res.status(500).json({ error: 'Failed to get connections' });
  }
});

// Get pending connection requests
router.get('/pending', auth, async (req, res) => {
  try {
    const requests = await Connection.find({
      connectedUserId: req.user._id,
      status: 'pending'
    }).populate('userId', 'name avatar phone email');

    const formattedRequests = requests.map(req => ({
      id: req._id,
      type: req.type,
      user: {
        id: req.userId._id,
        name: req.userId.name,
        avatar: req.userId.avatar,
        phone: req.userId.phone
      },
      createdAt: req.createdAt
    }));

    res.json({ requests: formattedRequests });
  } catch (error) {
    console.error('Get pending requests error:', error);
    res.status(500).json({ error: 'Failed to get pending requests' });
  }
});

// Send connection request
router.post('/request', auth, [
  body('userId').isMongoId(),
  body('type').isIn(['partner', 'close_friend'])
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { userId, type } = req.body;

    // Can't connect with yourself
    if (userId === req.user._id.toString()) {
      return res.status(400).json({ error: 'Cannot connect with yourself' });
    }

    // Check if user exists
    const targetUser = await User.findById(userId);
    if (!targetUser) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Check for existing connection
    const existingConnection = await Connection.findOne({
      $or: [
        { userId: req.user._id, connectedUserId: userId },
        { userId: userId, connectedUserId: req.user._id }
      ]
    });

    if (existingConnection) {
      if (existingConnection.status === 'accepted') {
        return res.status(400).json({ error: 'Already connected' });
      }
      if (existingConnection.status === 'pending') {
        return res.status(400).json({ error: 'Request already pending' });
      }
      if (existingConnection.status === 'blocked') {
        return res.status(400).json({ error: 'Cannot connect with this user' });
      }
    }

    // If requesting partner, check if either user already has a partner
    if (type === 'partner') {
      const userHasPartner = await Connection.hasPartner(req.user._id);
      if (userHasPartner) {
        return res.status(400).json({ error: 'You already have a partner' });
      }

      const targetHasPartner = await Connection.hasPartner(userId);
      if (targetHasPartner) {
        return res.status(400).json({ error: 'This user already has a partner' });
      }
    }

    // Create connection request
    const connection = await Connection.create({
      userId: req.user._id,
      connectedUserId: userId,
      type,
      status: 'pending',
      initiatedBy: req.user._id
    });

    // Notify target user via Socket.IO
    sendToUser(userId, 'connection:request', {
      id: connection._id,
      type,
      user: {
        id: req.user._id,
        name: req.user.name,
        avatar: req.user.avatar
      }
    });

    // Send push notification
    if (targetUser.fcmToken) {
      await sendPushNotification(
        targetUser.fcmToken,
        'New Connection Request',
        `${req.user.name} wants to connect as your ${type === 'partner' ? 'partner' : 'close friend'}`,
        { type: 'connection_request', connectionId: connection._id.toString() }
      );
    }

    res.status(201).json({
      message: 'Connection request sent',
      connection: {
        id: connection._id,
        type: connection.type,
        status: connection.status
      }
    });
  } catch (error) {
    console.error('Send connection request error:', error);
    res.status(500).json({ error: 'Failed to send connection request' });
  }
});

// Accept connection request
router.put('/:connectionId/accept', auth, async (req, res) => {
  try {
    const { connectionId } = req.params;

    const connection = await Connection.findOne({
      _id: connectionId,
      connectedUserId: req.user._id,
      status: 'pending'
    });

    if (!connection) {
      return res.status(404).json({ error: 'Connection request not found' });
    }

    // If accepting partner, check if current user already has a partner
    if (connection.type === 'partner') {
      const hasPartner = await Connection.hasPartner(req.user._id);
      if (hasPartner) {
        return res.status(400).json({ error: 'You already have a partner' });
      }
    }

    connection.status = 'accepted';
    await connection.save();

    // Invalidate cache for both users
    await CacheService.invalidateConnectionPair(req.user._id.toString(), connection.userId.toString());

    // Get the requester
    const requester = await User.findById(connection.userId);

    // Notify requester
    sendToUser(connection.userId.toString(), 'connection:accepted', {
      id: connection._id,
      user: {
        id: req.user._id,
        name: req.user.name,
        avatar: req.user.avatar
      }
    });

    // Send push notification
    if (requester.fcmToken) {
      await sendPushNotification(
        requester.fcmToken,
        'Connection Accepted',
        `${req.user.name} accepted your connection request!`,
        { type: 'connection_accepted', connectionId: connection._id.toString() }
      );
    }

    res.json({
      message: 'Connection accepted',
      connection: {
        id: connection._id,
        type: connection.type,
        status: connection.status
      }
    });
  } catch (error) {
    console.error('Accept connection error:', error);
    res.status(500).json({ error: 'Failed to accept connection' });
  }
});

// Reject connection request
router.put('/:connectionId/reject', auth, async (req, res) => {
  try {
    const { connectionId } = req.params;

    const connection = await Connection.findOne({
      _id: connectionId,
      connectedUserId: req.user._id,
      status: 'pending'
    });

    if (!connection) {
      return res.status(404).json({ error: 'Connection request not found' });
    }

    connection.status = 'rejected';
    await connection.save();

    // Invalidate cache for both users
    await CacheService.invalidateConnectionPair(req.user._id.toString(), connection.userId.toString());

    res.json({ message: 'Connection rejected' });
  } catch (error) {
    console.error('Reject connection error:', error);
    res.status(500).json({ error: 'Failed to reject connection' });
  }
});

// Update connection nickname
router.put('/:connectionId/nickname', auth, [
  body('nickname').trim().isLength({ min: 1, max: 50 })
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { connectionId } = req.params;
    const { nickname } = req.body;

    const connection = await Connection.findOne({
      _id: connectionId,
      $or: [
        { userId: req.user._id },
        { connectedUserId: req.user._id }
      ],
      status: 'accepted'
    });

    if (!connection) {
      return res.status(404).json({ error: 'Connection not found' });
    }

    connection.nickname = nickname;
    await connection.save();

    res.json({
      message: 'Nickname updated',
      connection: {
        id: connection._id,
        nickname: connection.nickname
      }
    });
  } catch (error) {
    console.error('Update nickname error:', error);
    res.status(500).json({ error: 'Failed to update nickname' });
  }
});

// Remove connection
router.delete('/:connectionId', auth, async (req, res) => {
  try {
    const { connectionId } = req.params;

    const connection = await Connection.findOneAndDelete({
      _id: connectionId,
      $or: [
        { userId: req.user._id },
        { connectedUserId: req.user._id }
      ]
    });

    if (!connection) {
      return res.status(404).json({ error: 'Connection not found' });
    }

    // Invalidate cache for both users
    const otherUserIdForCache = connection.userId.toString() === req.user._id.toString()
      ? connection.connectedUserId.toString()
      : connection.userId.toString();
    await CacheService.invalidateConnectionPair(req.user._id.toString(), otherUserIdForCache);

    // Notify other user
    const otherUserId = connection.userId.toString() === req.user._id.toString()
      ? connection.connectedUserId
      : connection.userId;

    sendToUser(otherUserId.toString(), 'connection:removed', {
      connectionId: connection._id
    });

    res.json({ message: 'Connection removed' });
  } catch (error) {
    console.error('Remove connection error:', error);
    res.status(500).json({ error: 'Failed to remove connection' });
  }
});

// Block user
router.put('/:connectionId/block', auth, async (req, res) => {
  try {
    const { connectionId } = req.params;

    const connection = await Connection.findOne({
      _id: connectionId,
      $or: [
        { userId: req.user._id },
        { connectedUserId: req.user._id }
      ]
    });

    if (!connection) {
      return res.status(404).json({ error: 'Connection not found' });
    }

    connection.status = 'blocked';
    await connection.save();

    // Invalidate cache for both users
    const otherUserIdBlock = connection.userId.toString() === req.user._id.toString()
      ? connection.connectedUserId.toString()
      : connection.userId.toString();
    await CacheService.invalidateConnectionPair(req.user._id.toString(), otherUserIdBlock);

    res.json({ message: 'User blocked' });
  } catch (error) {
    console.error('Block user error:', error);
    res.status(500).json({ error: 'Failed to block user' });
  }
});

module.exports = router;
