const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema({
  senderId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  receiverId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  type: {
    type: String,
    enum: ['predefined', 'custom', 'location', 'cycle', 'status'],
    required: true
  },
  title: {
    type: String,
    required: true
  },
  message: {
    type: String,
    required: true
  },
  templateId: {
    type: String,
    default: null
  },
  isRead: {
    type: Boolean,
    default: false
  },
  data: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  }
}, {
  timestamps: true
});

// Index for user notifications
notificationSchema.index({ receiverId: 1, createdAt: -1 });
notificationSchema.index({ receiverId: 1, isRead: 1 });

// Predefined notification templates
notificationSchema.statics.PREDEFINED_TEMPLATES = [
  {
    id: 'thinking_of_you',
    title: 'Thinking of You',
    message: '💭 Someone is thinking about you right now!',
    emoji: '💭'
  },
  {
    id: 'call_me',
    title: 'Call Me',
    message: '📞 Please give me a call when you can!',
    emoji: '📞'
  },
  {
    id: 'on_my_way',
    title: 'On My Way',
    message: '🚗 I\'m on my way to you!',
    emoji: '🚗'
  }
];

// Static method to get predefined templates
notificationSchema.statics.getPredefinedTemplates = function() {
  return this.PREDEFINED_TEMPLATES;
};

// Static method to get user's notifications
notificationSchema.statics.getUserNotifications = async function(userId, limit = 50) {
  return await this.find({ receiverId: userId })
    .populate('senderId', 'name avatar')
    .sort({ createdAt: -1 })
    .limit(limit);
};

// Static method to mark notifications as read
notificationSchema.statics.markAsRead = async function(notificationIds, userId) {
  return await this.updateMany(
    { _id: { $in: notificationIds }, receiverId: userId },
    { isRead: true }
  );
};

module.exports = mongoose.model('Notification', notificationSchema);
