const mongoose = require('mongoose');

const connectionSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  connectedUserId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  type: {
    type: String,
    enum: ['partner', 'close_friend'],
    required: true
  },
  status: {
    type: String,
    enum: ['pending', 'accepted', 'rejected', 'blocked'],
    default: 'pending'
  },
  nickname: {
    type: String,
    trim: true,
    default: null
  },
  initiatedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  }
}, {
  timestamps: true
});

// Ensure unique connection between two users
connectionSchema.index({ userId: 1, connectedUserId: 1 }, { unique: true });

// Static method to check if user already has a partner
connectionSchema.statics.hasPartner = async function(userId) {
  const partnerConnection = await this.findOne({
    $or: [
      { userId: userId, type: 'partner', status: 'accepted' },
      { connectedUserId: userId, type: 'partner', status: 'accepted' }
    ]
  });
  return !!partnerConnection;
};

// Static method to get all connections for a user
connectionSchema.statics.getConnections = async function(userId, status = 'accepted') {
  return await this.find({
    $or: [
      { userId: userId, status: status },
      { connectedUserId: userId, status: status }
    ]
  }).populate('userId connectedUserId', 'name avatar phone email currentStatus');
};

// Static method to get pending requests for a user
connectionSchema.statics.getPendingRequests = async function(userId) {
  return await this.find({
    connectedUserId: userId,
    status: 'pending'
  }).populate('userId', 'name avatar phone email');
};

module.exports = mongoose.model('Connection', connectionSchema);
