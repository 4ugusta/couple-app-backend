const MIN_APP_VERSION = '2.0.0';

const compareVersions = (v1, v2) => {
  const parts1 = v1.split('.').map(Number);
  const parts2 = v2.split('.').map(Number);

  for (let i = 0; i < Math.max(parts1.length, parts2.length); i++) {
    const p1 = parts1[i] || 0;
    const p2 = parts2[i] || 0;
    if (p1 > p2) return 1;
    if (p1 < p2) return -1;
  }
  return 0;
};

const versionCheck = (req, res, next) => {
  const appVersion = req.headers['x-app-version'];

  // No version header = old app that doesn't send it
  if (!appVersion) {
    return res.status(426).json({
      error: 'Please update to the latest version of the app',
      code: 'UPDATE_REQUIRED',
      minVersion: MIN_APP_VERSION
    });
  }

  // Version too old
  if (compareVersions(appVersion, MIN_APP_VERSION) < 0) {
    return res.status(426).json({
      error: 'Please update to the latest version of the app',
      code: 'UPDATE_REQUIRED',
      minVersion: MIN_APP_VERSION,
      currentVersion: appVersion
    });
  }

  next();
};

module.exports = versionCheck;
