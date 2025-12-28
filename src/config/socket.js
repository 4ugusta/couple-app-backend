const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');

let io;

const initializeSocket = (server) => {
  io = new Server(server, {
    cors: {
      origin: '*',
      methods: ['GET', 'POST']
    }
  });

  // Authentication middleware for socket connections
  io.use((socket, next) => {
    const token = socket.handshake.auth.token;
    if (!token) {
      return next(new Error('Authentication error'));
    }

    try {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      socket.userId = decoded.userId;
      next();
    } catch (err) {
      next(new Error('Authentication error'));
    }
  });

  io.on('connection', (socket) => {
    console.log(`User connected: ${socket.userId}`);

    // Join user's personal room
    socket.join(`user:${socket.userId}`);

    // Handle location updates
    socket.on('location:update', (data) => {
      // Broadcast to connected users
      socket.broadcast.emit(`location:${socket.userId}`, data);
    });

    // Handle status updates
    socket.on('status:update', (data) => {
      socket.broadcast.emit(`status:${socket.userId}`, data);
    });

    socket.on('disconnect', () => {
      console.log(`User disconnected: ${socket.userId}`);
    });
  });

  return io;
};

const getIO = () => {
  if (!io) {
    throw new Error('Socket.io not initialized');
  }
  return io;
};

// Send notification to specific user
const sendToUser = (userId, event, data) => {
  if (io) {
    io.to(`user:${userId}`).emit(event, data);
  }
};

// Send to multiple users
const sendToUsers = (userIds, event, data) => {
  if (io) {
    userIds.forEach(userId => {
      io.to(`user:${userId}`).emit(event, data);
    });
  }
};

module.exports = { initializeSocket, getIO, sendToUser, sendToUsers };
