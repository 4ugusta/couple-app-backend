const express = require('express');
const { body, validationResult } = require('express-validator');
const Location = require('../models/Location');
const User = require('../models/User');
const Connection = require('../models/Connection');
const { auth } = require('../middleware/auth');
const { processLocationUpdate, updateLocationSharing } = require('../services/location');

const router = express.Router();

// Update location
router.post('/update', auth, [
  body('latitude').isFloat({ min: -90, max: 90 }),
  body('longitude').isFloat({ min: -180, max: 180 }),
  body('address').optional().trim(),
  body('placeName').optional().trim()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { latitude, longitude, address, placeName } = req.body;

    // Check if location sharing is enabled
    const user = await User.findById(req.user._id);
    if (!user.locationSharing.enabled) {
      return res.status(403).json({
        error: 'Location sharing is disabled',
        code: 'LOCATION_DISABLED'
      });
    }

    const location = await processLocationUpdate(
      req.user._id,
      latitude,
      longitude,
      address,
      placeName
    );

    res.json({
      message: 'Location updated',
      location: {
        id: location._id,
        latitude: location.latitude,
        longitude: location.longitude,
        address: location.address,
        placeName: location.placeName,
        timestamp: location.timestamp,
        isVisit: location.isVisit
      }
    });
  } catch (error) {
    console.error('Update location error:', error);
    res.status(500).json({ error: 'Failed to update location' });
  }
});

// Get location sharing settings
router.get('/sharing', auth, async (req, res) => {
  try {
    const user = await User.findById(req.user._id)
      .populate('locationSharing.shareWith', 'name avatar');

    res.json({
      enabled: user.locationSharing.enabled,
      shareWith: user.locationSharing.shareWith.map(u => ({
        id: u._id,
        name: u.name,
        avatar: u.avatar
      }))
    });
  } catch (error) {
    console.error('Get sharing settings error:', error);
    res.status(500).json({ error: 'Failed to get sharing settings' });
  }
});

// Update location sharing settings
router.put('/sharing', auth, [
  body('enabled').isBoolean(),
  body('shareWith').optional().isArray()
], async (req, res) => {
  try {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }

    const { enabled, shareWith } = req.body;

    // Validate that shareWith contains only connected users
    if (shareWith && shareWith.length > 0) {
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

      const sharingSettings = await updateLocationSharing(
        req.user._id,
        enabled,
        validShareWith
      );

      const user = await User.findById(req.user._id)
        .populate('locationSharing.shareWith', 'name avatar');

      return res.json({
        message: 'Location sharing updated',
        enabled: user.locationSharing.enabled,
        shareWith: user.locationSharing.shareWith.map(u => ({
          id: u._id,
          name: u.name,
          avatar: u.avatar
        }))
      });
    }

    await updateLocationSharing(req.user._id, enabled, []);

    res.json({
      message: 'Location sharing updated',
      enabled,
      shareWith: []
    });
  } catch (error) {
    console.error('Update sharing settings error:', error);
    res.status(500).json({ error: 'Failed to update sharing settings' });
  }
});

// Get connected user's latest location
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

    // Check if user is sharing location with requester
    const targetUser = await User.findById(userId);
    if (!targetUser.locationSharing.enabled ||
        !targetUser.locationSharing.shareWith.some(id => id.toString() === req.user._id.toString())) {
      return res.status(403).json({
        error: 'User is not sharing location with you',
        code: 'NOT_SHARING'
      });
    }

    const location = await Location.getLatestLocation(userId);

    if (!location) {
      return res.json({ location: null });
    }

    res.json({
      location: {
        id: location._id,
        latitude: location.latitude,
        longitude: location.longitude,
        address: location.address,
        placeName: location.placeName,
        timestamp: location.timestamp,
        isVisit: location.isVisit,
        visitDuration: location.visitDuration
      }
    });
  } catch (error) {
    console.error('Get user location error:', error);
    res.status(500).json({ error: 'Failed to get user location' });
  }
});

// Get connected user's location history
router.get('/user/:userId/history', auth, async (req, res) => {
  try {
    const { userId } = req.params;
    const { startDate, endDate } = req.query;

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

    // Check if user is sharing location
    const targetUser = await User.findById(userId);
    if (!targetUser.locationSharing.enabled ||
        !targetUser.locationSharing.shareWith.some(id => id.toString() === req.user._id.toString())) {
      return res.status(403).json({
        error: 'User is not sharing location with you',
        code: 'NOT_SHARING'
      });
    }

    // Default to last 24 hours
    const start = startDate ? new Date(startDate) : new Date(Date.now() - 24 * 60 * 60 * 1000);
    const end = endDate ? new Date(endDate) : new Date();

    const locations = await Location.getLocationHistory(userId, start, end);

    res.json({
      locations: locations.map(l => ({
        id: l._id,
        latitude: l.latitude,
        longitude: l.longitude,
        address: l.address,
        placeName: l.placeName,
        timestamp: l.timestamp,
        isVisit: l.isVisit,
        visitDuration: l.visitDuration
      }))
    });
  } catch (error) {
    console.error('Get location history error:', error);
    res.status(500).json({ error: 'Failed to get location history' });
  }
});

// Get connected user's visit history
router.get('/user/:userId/visits', auth, async (req, res) => {
  try {
    const { userId } = req.params;
    const limit = parseInt(req.query.limit) || 20;

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

    // Check if user is sharing location
    const targetUser = await User.findById(userId);
    if (!targetUser.locationSharing.enabled ||
        !targetUser.locationSharing.shareWith.some(id => id.toString() === req.user._id.toString())) {
      return res.status(403).json({
        error: 'User is not sharing location with you',
        code: 'NOT_SHARING'
      });
    }

    const visits = await Location.getVisitHistory(userId, limit);

    res.json({
      visits: visits.map(v => ({
        id: v._id,
        latitude: v.latitude,
        longitude: v.longitude,
        address: v.address,
        placeName: v.placeName,
        timestamp: v.timestamp,
        visitDuration: v.visitDuration,
        visitStartTime: v.visitStartTime,
        visitEndTime: v.visitEndTime
      }))
    });
  } catch (error) {
    console.error('Get visit history error:', error);
    res.status(500).json({ error: 'Failed to get visit history' });
  }
});

// Get my location history
router.get('/history', auth, async (req, res) => {
  try {
    const { startDate, endDate } = req.query;

    const start = startDate ? new Date(startDate) : new Date(Date.now() - 24 * 60 * 60 * 1000);
    const end = endDate ? new Date(endDate) : new Date();

    const locations = await Location.getLocationHistory(req.user._id, start, end);

    res.json({
      locations: locations.map(l => ({
        id: l._id,
        latitude: l.latitude,
        longitude: l.longitude,
        address: l.address,
        placeName: l.placeName,
        timestamp: l.timestamp,
        isVisit: l.isVisit,
        visitDuration: l.visitDuration
      }))
    });
  } catch (error) {
    console.error('Get my location history error:', error);
    res.status(500).json({ error: 'Failed to get location history' });
  }
});

module.exports = router;
