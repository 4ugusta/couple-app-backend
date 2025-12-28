const mongoose = require('mongoose');

const otpSchema = new mongoose.Schema({
  phone: {
    type: String,
    required: true
  },
  otp: {
    type: String,
    required: true
  },
  expiresAt: {
    type: Date,
    required: true,
    default: () => new Date(Date.now() + 10 * 60 * 1000) // 10 minutes
  },
  isUsed: {
    type: Boolean,
    default: false
  },
  attempts: {
    type: Number,
    default: 0
  }
}, {
  timestamps: true
});

// TTL index to automatically delete expired OTPs
otpSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
otpSchema.index({ phone: 1, createdAt: -1 });

// Static method to generate OTP
otpSchema.statics.generateOTP = function() {
  return Math.floor(100000 + Math.random() * 900000).toString();
};

// Static method to create new OTP
otpSchema.statics.createOTP = async function(phone) {
  // Invalidate any existing OTPs for this phone
  await this.updateMany({ phone, isUsed: false }, { isUsed: true });

  const otp = this.generateOTP();
  const otpDoc = await this.create({
    phone,
    otp,
    expiresAt: new Date(Date.now() + 10 * 60 * 1000)
  });

  return otpDoc;
};

// Static method to verify OTP
otpSchema.statics.verifyOTP = async function(phone, otp) {
  const otpDoc = await this.findOne({
    phone,
    otp,
    isUsed: false,
    expiresAt: { $gt: new Date() }
  });

  if (!otpDoc) {
    return { valid: false, message: 'Invalid or expired OTP' };
  }

  if (otpDoc.attempts >= 3) {
    return { valid: false, message: 'Too many attempts. Please request a new OTP' };
  }

  // Mark as used
  otpDoc.isUsed = true;
  await otpDoc.save();

  return { valid: true, message: 'OTP verified successfully' };
};

module.exports = mongoose.model('Otp', otpSchema);
