const User = require('../models/User');
const Connection = require('../models/Connection');
const Status = require('../models/Status');
const Notification = require('../models/Notification');
const Cycle = require('../models/Cycle');
const Location = require('../models/Location');
const { CacheService } = require('../services/cache');
const { sendToUser, sendToUsers } = require('../config/socket');
const { sendPushNotification } = require('../services/push');
const { GraphQLError } = require('graphql');

// Helper to check authentication
const requireAuth = (context) => {
  if (!context.user) {
    throw new GraphQLError('Not authenticated', {
      extensions: { code: 'UNAUTHENTICATED' }
    });
  }
  return context.user;
};

// Helper to format user status
const formatUserStatus = (user) => {
  if (user.currentStatus) {
    return {
      id: user.currentStatus._id,
      name: user.currentStatus.name,
      emoji: user.currentStatus.emoji,
      isDefault: user.currentStatus.isDefault
    };
  } else if (user.currentCustomStatus) {
    const customStatus = user.customStatuses?.id(user.currentCustomStatus);
    if (customStatus) {
      return {
        id: customStatus._id,
        name: customStatus.name,
        emoji: customStatus.emoji,
        isCustom: true
      };
    }
  }
  return null;
};

const resolvers = {
  Query: {
    // User queries
    me: async (_, __, context) => {
      const user = requireAuth(context);
      const fullUser = await User.findById(user._id)
        .populate('currentStatus');

      return {
        id: fullUser._id,
        name: fullUser.name,
        phone: fullUser.phone,
        email: fullUser.email,
        avatar: fullUser.avatar,
        isPremium: fullUser.isPremium,
        status: formatUserStatus(fullUser),
        customStatuses: fullUser.customStatuses,
        customNotifications: fullUser.customNotifications
      };
    },

    user: async (_, { id }, context) => {
      requireAuth(context);
      const user = await User.findById(id)
        .populate('currentStatus')
        .select('name avatar currentStatus currentCustomStatus customStatuses lastActive');

      if (!user) return null;

      return {
        id: user._id,
        name: user.name,
        avatar: user.avatar,
        status: formatUserStatus(user),
        lastActive: user.lastActive
      };
    },

    searchUser: async (_, { phone, email }, context) => {
      const user = requireAuth(context);

      if (!phone && !email) {
        throw new GraphQLError('Please provide phone or email to search');
      }

      const searchQuery = {};
      if (phone) {
        const cleanPhone = phone.replace(/[\s\-\(\)]/g, '');
        if (cleanPhone.startsWith('+')) {
          searchQuery.phone = cleanPhone;
        } else {
          searchQuery.phone = { $regex: cleanPhone + '$' };
        }
      }
      if (email) searchQuery.email = email.toLowerCase();

      const foundUser = await User.findOne(searchQuery).select('name avatar phone email');

      if (!foundUser || foundUser._id.toString() === user._id.toString()) {
        return null;
      }

      return foundUser;
    },

    // Connection queries
    connections: async (_, __, context) => {
      const user = requireAuth(context);

      const connections = await Connection.find({
        $or: [
          { userId: user._id, status: 'accepted' },
          { connectedUserId: user._id, status: 'accepted' }
        ]
      }).populate({
        path: 'userId connectedUserId',
        select: 'name avatar phone email currentStatus lastActive',
        populate: { path: 'currentStatus', select: 'name emoji' }
      });

      return connections.map(conn => {
        const isInitiator = conn.userId._id.toString() === user._id.toString();
        const otherUser = isInitiator ? conn.connectedUserId : conn.userId;

        return {
          id: conn._id,
          type: conn.type,
          status: conn.status,
          nickname: conn.nickname,
          user: {
            id: otherUser._id,
            name: otherUser.name,
            avatar: otherUser.avatar,
            phone: otherUser.phone,
            email: otherUser.email,
            lastActive: otherUser.lastActive,
            status: otherUser.currentStatus ? {
              id: otherUser.currentStatus._id,
              name: otherUser.currentStatus.name,
              emoji: otherUser.currentStatus.emoji
            } : null
          },
          createdAt: conn.createdAt
        };
      });
    },

    pendingRequests: async (_, __, context) => {
      const user = requireAuth(context);

      const requests = await Connection.find({
        connectedUserId: user._id,
        status: 'pending'
      }).populate('userId', 'name avatar phone email');

      return requests.map(req => ({
        id: req._id,
        type: req.type,
        user: {
          id: req.userId._id,
          name: req.userId.name,
          avatar: req.userId.avatar,
          phone: req.userId.phone
        },
        createdAt: req.createdAt
      }));
    },

    // Status queries
    statuses: async (_, __, context) => {
      const user = requireAuth(context);

      const defaultStatuses = await Status.getDefaultStatuses();
      const fullUser = await User.findById(user._id);

      return {
        defaultStatuses: defaultStatuses.map(s => ({
          id: s._id,
          name: s.name,
          emoji: s.emoji,
          isDefault: true
        })),
        customStatuses: fullUser.customStatuses.map(s => ({
          id: s._id,
          name: s.name,
          emoji: s.emoji,
          isPremium: s.isPremium
        })),
        slots: {
          freeUsed: fullUser.customStatuses.filter(s => !s.isPremium).length,
          freeTotal: 2,
          premiumUsed: fullUser.customStatuses.filter(s => s.isPremium).length,
          premiumTotal: fullUser.isPremium ? 5 : 0
        }
      };
    },

    currentStatus: async (_, __, context) => {
      const user = requireAuth(context);
      const fullUser = await User.findById(user._id).populate('currentStatus');
      return formatUserStatus(fullUser);
    },

    // Notification queries
    notifications: async (_, { limit = 50 }, context) => {
      const user = requireAuth(context);

      const notifications = await Notification.getUserNotifications(user._id, limit);

      return {
        notifications: notifications.map(n => ({
          id: n._id,
          type: n.type,
          title: n.title,
          message: n.message,
          sender: n.senderId ? {
            id: n.senderId._id,
            name: n.senderId.name,
            avatar: n.senderId.avatar
          } : null,
          isRead: n.isRead,
          data: n.data ? JSON.stringify(n.data) : null,
          createdAt: n.createdAt
        })),
        unreadCount: notifications.filter(n => !n.isRead).length
      };
    },

    notificationTemplates: async (_, __, context) => {
      const user = requireAuth(context);

      const predefined = Notification.getPredefinedTemplates();
      const fullUser = await User.findById(user._id);

      return {
        predefinedTemplates: predefined,
        customTemplates: fullUser.customNotifications.map(n => ({
          id: n._id,
          title: n.title,
          message: n.message,
          isPremium: n.isPremium
        })),
        slots: {
          freeUsed: fullUser.customNotifications.filter(n => !n.isPremium).length,
          freeTotal: 2,
          premiumUsed: fullUser.customNotifications.filter(n => n.isPremium).length,
          premiumTotal: fullUser.isPremium ? 5 : 0
        }
      };
    },

    // Cycle queries
    cycle: async (_, __, context) => {
      const user = requireAuth(context);

      let cycle = await Cycle.findOne({ userId: user._id })
        .populate('shareWith', 'name avatar');

      if (!cycle) {
        cycle = await Cycle.create({
          userId: user._id,
          cycleLength: 28,
          periodLength: 5,
          isTracking: true
        });
      }

      return {
        id: cycle._id,
        cycleLength: cycle.cycleLength,
        periodLength: cycle.periodLength,
        lastPeriodStart: cycle.lastPeriodStart,
        isTracking: cycle.isTracking,
        currentPhase: cycle.getCurrentPhase(),
        nextPeriod: cycle.getPredictedNextPeriod(),
        fertileWindow: cycle.getFertileWindow(),
        recentPeriods: cycle.periods.slice(-6).reverse(),
        shareWith: cycle.shareWith.map(u => ({
          id: u._id,
          name: u.name,
          avatar: u.avatar
        }))
      };
    },

    userCycle: async (_, { userId }, context) => {
      const user = requireAuth(context);

      // Check if connected
      const connection = await Connection.findOne({
        $or: [
          { userId: user._id, connectedUserId: userId, status: 'accepted' },
          { userId: userId, connectedUserId: user._id, status: 'accepted' }
        ]
      });

      if (!connection) {
        throw new GraphQLError('Not connected with this user');
      }

      const cycle = await Cycle.findOne({
        userId,
        shareWith: user._id
      });

      if (!cycle) {
        throw new GraphQLError('User is not sharing cycle data');
      }

      return {
        id: cycle._id,
        cycleLength: cycle.cycleLength,
        periodLength: cycle.periodLength,
        lastPeriodStart: cycle.lastPeriodStart,
        isTracking: cycle.isTracking,
        currentPhase: cycle.getCurrentPhase(),
        nextPeriod: cycle.getPredictedNextPeriod(),
        fertileWindow: cycle.getFertileWindow(),
        recentPeriods: cycle.periods.slice(-3).reverse(),
        shareWith: []
      };
    },

    symptoms: async (_, { startDate, endDate }, context) => {
      const user = requireAuth(context);

      const start = startDate ? new Date(startDate) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const end = endDate ? new Date(endDate) : new Date();

      const cycle = await Cycle.findOne({ userId: user._id });

      if (!cycle) return [];

      return cycle.symptoms
        .filter(s => s.date >= start && s.date <= end)
        .sort((a, b) => b.date - a.date);
    },

    // Location queries
    locationSharing: async (_, __, context) => {
      const user = requireAuth(context);

      const fullUser = await User.findById(user._id)
        .populate('locationSharing.shareWith', 'name avatar');

      return {
        enabled: fullUser.locationSharing.enabled,
        shareWith: fullUser.locationSharing.shareWith.map(u => ({
          id: u._id,
          name: u.name,
          avatar: u.avatar
        }))
      };
    },

    userLocation: async (_, { userId }, context) => {
      const user = requireAuth(context);

      // Check if connected
      const connection = await Connection.findOne({
        $or: [
          { userId: user._id, connectedUserId: userId, status: 'accepted' },
          { userId: userId, connectedUserId: user._id, status: 'accepted' }
        ]
      });

      if (!connection) {
        throw new GraphQLError('Not connected with this user');
      }

      // Check if sharing
      const targetUser = await User.findById(userId);
      if (!targetUser.locationSharing.enabled ||
          !targetUser.locationSharing.shareWith.some(id => id.toString() === user._id.toString())) {
        throw new GraphQLError('User is not sharing location');
      }

      return await Location.getLatestLocation(userId);
    },

    userLocationHistory: async (_, { userId, startDate, endDate }, context) => {
      const user = requireAuth(context);

      // Check if connected and sharing (same as userLocation)
      const connection = await Connection.findOne({
        $or: [
          { userId: user._id, connectedUserId: userId, status: 'accepted' },
          { userId: userId, connectedUserId: user._id, status: 'accepted' }
        ]
      });

      if (!connection) {
        throw new GraphQLError('Not connected with this user');
      }

      const targetUser = await User.findById(userId);
      if (!targetUser.locationSharing.enabled ||
          !targetUser.locationSharing.shareWith.some(id => id.toString() === user._id.toString())) {
        throw new GraphQLError('User is not sharing location');
      }

      const start = startDate ? new Date(startDate) : new Date(Date.now() - 24 * 60 * 60 * 1000);
      const end = endDate ? new Date(endDate) : new Date();

      return await Location.getLocationHistory(userId, start, end);
    },

    myLocationHistory: async (_, { startDate, endDate }, context) => {
      const user = requireAuth(context);

      const start = startDate ? new Date(startDate) : new Date(Date.now() - 24 * 60 * 60 * 1000);
      const end = endDate ? new Date(endDate) : new Date();

      return await Location.getLocationHistory(user._id, start, end);
    }
  },

  Mutation: {
    // Profile mutations
    updateProfile: async (_, { name, avatar }, context) => {
      const user = requireAuth(context);

      const updates = {};
      if (name) updates.name = name;
      if (avatar) updates.avatar = avatar;

      const updatedUser = await User.findByIdAndUpdate(
        user._id,
        updates,
        { new: true }
      ).populate('currentStatus');

      await CacheService.invalidateUser(user._id.toString());

      return {
        id: updatedUser._id,
        name: updatedUser.name,
        avatar: updatedUser.avatar,
        status: formatUserStatus(updatedUser)
      };
    },

    updateFcmToken: async (_, { token }, context) => {
      const user = requireAuth(context);
      await User.findByIdAndUpdate(user._id, { fcmToken: token });
      return true;
    },

    // Connection mutations
    sendConnectionRequest: async (_, { userId, type }, context) => {
      const user = requireAuth(context);

      if (userId === user._id.toString()) {
        throw new GraphQLError('Cannot connect with yourself');
      }

      const targetUser = await User.findById(userId);
      if (!targetUser) {
        throw new GraphQLError('User not found');
      }

      const existingConnection = await Connection.findOne({
        $or: [
          { userId: user._id, connectedUserId: userId },
          { userId: userId, connectedUserId: user._id }
        ]
      });

      if (existingConnection) {
        if (existingConnection.status === 'accepted') {
          throw new GraphQLError('Already connected');
        }
        if (existingConnection.status === 'pending') {
          throw new GraphQLError('Request already pending');
        }
        if (existingConnection.status === 'blocked') {
          throw new GraphQLError('Cannot connect with this user');
        }
      }

      if (type === 'partner') {
        const userHasPartner = await Connection.hasPartner(user._id);
        if (userHasPartner) {
          throw new GraphQLError('You already have a partner');
        }

        const targetHasPartner = await Connection.hasPartner(userId);
        if (targetHasPartner) {
          throw new GraphQLError('This user already has a partner');
        }
      }

      const connection = await Connection.create({
        userId: user._id,
        connectedUserId: userId,
        type,
        status: 'pending',
        initiatedBy: user._id
      });

      // Notify via Socket.IO
      sendToUser(userId, 'connection:request', {
        id: connection._id,
        type,
        user: { id: user._id, name: user.name, avatar: user.avatar }
      });

      // Send push notification
      if (targetUser.fcmToken) {
        await sendPushNotification(
          targetUser.fcmToken,
          'New Connection Request',
          `${user.name} wants to connect as your ${type === 'partner' ? 'partner' : 'close friend'}`,
          { type: 'connection_request', connectionId: connection._id.toString() }
        );
      }

      return {
        id: connection._id,
        type: connection.type,
        status: connection.status,
        user: { id: targetUser._id, name: targetUser.name, avatar: targetUser.avatar },
        createdAt: connection.createdAt
      };
    },

    acceptConnection: async (_, { connectionId }, context) => {
      const user = requireAuth(context);

      const connection = await Connection.findOne({
        _id: connectionId,
        connectedUserId: user._id,
        status: 'pending'
      });

      if (!connection) {
        throw new GraphQLError('Connection request not found');
      }

      if (connection.type === 'partner') {
        const hasPartner = await Connection.hasPartner(user._id);
        if (hasPartner) {
          throw new GraphQLError('You already have a partner');
        }
      }

      connection.status = 'accepted';
      await connection.save();

      await CacheService.invalidateConnectionPair(user._id.toString(), connection.userId.toString());

      const requester = await User.findById(connection.userId);

      sendToUser(connection.userId.toString(), 'connection:accepted', {
        id: connection._id,
        user: { id: user._id, name: user.name, avatar: user.avatar }
      });

      if (requester.fcmToken) {
        await sendPushNotification(
          requester.fcmToken,
          'Connection Accepted',
          `${user.name} accepted your connection request!`,
          { type: 'connection_accepted', connectionId: connection._id.toString() }
        );
      }

      return {
        id: connection._id,
        type: connection.type,
        status: connection.status,
        user: { id: requester._id, name: requester.name, avatar: requester.avatar },
        createdAt: connection.createdAt
      };
    },

    rejectConnection: async (_, { connectionId }, context) => {
      const user = requireAuth(context);

      const connection = await Connection.findOne({
        _id: connectionId,
        connectedUserId: user._id,
        status: 'pending'
      });

      if (!connection) {
        throw new GraphQLError('Connection request not found');
      }

      connection.status = 'rejected';
      await connection.save();

      await CacheService.invalidateConnectionPair(user._id.toString(), connection.userId.toString());

      return true;
    },

    removeConnection: async (_, { connectionId }, context) => {
      const user = requireAuth(context);

      const connection = await Connection.findOneAndDelete({
        _id: connectionId,
        $or: [{ userId: user._id }, { connectedUserId: user._id }]
      });

      if (!connection) {
        throw new GraphQLError('Connection not found');
      }

      const otherUserId = connection.userId.toString() === user._id.toString()
        ? connection.connectedUserId.toString()
        : connection.userId.toString();

      await CacheService.invalidateConnectionPair(user._id.toString(), otherUserId);

      sendToUser(otherUserId, 'connection:removed', { connectionId: connection._id });

      return true;
    },

    blockConnection: async (_, { connectionId }, context) => {
      const user = requireAuth(context);

      const connection = await Connection.findOne({
        _id: connectionId,
        $or: [{ userId: user._id }, { connectedUserId: user._id }]
      });

      if (!connection) {
        throw new GraphQLError('Connection not found');
      }

      connection.status = 'blocked';
      await connection.save();

      const otherUserId = connection.userId.toString() === user._id.toString()
        ? connection.connectedUserId.toString()
        : connection.userId.toString();

      await CacheService.invalidateConnectionPair(user._id.toString(), otherUserId);

      return true;
    },

    updateNickname: async (_, { connectionId, nickname }, context) => {
      const user = requireAuth(context);

      const connection = await Connection.findOne({
        _id: connectionId,
        $or: [{ userId: user._id }, { connectedUserId: user._id }],
        status: 'accepted'
      });

      if (!connection) {
        throw new GraphQLError('Connection not found');
      }

      connection.nickname = nickname;
      await connection.save();

      return {
        id: connection._id,
        type: connection.type,
        status: connection.status,
        nickname: connection.nickname,
        createdAt: connection.createdAt
      };
    },

    // Status mutations
    setStatus: async (_, { statusId }, context) => {
      const user = requireAuth(context);

      const status = await Status.findOne({ _id: statusId, isDefault: true });
      if (!status) {
        throw new GraphQLError('Status not found');
      }

      await User.findByIdAndUpdate(user._id, {
        currentStatus: statusId,
        currentCustomStatus: null
      });

      await CacheService.invalidateStatuses(user._id.toString());

      return {
        id: status._id,
        name: status.name,
        emoji: status.emoji,
        isDefault: true
      };
    },

    setCustomStatus: async (_, { customStatusId }, context) => {
      const user = requireAuth(context);

      const fullUser = await User.findById(user._id);
      const customStatus = fullUser.customStatuses.id(customStatusId);

      if (!customStatus) {
        throw new GraphQLError('Custom status not found');
      }

      if (customStatus.isPremium && !fullUser.isPremium) {
        throw new GraphQLError('Premium subscription required');
      }

      fullUser.currentStatus = null;
      fullUser.currentCustomStatus = customStatusId;
      await fullUser.save();

      await CacheService.invalidateStatuses(user._id.toString());

      return {
        id: customStatus._id,
        name: customStatus.name,
        emoji: customStatus.emoji,
        isCustom: true
      };
    },

    createCustomStatus: async (_, { name, emoji }, context) => {
      const user = requireAuth(context);

      const fullUser = await User.findById(user._id);

      const freeUsed = fullUser.customStatuses.filter(s => !s.isPremium).length;
      if (freeUsed >= 2) {
        throw new GraphQLError('Free status slots full');
      }

      const exists = fullUser.customStatuses.some(s => s.name.toLowerCase() === name.toLowerCase());
      if (exists) {
        throw new GraphQLError('Status with this name already exists');
      }

      fullUser.customStatuses.push({
        name,
        emoji: emoji || '📌',
        isPremium: false
      });

      await fullUser.save();
      await CacheService.invalidateStatuses(user._id.toString());

      const newStatus = fullUser.customStatuses[fullUser.customStatuses.length - 1];
      return newStatus;
    },

    createPremiumCustomStatus: async (_, { name, emoji }, context) => {
      const user = requireAuth(context);

      const fullUser = await User.findById(user._id);

      if (!fullUser.isPremium) {
        throw new GraphQLError('Premium subscription required');
      }

      const premiumUsed = fullUser.customStatuses.filter(s => s.isPremium).length;
      if (premiumUsed >= 5) {
        throw new GraphQLError('Premium status slots full');
      }

      fullUser.customStatuses.push({
        name,
        emoji: emoji || '📌',
        isPremium: true
      });

      await fullUser.save();
      await CacheService.invalidateStatuses(user._id.toString());

      const newStatus = fullUser.customStatuses[fullUser.customStatuses.length - 1];
      return newStatus;
    },

    updateCustomStatus: async (_, { statusId, name, emoji }, context) => {
      const user = requireAuth(context);

      const fullUser = await User.findById(user._id);
      const customStatus = fullUser.customStatuses.id(statusId);

      if (!customStatus) {
        throw new GraphQLError('Custom status not found');
      }

      if (name) customStatus.name = name;
      if (emoji) customStatus.emoji = emoji;

      await fullUser.save();
      await CacheService.invalidateStatuses(user._id.toString());

      return customStatus;
    },

    deleteCustomStatus: async (_, { statusId }, context) => {
      const user = requireAuth(context);

      const fullUser = await User.findById(user._id);
      const customStatus = fullUser.customStatuses.id(statusId);

      if (!customStatus) {
        throw new GraphQLError('Custom status not found');
      }

      if (fullUser.currentCustomStatus?.toString() === statusId) {
        fullUser.currentCustomStatus = null;
        const defaultStatus = await Status.findOne({ name: 'Available', isDefault: true });
        if (defaultStatus) {
          fullUser.currentStatus = defaultStatus._id;
        }
      }

      fullUser.customStatuses.pull(statusId);
      await fullUser.save();
      await CacheService.invalidateStatuses(user._id.toString());

      return true;
    },

    // Notification mutations
    sendPredefinedNotification: async (_, { receiverId, templateId }, context) => {
      const user = requireAuth(context);

      const connection = await Connection.findOne({
        $or: [
          { userId: user._id, connectedUserId: receiverId, status: 'accepted' },
          { userId: receiverId, connectedUserId: user._id, status: 'accepted' }
        ]
      });

      if (!connection) {
        throw new GraphQLError('Not connected with this user');
      }

      const templates = Notification.getPredefinedTemplates();
      const template = templates.find(t => t.id === templateId);

      if (!template) {
        throw new GraphQLError('Invalid template');
      }

      const notification = await Notification.create({
        senderId: user._id,
        receiverId,
        type: 'predefined',
        title: template.title,
        message: template.message,
        templateId
      });

      await CacheService.invalidateNotifications(receiverId);

      sendToUser(receiverId, 'notification:new', {
        id: notification._id,
        type: 'predefined',
        title: template.title,
        message: template.message,
        sender: { id: user._id, name: user.name, avatar: user.avatar },
        createdAt: notification.createdAt
      });

      const receiver = await User.findById(receiverId);
      if (receiver?.fcmToken) {
        await sendPushNotification(
          receiver.fcmToken,
          `${user.name}: ${template.title}`,
          template.message,
          { type: 'notification', notificationId: notification._id.toString() }
        );
      }

      return {
        id: notification._id,
        type: notification.type,
        title: notification.title,
        message: notification.message,
        isRead: notification.isRead,
        createdAt: notification.createdAt
      };
    },

    sendCustomNotification: async (_, { receiverId, customNotificationId }, context) => {
      const user = requireAuth(context);

      const connection = await Connection.findOne({
        $or: [
          { userId: user._id, connectedUserId: receiverId, status: 'accepted' },
          { userId: receiverId, connectedUserId: user._id, status: 'accepted' }
        ]
      });

      if (!connection) {
        throw new GraphQLError('Not connected with this user');
      }

      const fullUser = await User.findById(user._id);
      const customTemplate = fullUser.customNotifications.id(customNotificationId);

      if (!customTemplate) {
        throw new GraphQLError('Custom notification not found');
      }

      if (customTemplate.isPremium && !fullUser.isPremium) {
        throw new GraphQLError('Premium subscription required');
      }

      const notification = await Notification.create({
        senderId: user._id,
        receiverId,
        type: 'custom',
        title: customTemplate.title,
        message: customTemplate.message,
        templateId: customNotificationId.toString()
      });

      await CacheService.invalidateNotifications(receiverId);

      sendToUser(receiverId, 'notification:new', {
        id: notification._id,
        type: 'custom',
        title: customTemplate.title,
        message: customTemplate.message,
        sender: { id: user._id, name: user.name, avatar: user.avatar },
        createdAt: notification.createdAt
      });

      return {
        id: notification._id,
        type: notification.type,
        title: notification.title,
        message: notification.message,
        isRead: notification.isRead,
        createdAt: notification.createdAt
      };
    },

    createCustomNotification: async (_, { title, message }, context) => {
      const user = requireAuth(context);

      const fullUser = await User.findById(user._id);

      const freeUsed = fullUser.customNotifications.filter(n => !n.isPremium).length;
      if (freeUsed >= 2) {
        throw new GraphQLError('Free notification slots full');
      }

      fullUser.customNotifications.push({ title, message, isPremium: false });
      await fullUser.save();

      return fullUser.customNotifications[fullUser.customNotifications.length - 1];
    },

    createPremiumCustomNotification: async (_, { title, message }, context) => {
      const user = requireAuth(context);

      const fullUser = await User.findById(user._id);

      if (!fullUser.isPremium) {
        throw new GraphQLError('Premium subscription required');
      }

      const premiumUsed = fullUser.customNotifications.filter(n => n.isPremium).length;
      if (premiumUsed >= 5) {
        throw new GraphQLError('Premium notification slots full');
      }

      fullUser.customNotifications.push({ title, message, isPremium: true });
      await fullUser.save();

      return fullUser.customNotifications[fullUser.customNotifications.length - 1];
    },

    markNotificationsAsRead: async (_, { notificationIds }, context) => {
      const user = requireAuth(context);

      await Notification.markAsRead(notificationIds, user._id);
      await CacheService.invalidateNotifications(user._id.toString());

      return true;
    },

    markAllNotificationsAsRead: async (_, __, context) => {
      const user = requireAuth(context);

      await Notification.updateMany(
        { receiverId: user._id, isRead: false },
        { isRead: true }
      );
      await CacheService.invalidateNotifications(user._id.toString());

      return true;
    },

    // Cycle mutations
    startPeriod: async (_, { date, flow }, context) => {
      const user = requireAuth(context);

      const startDate = date ? new Date(date) : new Date();
      const flowType = flow || 'medium';

      let cycle = await Cycle.findOne({ userId: user._id });

      if (!cycle) {
        cycle = await Cycle.create({
          userId: user._id,
          cycleLength: 28,
          periodLength: 5,
          isTracking: true
        });
      }

      const lastPeriod = cycle.periods[cycle.periods.length - 1];
      if (lastPeriod && !lastPeriod.endDate) {
        throw new GraphQLError('There is already an ongoing period');
      }

      if (cycle.lastPeriodStart) {
        const daysBetween = Math.round((startDate - cycle.lastPeriodStart) / (1000 * 60 * 60 * 24));
        if (daysBetween >= 21 && daysBetween <= 45) {
          cycle.cycleLength = Math.round((cycle.cycleLength * 0.7) + (daysBetween * 0.3));
        }
      }

      cycle.periods.push({ startDate, endDate: null, flow: flowType });
      cycle.lastPeriodStart = startDate;
      await cycle.save();

      await CacheService.invalidateCycle(user._id.toString());

      return cycle.periods[cycle.periods.length - 1];
    },

    endPeriod: async (_, { date }, context) => {
      const user = requireAuth(context);

      const endDate = date ? new Date(date) : new Date();

      const cycle = await Cycle.findOne({ userId: user._id });

      if (!cycle) {
        throw new GraphQLError('Cycle data not found');
      }

      const lastPeriod = cycle.periods[cycle.periods.length - 1];
      if (!lastPeriod || lastPeriod.endDate) {
        throw new GraphQLError('No ongoing period to end');
      }

      const periodDays = Math.round((endDate - lastPeriod.startDate) / (1000 * 60 * 60 * 24)) + 1;

      if (periodDays < 1) {
        throw new GraphQLError('End date cannot be before start date');
      }

      lastPeriod.endDate = endDate;

      if (periodDays >= 1 && periodDays <= 10) {
        cycle.periodLength = Math.round((cycle.periodLength * 0.7) + (periodDays * 0.3));
      }

      await cycle.save();
      await CacheService.invalidateCycle(user._id.toString());

      return lastPeriod;
    },

    logPeriod: async (_, { startDate, endDate, flow }, context) => {
      const user = requireAuth(context);

      const start = new Date(startDate);
      const end = endDate ? new Date(endDate) : null;
      const flowType = flow || 'medium';

      if (end && end < start) {
        throw new GraphQLError('End date cannot be before start date');
      }

      let cycle = await Cycle.findOne({ userId: user._id });

      if (!cycle) {
        cycle = await Cycle.create({
          userId: user._id,
          cycleLength: 28,
          periodLength: 5,
          isTracking: true
        });
      }

      const newPeriod = { startDate: start, endDate: end, flow: flowType };
      cycle.periods.push(newPeriod);
      cycle.periods.sort((a, b) => a.startDate - b.startDate);

      const mostRecentPeriod = cycle.periods[cycle.periods.length - 1];
      if (mostRecentPeriod.startDate.getTime() === start.getTime()) {
        cycle.lastPeriodStart = start;
      }

      await cycle.save();
      await CacheService.invalidateCycle(user._id.toString());

      return newPeriod;
    },

    logSymptom: async (_, { date, type, severity, notes }, context) => {
      const user = requireAuth(context);

      const symptomDate = date ? new Date(date) : new Date();

      let cycle = await Cycle.findOne({ userId: user._id });

      if (!cycle) {
        cycle = await Cycle.create({
          userId: user._id,
          cycleLength: 28,
          periodLength: 5,
          isTracking: true
        });
      }

      cycle.symptoms.push({
        date: symptomDate,
        type,
        severity: severity || 3,
        notes
      });

      await cycle.save();
      await CacheService.invalidateCycle(user._id.toString());

      return cycle.symptoms[cycle.symptoms.length - 1];
    },

    updateCycleSettings: async (_, { cycleLength, periodLength, isTracking }, context) => {
      const user = requireAuth(context);

      let cycle = await Cycle.findOne({ userId: user._id });

      if (!cycle) {
        cycle = await Cycle.create({
          userId: user._id,
          cycleLength: cycleLength || 28,
          periodLength: periodLength || 5,
          isTracking: isTracking !== undefined ? isTracking : true
        });
      } else {
        if (cycleLength !== undefined) cycle.cycleLength = cycleLength;
        if (periodLength !== undefined) cycle.periodLength = periodLength;
        if (isTracking !== undefined) cycle.isTracking = isTracking;
        await cycle.save();
      }

      await CacheService.invalidateCycle(user._id.toString());

      return {
        id: cycle._id,
        cycleLength: cycle.cycleLength,
        periodLength: cycle.periodLength,
        isTracking: cycle.isTracking,
        lastPeriodStart: cycle.lastPeriodStart,
        currentPhase: cycle.getCurrentPhase(),
        nextPeriod: cycle.getPredictedNextPeriod(),
        fertileWindow: cycle.getFertileWindow(),
        recentPeriods: cycle.periods.slice(-6).reverse(),
        shareWith: []
      };
    },

    updateCycleSharing: async (_, { shareWith }, context) => {
      const user = requireAuth(context);

      const connections = await Connection.find({
        $or: [
          { userId: user._id, status: 'accepted' },
          { connectedUserId: user._id, status: 'accepted' }
        ]
      });

      const connectedUserIds = connections.map(conn => {
        const isInitiator = conn.userId.toString() === user._id.toString();
        return (isInitiator ? conn.connectedUserId : conn.userId).toString();
      });

      const validShareWith = shareWith.filter(id => connectedUserIds.includes(id));

      let cycle = await Cycle.findOne({ userId: user._id });

      if (!cycle) {
        cycle = await Cycle.create({
          userId: user._id,
          shareWith: validShareWith
        });
      } else {
        cycle.shareWith = validShareWith;
        await cycle.save();
      }

      await CacheService.invalidateCycle(user._id.toString());

      const updatedCycle = await Cycle.findById(cycle._id)
        .populate('shareWith', 'name avatar');

      return {
        id: updatedCycle._id,
        cycleLength: updatedCycle.cycleLength,
        periodLength: updatedCycle.periodLength,
        isTracking: updatedCycle.isTracking,
        lastPeriodStart: updatedCycle.lastPeriodStart,
        currentPhase: updatedCycle.getCurrentPhase(),
        nextPeriod: updatedCycle.getPredictedNextPeriod(),
        fertileWindow: updatedCycle.getFertileWindow(),
        recentPeriods: updatedCycle.periods.slice(-6).reverse(),
        shareWith: updatedCycle.shareWith.map(u => ({
          id: u._id,
          name: u.name,
          avatar: u.avatar
        }))
      };
    },

    // Location mutations
    updateLocation: async (_, { latitude, longitude, address, placeName }, context) => {
      const user = requireAuth(context);

      const fullUser = await User.findById(user._id);
      if (!fullUser.locationSharing.enabled) {
        throw new GraphQLError('Location sharing is disabled');
      }

      const { processLocationUpdate } = require('../services/location');
      const location = await processLocationUpdate(user._id, latitude, longitude, address, placeName);

      return location;
    },

    updateLocationSharing: async (_, { enabled, shareWith }, context) => {
      const user = requireAuth(context);

      let validShareWith = [];

      if (shareWith && shareWith.length > 0) {
        const connections = await Connection.find({
          $or: [
            { userId: user._id, status: 'accepted' },
            { connectedUserId: user._id, status: 'accepted' }
          ]
        });

        const connectedUserIds = connections.map(conn => {
          const isInitiator = conn.userId.toString() === user._id.toString();
          return (isInitiator ? conn.connectedUserId : conn.userId).toString();
        });

        validShareWith = shareWith.filter(id => connectedUserIds.includes(id));
      }

      const { updateLocationSharing } = require('../services/location');
      await updateLocationSharing(user._id, enabled, validShareWith);

      await CacheService.invalidateLocation(user._id.toString());

      const fullUser = await User.findById(user._id)
        .populate('locationSharing.shareWith', 'name avatar');

      return {
        enabled: fullUser.locationSharing.enabled,
        shareWith: fullUser.locationSharing.shareWith.map(u => ({
          id: u._id,
          name: u.name,
          avatar: u.avatar
        }))
      };
    }
  }
};

module.exports = resolvers;
