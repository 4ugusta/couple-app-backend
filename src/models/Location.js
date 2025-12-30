const mongoose = require('mongoose');

const locationSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  latitude: {
    type: Number,
    required: true
  },
  longitude: {
    type: Number,
    required: true
  },
  address: {
    type: String,
    default: null
  },
  placeName: {
    type: String,
    default: null
  },
  timestamp: {
    type: Date,
    default: Date.now
  },
  isVisit: {
    type: Boolean,
    default: false
  },
  visitDuration: {
    type: Number, // in minutes
    default: 0
  },
  visitStartTime: {
    type: Date,
    default: null
  },
  visitEndTime: {
    type: Date,
    default: null
  }
}, {
  timestamps: true
});

// Index for user location queries
locationSchema.index({ userId: 1, timestamp: -1 });
locationSchema.index({ userId: 1, isVisit: 1 });

// Static method to get user's latest location
locationSchema.statics.getLatestLocation = async function(userId) {
  // Ensure userId is properly converted for query
  const mongoose = require('mongoose');
  const userObjectId = typeof userId === 'string' ? new mongoose.Types.ObjectId(userId) : userId;
  return await this.findOne({ userId: userObjectId }).sort({ timestamp: -1 });
};

// Static method to get user's visit history
locationSchema.statics.getVisitHistory = async function(userId, limit = 20) {
  const mongoose = require('mongoose');
  const userObjectId = typeof userId === 'string' ? new mongoose.Types.ObjectId(userId) : userId;
  return await this.find({ userId: userObjectId, isVisit: true })
    .sort({ timestamp: -1 })
    .limit(limit);
};

// Static method to get locations within time range
locationSchema.statics.getLocationHistory = async function(userId, startTime, endTime) {
  const mongoose = require('mongoose');
  const userObjectId = typeof userId === 'string' ? new mongoose.Types.ObjectId(userId) : userId;
  return await this.find({
    userId: userObjectId,
    timestamp: { $gte: startTime, $lte: endTime }
  }).sort({ timestamp: 1 });
};

module.exports = mongoose.model('Location', locationSchema);
