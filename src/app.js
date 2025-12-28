require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const http = require('http');

const connectDB = require('./config/database');
const { initializeSocket } = require('./config/socket');
const { initializeFirebase } = require('./services/push');

// Import routes
const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const connectionRoutes = require('./routes/connections');
const statusRoutes = require('./routes/status');
const notificationRoutes = require('./routes/notifications');
const locationRoutes = require('./routes/location');
const cycleRoutes = require('./routes/cycle');
const subscriptionRoutes = require('./routes/subscription');

const app = express();
const server = http.createServer(app);

// Initialize Socket.IO
initializeSocket(server);

// Initialize Firebase for push notifications
initializeFirebase();

// Connect to MongoDB
connectDB();

// Middleware
app.use(helmet());
app.use(cors());

// Parse JSON for all routes except Stripe webhook
app.use((req, res, next) => {
  if (req.originalUrl === '/api/subscription/webhook') {
    next();
  } else {
    express.json()(req, res, next);
  }
});

app.use(express.urlencoded({ extended: true }));

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// API Routes
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/connections', connectionRoutes);
app.use('/api/status', statusRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/location', locationRoutes);
app.use('/api/cycle', cycleRoutes);
app.use('/api/subscription', subscriptionRoutes);

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Error handler
app.use((err, req, res, next) => {
  console.error('Error:', err);
  res.status(err.status || 500).json({
    error: err.message || 'Internal server error'
  });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
});

module.exports = { app, server };
