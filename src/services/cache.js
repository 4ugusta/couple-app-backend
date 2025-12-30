const { Redis } = require('@upstash/redis');

// Initialize Upstash Redis client
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// Default TTL values (in seconds)
const TTL = {
  USER: 600,           // 10 minutes
  CONNECTIONS: 300,    // 5 minutes
  STATUSES: 1800,      // 30 minutes
  NOTIFICATIONS: 120,  // 2 minutes
  CYCLE: 1800,         // 30 minutes
  LOCATION: 300,       // 5 minutes
  SEARCH: 900,         // 15 minutes
};

/**
 * Cache Service for Upstash Redis
 * Provides caching layer to reduce MongoDB load
 */
const CacheService = {
  /**
   * Get a value from cache
   * @param {string} key - Cache key
   * @returns {Promise<any|null>} - Cached value or null
   */
  async get(key) {
    try {
      const value = await redis.get(key);
      return value;
    } catch (error) {
      console.error('Cache GET error:', error.message);
      return null;
    }
  },

  /**
   * Set a value in cache
   * @param {string} key - Cache key
   * @param {any} value - Value to cache
   * @param {number} ttl - Time to live in seconds
   */
  async set(key, value, ttl = 300) {
    try {
      await redis.set(key, value, { ex: ttl });
    } catch (error) {
      console.error('Cache SET error:', error.message);
    }
  },

  /**
   * Delete a specific key from cache
   * @param {string} key - Cache key to delete
   */
  async del(key) {
    try {
      await redis.del(key);
    } catch (error) {
      console.error('Cache DEL error:', error.message);
    }
  },

  /**
   * Delete all keys matching a pattern
   * Note: Upstash doesn't support KEYS command in free tier
   * So we'll maintain a set of related keys
   * @param {string} pattern - Pattern to match (e.g., 'user:*')
   */
  async delPattern(pattern) {
    try {
      // For Upstash, we use a different approach - delete known keys
      // This is handled by specific invalidation methods below
      console.log(`Pattern delete requested: ${pattern}`);
    } catch (error) {
      console.error('Cache PATTERN DEL error:', error.message);
    }
  },

  // ============== User Caching ==============

  /**
   * Get cached user data
   */
  async getUser(userId) {
    return await this.get(`user:${userId}`);
  },

  /**
   * Cache user data
   */
  async setUser(userId, userData) {
    await this.set(`user:${userId}`, userData, TTL.USER);
  },

  /**
   * Invalidate user cache
   */
  async invalidateUser(userId) {
    await this.del(`user:${userId}`);
  },

  // ============== Connections Caching ==============

  /**
   * Get cached connections for user
   */
  async getConnections(userId) {
    return await this.get(`connections:${userId}`);
  },

  /**
   * Cache connections data
   */
  async setConnections(userId, connections) {
    await this.set(`connections:${userId}`, connections, TTL.CONNECTIONS);
  },

  /**
   * Invalidate connections cache for user
   */
  async invalidateConnections(userId) {
    await this.del(`connections:${userId}`);
  },

  /**
   * Invalidate connections for both users in a connection
   */
  async invalidateConnectionPair(userId1, userId2) {
    await Promise.all([
      this.del(`connections:${userId1}`),
      this.del(`connections:${userId2}`),
    ]);
  },

  // ============== Status Caching ==============

  /**
   * Get cached statuses for user
   */
  async getStatuses(userId) {
    return await this.get(`statuses:${userId}`);
  },

  /**
   * Cache statuses data
   */
  async setStatuses(userId, statuses) {
    await this.set(`statuses:${userId}`, statuses, TTL.STATUSES);
  },

  /**
   * Invalidate status cache
   */
  async invalidateStatuses(userId) {
    await this.del(`statuses:${userId}`);
  },

  // ============== Notifications Caching ==============

  /**
   * Get cached notifications for user
   */
  async getNotifications(userId, limit = 50) {
    return await this.get(`notifications:${userId}:${limit}`);
  },

  /**
   * Cache notifications data
   */
  async setNotifications(userId, limit, notifications) {
    await this.set(`notifications:${userId}:${limit}`, notifications, TTL.NOTIFICATIONS);
  },

  /**
   * Invalidate notifications cache
   */
  async invalidateNotifications(userId) {
    // Invalidate common limits
    await Promise.all([
      this.del(`notifications:${userId}:20`),
      this.del(`notifications:${userId}:50`),
      this.del(`notifications:${userId}:100`),
    ]);
  },

  // ============== Cycle Caching ==============

  /**
   * Get cached cycle data for user
   */
  async getCycle(userId) {
    return await this.get(`cycle:${userId}`);
  },

  /**
   * Cache cycle data
   */
  async setCycle(userId, cycleData) {
    await this.set(`cycle:${userId}`, cycleData, TTL.CYCLE);
  },

  /**
   * Invalidate cycle cache
   */
  async invalidateCycle(userId) {
    await this.del(`cycle:${userId}`);
  },

  // ============== Location Caching ==============

  /**
   * Get cached location sharing settings
   */
  async getLocationSharing(userId) {
    return await this.get(`location:sharing:${userId}`);
  },

  /**
   * Cache location sharing settings
   */
  async setLocationSharing(userId, settings) {
    await this.set(`location:sharing:${userId}`, settings, TTL.LOCATION);
  },

  /**
   * Invalidate location cache
   */
  async invalidateLocation(userId) {
    await this.del(`location:sharing:${userId}`);
  },

  // ============== Search Caching ==============

  /**
   * Get cached search results
   */
  async getSearchResults(query) {
    const key = `search:${Buffer.from(query).toString('base64')}`;
    return await this.get(key);
  },

  /**
   * Cache search results
   */
  async setSearchResults(query, results) {
    const key = `search:${Buffer.from(query).toString('base64')}`;
    await this.set(key, results, TTL.SEARCH);
  },

  // ============== Health Check ==============

  /**
   * Check if Redis is connected and working
   */
  async healthCheck() {
    try {
      await redis.ping();
      return { status: 'connected', message: 'Redis is healthy' };
    } catch (error) {
      return { status: 'error', message: error.message };
    }
  },
};

module.exports = { CacheService, redis, TTL };
