const requirePremium = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  if (!req.user.isPremium) {
    return res.status(403).json({
      error: 'Premium subscription required',
      code: 'PREMIUM_REQUIRED',
      message: 'This feature requires a premium subscription. Upgrade to access more custom statuses and notifications.'
    });
  }

  next();
};

// Check if user can add more free custom items
const checkFreeSlots = (type) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    let freeSlots;
    if (type === 'status') {
      freeSlots = req.user.getFreeStatusSlots();
    } else if (type === 'notification') {
      freeSlots = req.user.getFreeNotificationSlots();
    }

    if (freeSlots <= 0 && !req.user.isPremium) {
      return res.status(403).json({
        error: 'No free slots available',
        code: 'NO_FREE_SLOTS',
        message: `You have used all your free custom ${type} slots. Upgrade to premium for more.`
      });
    }

    req.freeSlots = freeSlots;
    next();
  };
};

// Check if user can add more premium custom items
const checkPremiumSlots = (type) => {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    if (!req.user.isPremium) {
      return res.status(403).json({
        error: 'Premium subscription required',
        code: 'PREMIUM_REQUIRED'
      });
    }

    let premiumSlots;
    if (type === 'status') {
      premiumSlots = req.user.getPremiumStatusSlots();
    } else if (type === 'notification') {
      premiumSlots = req.user.getPremiumNotificationSlots();
    }

    if (premiumSlots <= 0) {
      return res.status(403).json({
        error: 'No premium slots available',
        code: 'NO_PREMIUM_SLOTS',
        message: `You have used all your premium custom ${type} slots.`
      });
    }

    req.premiumSlots = premiumSlots;
    next();
  };
};

module.exports = { requirePremium, checkFreeSlots, checkPremiumSlots };
