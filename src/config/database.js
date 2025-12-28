const mongoose = require('mongoose');

const connectDB = async () => {
  try {
    const conn = await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/couple-app');
    console.log(`MongoDB Connected: ${conn.connection.host}`);

    // Seed default statuses if they don't exist
    const Status = require('../models/Status');
    const defaultStatuses = [
      { name: 'Available', emoji: '🟢', isDefault: true },
      { name: 'Busy', emoji: '🔴', isDefault: true },
      { name: 'Do Not Disturb', emoji: '⛔', isDefault: true }
    ];

    for (const status of defaultStatuses) {
      await Status.findOneAndUpdate(
        { name: status.name, isDefault: true },
        status,
        { upsert: true, new: true }
      );
    }
    console.log('Default statuses seeded');

  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
};

module.exports = connectDB;
