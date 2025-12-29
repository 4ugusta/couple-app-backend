const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const customStatusSchema = new mongoose.Schema({
  name: { type: String, required: true },
  emoji: { type: String, default: '📌' },
  isPremium: { type: Boolean, default: false }
}, { _id: true });

const customNotificationSchema = new mongoose.Schema({
  title: { type: String, required: true },
  message: { type: String, required: true },
  isPremium: { type: Boolean, default: false }
}, { _id: true });

const userSchema = new mongoose.Schema({
  phone: {
    type: String,
    unique: true,
    sparse: true,
    trim: true
  },
  email: {
    type: String,
    unique: true,
    sparse: true,
    lowercase: true,
    trim: true
  },
  password: {
    type: String,
    select: false
  },
  name: {
    type: String,
    required: true,
    trim: true
  },
  gender: {
    type: String,
    enum: ['male', 'female', 'other', 'prefer_not_to_say'],
    default: null
  },
  avatar: {
    type: String,
    default: null
  },
  isPremium: {
    type: Boolean,
    default: false
  },
  stripeCustomerId: {
    type: String,
    default: null
  },
  stripeSubscriptionId: {
    type: String,
    default: null
  },
  currentStatus: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Status',
    default: null
  },
  currentCustomStatus: {
    type: mongoose.Schema.Types.ObjectId,
    default: null
  },
  customStatuses: {
    type: [customStatusSchema],
    default: [],
    validate: {
      validator: function(v) {
        const freeCount = v.filter(s => !s.isPremium).length;
        const premiumCount = v.filter(s => s.isPremium).length;
        return freeCount <= 2 && premiumCount <= 5;
      },
      message: 'Maximum 2 free custom statuses and 5 premium custom statuses allowed'
    }
  },
  customNotifications: {
    type: [customNotificationSchema],
    default: [],
    validate: {
      validator: function(v) {
        const freeCount = v.filter(n => !n.isPremium).length;
        const premiumCount = v.filter(n => n.isPremium).length;
        return freeCount <= 2 && premiumCount <= 5;
      },
      message: 'Maximum 2 free custom notifications and 5 premium custom notifications allowed'
    }
  },
  locationSharing: {
    enabled: { type: Boolean, default: false },
    shareWith: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }]
  },
  fcmToken: {
    type: String,
    default: null
  },
  firebaseUid: {
    type: String,
    unique: true,
    sparse: true
    // No default - field will be undefined (not null) for sparse index to work
  },
  isVerified: {
    type: Boolean,
    default: false
  },
  lastActive: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true
});

// Hash password before saving
userSchema.pre('save', async function(next) {
  if (!this.isModified('password') || !this.password) {
    return next();
  }
  this.password = await bcrypt.hash(this.password, 12);
  next();
});

// Compare password method
userSchema.methods.comparePassword = async function(candidatePassword) {
  return await bcrypt.compare(candidatePassword, this.password);
};

// Get free custom status slots remaining
userSchema.methods.getFreeStatusSlots = function() {
  const used = this.customStatuses.filter(s => !s.isPremium).length;
  return 2 - used;
};

// Get premium custom status slots remaining
userSchema.methods.getPremiumStatusSlots = function() {
  if (!this.isPremium) return 0;
  const used = this.customStatuses.filter(s => s.isPremium).length;
  return 5 - used;
};

// Get free custom notification slots remaining
userSchema.methods.getFreeNotificationSlots = function() {
  const used = this.customNotifications.filter(n => !n.isPremium).length;
  return 2 - used;
};

// Get premium custom notification slots remaining
userSchema.methods.getPremiumNotificationSlots = function() {
  if (!this.isPremium) return 0;
  const used = this.customNotifications.filter(n => n.isPremium).length;
  return 5 - used;
};

module.exports = mongoose.model('User', userSchema);
