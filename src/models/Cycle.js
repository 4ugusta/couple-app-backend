const mongoose = require('mongoose');

const symptomSchema = new mongoose.Schema({
  date: {
    type: Date,
    required: true
  },
  type: {
    type: String,
    enum: ['cramps', 'headache', 'mood_swings', 'bloating', 'fatigue', 'breast_tenderness', 'acne', 'back_pain', 'nausea', 'other'],
    required: true
  },
  severity: {
    type: Number,
    min: 1,
    max: 5,
    default: 3
  },
  notes: {
    type: String,
    default: null
  }
}, { _id: true });

const periodSchema = new mongoose.Schema({
  startDate: {
    type: Date,
    required: true
  },
  endDate: {
    type: Date,
    default: null
  },
  flow: {
    type: String,
    enum: ['light', 'medium', 'heavy'],
    default: 'medium'
  }
}, { _id: true });

const cycleSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    unique: true
  },
  cycleLength: {
    type: Number,
    default: 28,
    min: 21,
    max: 45
  },
  periodLength: {
    type: Number,
    default: 5,
    min: 1,
    max: 10
  },
  periods: {
    type: [periodSchema],
    default: []
  },
  symptoms: {
    type: [symptomSchema],
    default: []
  },
  shareWith: [{
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }],
  lastPeriodStart: {
    type: Date,
    default: null
  },
  lastPeriodEnd: {
    type: Date,
    default: null
  },
  expectedNextPeriod: {
    startDate: {
      type: Date,
      default: null
    },
    endDate: {
      type: Date,
      default: null
    },
    isManuallySet: {
      type: Boolean,
      default: false
    }
  },
  isTracking: {
    type: Boolean,
    default: true
  }
}, {
  timestamps: true
});

// Index for shareWith lookup (userId index already created by unique: true)
cycleSchema.index({ shareWith: 1 });

// Get next period (manually set or calculated)
cycleSchema.methods.getNextPeriod = function() {
  // If manually set, return that
  if (this.expectedNextPeriod && this.expectedNextPeriod.isManuallySet && this.expectedNextPeriod.startDate) {
    return {
      startDate: this.expectedNextPeriod.startDate,
      endDate: this.expectedNextPeriod.endDate,
      isManuallySet: true
    };
  }

  // Otherwise calculate from last period
  if (!this.lastPeriodStart) return null;

  const predictedStart = new Date(this.lastPeriodStart);
  predictedStart.setDate(predictedStart.getDate() + this.cycleLength);

  const predictedEnd = new Date(predictedStart);
  predictedEnd.setDate(predictedEnd.getDate() + this.periodLength - 1);

  return {
    startDate: predictedStart,
    endDate: predictedEnd,
    isManuallySet: false
  };
};

// Legacy method for backwards compatibility
cycleSchema.methods.getPredictedNextPeriod = function() {
  const next = this.getNextPeriod();
  return next ? next.startDate : null;
};

// Get last period details
cycleSchema.methods.getLastPeriod = function() {
  if (!this.lastPeriodStart) return null;

  return {
    startDate: this.lastPeriodStart,
    endDate: this.lastPeriodEnd,
    daysAgo: Math.floor((new Date() - this.lastPeriodStart) / (1000 * 60 * 60 * 24))
  };
};

// Calculate current cycle day
cycleSchema.methods.getCurrentCycleDay = function() {
  if (!this.lastPeriodStart) return null;
  const today = new Date();
  const diffTime = Math.abs(today - this.lastPeriodStart);
  const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
  return diffDays % this.cycleLength || this.cycleLength;
};

// Get current phase
cycleSchema.methods.getCurrentPhase = function() {
  const cycleDay = this.getCurrentCycleDay();
  if (!cycleDay) return null;

  if (cycleDay <= this.periodLength) {
    return { phase: 'menstrual', name: 'Period', day: cycleDay };
  } else if (cycleDay <= 13) {
    return { phase: 'follicular', name: 'Follicular Phase', day: cycleDay };
  } else if (cycleDay <= 16) {
    return { phase: 'ovulation', name: 'Ovulation Window', day: cycleDay };
  } else {
    return { phase: 'luteal', name: 'Luteal Phase', day: cycleDay };
  }
};

// Get fertile window (typically days 10-16 of cycle)
cycleSchema.methods.getFertileWindow = function() {
  if (!this.lastPeriodStart) return null;

  const fertileStart = new Date(this.lastPeriodStart);
  fertileStart.setDate(fertileStart.getDate() + 10);

  const fertileEnd = new Date(this.lastPeriodStart);
  fertileEnd.setDate(fertileEnd.getDate() + 16);

  const ovulationDay = new Date(this.lastPeriodStart);
  ovulationDay.setDate(ovulationDay.getDate() + 14);

  return {
    start: fertileStart,
    end: fertileEnd,
    ovulationDay: ovulationDay
  };
};

module.exports = mongoose.model('Cycle', cycleSchema);
