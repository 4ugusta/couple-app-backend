const Location = require('../models/Location');
const Connection = require('../models/Connection');
const User = require('../models/User');
const { sendToUsers } = require('../config/socket');
const { sendPushNotification } = require('./push');

// Minimum time at a location to be considered a "visit" (in milliseconds)
const VISIT_THRESHOLD = 5 * 60 * 1000; // 5 minutes

// Distance threshold to consider same location (in meters)
const DISTANCE_THRESHOLD = 100;

// Calculate distance between two points using Haversine formula
const calculateDistance = (lat1, lon1, lat2, lon2) => {
  const R = 6371e3; // Earth's radius in meters
  const phi1 = lat1 * Math.PI / 180;
  const phi2 = lat2 * Math.PI / 180;
  const deltaPhi = (lat2 - lat1) * Math.PI / 180;
  const deltaLambda = (lon2 - lon1) * Math.PI / 180;

  const a = Math.sin(deltaPhi / 2) * Math.sin(deltaPhi / 2) +
    Math.cos(phi1) * Math.cos(phi2) *
    Math.sin(deltaLambda / 2) * Math.sin(deltaLambda / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));

  return R * c;
};

// Process and store location update
const processLocationUpdate = async (userId, latitude, longitude, address = null, placeName = null) => {
  try {
    // Get user's last location
    const lastLocation = await Location.getLatestLocation(userId);

    let isVisit = false;
    let visitDuration = 0;

    if (lastLocation) {
      const distance = calculateDistance(
        lastLocation.latitude,
        lastLocation.longitude,
        latitude,
        longitude
      );

      const timeDiff = Date.now() - lastLocation.timestamp.getTime();

      // Check if user stayed at the same location
      if (distance < DISTANCE_THRESHOLD && timeDiff >= VISIT_THRESHOLD) {
        isVisit = true;
        visitDuration = Math.round(timeDiff / (60 * 1000)); // Convert to minutes

        // Update previous location as a visit if not already
        if (!lastLocation.isVisit) {
          lastLocation.isVisit = true;
          lastLocation.visitStartTime = lastLocation.timestamp;
          lastLocation.visitDuration = visitDuration;
          await lastLocation.save();
        }
      }
    }

    // Create new location record
    const location = await Location.create({
      userId,
      latitude,
      longitude,
      address,
      placeName,
      timestamp: new Date(),
      isVisit,
      visitDuration,
      visitStartTime: isVisit ? new Date(Date.now() - visitDuration * 60 * 1000) : null
    });

    // Notify connected users who have access to this user's location
    await notifyConnectedUsers(userId, location);

    return location;
  } catch (error) {
    console.error('Error processing location update:', error);
    throw error;
  }
};

// Notify connected users about location update
const notifyConnectedUsers = async (userId, location) => {
  try {
    const user = await User.findById(userId);
    if (!user || !user.locationSharing.enabled) return;

    const shareWithIds = user.locationSharing.shareWith;
    if (!shareWithIds || shareWithIds.length === 0) return;

    // Get connected users
    const connectedUsers = await User.find({
      _id: { $in: shareWithIds }
    });

    const connectedUserIds = connectedUsers.map(u => u._id.toString());

    // Send real-time update via Socket.IO
    sendToUsers(connectedUserIds, 'location:update', {
      userId: userId.toString(),
      userName: user.name,
      location: {
        latitude: location.latitude,
        longitude: location.longitude,
        address: location.address,
        placeName: location.placeName,
        timestamp: location.timestamp,
        isVisit: location.isVisit
      }
    });

    // Send push notification for visits
    if (location.isVisit && location.placeName) {
      for (const connectedUser of connectedUsers) {
        if (connectedUser.fcmToken) {
          await sendPushNotification(
            connectedUser.fcmToken,
            `${user.name} arrived`,
            `${user.name} arrived at ${location.placeName}`,
            {
              type: 'location_visit',
              userId: userId.toString(),
              locationId: location._id.toString()
            }
          );
        }
      }
    }
  } catch (error) {
    console.error('Error notifying connected users:', error);
  }
};

// Get users who can see location
const getLocationViewers = async (userId) => {
  const user = await User.findById(userId);
  if (!user) return [];

  return user.locationSharing.shareWith;
};

// Update location sharing settings
const updateLocationSharing = async (userId, enabled, shareWith = []) => {
  const user = await User.findById(userId);
  if (!user) throw new Error('User not found');

  user.locationSharing.enabled = enabled;
  user.locationSharing.shareWith = shareWith;
  await user.save();

  return user.locationSharing;
};

module.exports = {
  processLocationUpdate,
  calculateDistance,
  getLocationViewers,
  updateLocationSharing,
  VISIT_THRESHOLD,
  DISTANCE_THRESHOLD
};
