const { CacheService, TTL } = require('../services/cache');

/**
 * Generic caching middleware factory
 * @param {function} keyGenerator - Function to generate cache key from req
 * @param {number} ttl - Time to live in seconds
 */
const cacheMiddleware = (keyGenerator, ttl = 300) => {
  return async (req, res, next) => {
    const key = keyGenerator(req);

    try {
      // Try to get from cache
      const cachedData = await CacheService.get(key);

      if (cachedData) {
        // Return cached response
        return res.json(cachedData);
      }

      // Store original json method
      const originalJson = res.json.bind(res);

      // Override json method to cache successful responses
      res.json = (data) => {
        // Only cache successful responses
        if (res.statusCode >= 200 && res.statusCode < 300) {
          CacheService.set(key, data, ttl).catch(err => {
            console.error('Cache middleware SET error:', err.message);
          });
        }
        return originalJson(data);
      };

      next();
    } catch (error) {
      console.error('Cache middleware error:', error.message);
      // Continue without caching on error
      next();
    }
  };
};

/**
 * Cache user profile data
 */
const cacheUser = cacheMiddleware(
  (req) => `user:${req.user.id}`,
  TTL.USER
);

/**
 * Cache connections list
 */
const cacheConnections = cacheMiddleware(
  (req) => `connections:${req.user.id}`,
  TTL.CONNECTIONS
);

/**
 * Cache statuses
 */
const cacheStatuses = cacheMiddleware(
  (req) => `statuses:${req.user.id}`,
  TTL.STATUSES
);

/**
 * Cache notifications
 */
const cacheNotifications = cacheMiddleware(
  (req) => `notifications:${req.user.id}:${req.query.limit || 50}`,
  TTL.NOTIFICATIONS
);

/**
 * Cache cycle data
 */
const cacheCycle = cacheMiddleware(
  (req) => `cycle:${req.user.id}`,
  TTL.CYCLE
);

/**
 * Cache location sharing settings
 */
const cacheLocationSharing = cacheMiddleware(
  (req) => `location:sharing:${req.user.id}`,
  TTL.LOCATION
);

/**
 * Cache user search results
 */
const cacheUserSearch = cacheMiddleware(
  (req) => {
    const query = req.query.phone || req.query.email || '';
    return `search:${Buffer.from(query).toString('base64')}`;
  },
  TTL.SEARCH
);

/**
 * Cache specific user profile by ID
 */
const cacheUserById = cacheMiddleware(
  (req) => `user:${req.params.userId}`,
  TTL.USER
);

module.exports = {
  cacheMiddleware,
  cacheUser,
  cacheConnections,
  cacheStatuses,
  cacheNotifications,
  cacheCycle,
  cacheLocationSharing,
  cacheUserSearch,
  cacheUserById,
};
