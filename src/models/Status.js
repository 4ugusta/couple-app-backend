const mongoose = require('mongoose');

const statusSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true
  },
  emoji: {
    type: String,
    default: '📌'
  },
  isDefault: {
    type: Boolean,
    default: false
  },
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  }
}, {
  timestamps: true
});

// Index for default statuses lookup
statusSchema.index({ isDefault: 1 });

// Static method to get default statuses
statusSchema.statics.getDefaultStatuses = async function() {
  return await this.find({ isDefault: true });
};

module.exports = mongoose.model('Status', statusSchema);
