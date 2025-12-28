const admin = require('firebase-admin');

// Initialize Firebase Admin (only if credentials are available)
let firebaseInitialized = false;

const initializeFirebase = () => {
  if (firebaseInitialized) return;

  if (process.env.FIREBASE_PROJECT_ID && process.env.FIREBASE_PRIVATE_KEY && process.env.FIREBASE_CLIENT_EMAIL) {
    try {
      admin.initializeApp({
        credential: admin.credential.cert({
          projectId: process.env.FIREBASE_PROJECT_ID,
          privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
          clientEmail: process.env.FIREBASE_CLIENT_EMAIL
        })
      });
      firebaseInitialized = true;
      console.log('Firebase Admin initialized');
    } catch (error) {
      console.error('Failed to initialize Firebase:', error);
    }
  } else {
    console.log('Firebase credentials not configured, push notifications disabled');
  }
};

// Send push notification to a single device
const sendPushNotification = async (fcmToken, title, body, data = {}) => {
  if (!firebaseInitialized) {
    console.log('[DEV] Push notification:', { title, body, data });
    return { success: true, message: 'Push notification logged (Firebase not configured)' };
  }

  try {
    const message = {
      notification: {
        title,
        body
      },
      data: {
        ...data,
        click_action: 'FLUTTER_NOTIFICATION_CLICK'
      },
      token: fcmToken
    };

    const response = await admin.messaging().send(message);
    return { success: true, messageId: response };
  } catch (error) {
    console.error('Error sending push notification:', error);
    return { success: false, error: error.message };
  }
};

// Send push notification to multiple devices
const sendMultiplePushNotifications = async (fcmTokens, title, body, data = {}) => {
  if (!firebaseInitialized) {
    console.log('[DEV] Multiple push notifications:', { fcmTokens, title, body, data });
    return { success: true, message: 'Push notifications logged (Firebase not configured)' };
  }

  if (!fcmTokens || fcmTokens.length === 0) {
    return { success: false, error: 'No FCM tokens provided' };
  }

  try {
    const message = {
      notification: {
        title,
        body
      },
      data: {
        ...data,
        click_action: 'FLUTTER_NOTIFICATION_CLICK'
      },
      tokens: fcmTokens
    };

    const response = await admin.messaging().sendEachForMulticast(message);
    return {
      success: true,
      successCount: response.successCount,
      failureCount: response.failureCount
    };
  } catch (error) {
    console.error('Error sending multiple push notifications:', error);
    return { success: false, error: error.message };
  }
};

// Send data-only notification (for background processing)
const sendDataNotification = async (fcmToken, data) => {
  if (!firebaseInitialized) {
    console.log('[DEV] Data notification:', { fcmToken, data });
    return { success: true, message: 'Data notification logged (Firebase not configured)' };
  }

  try {
    const message = {
      data: {
        ...data,
        click_action: 'FLUTTER_NOTIFICATION_CLICK'
      },
      token: fcmToken,
      android: {
        priority: 'high'
      },
      apns: {
        payload: {
          aps: {
            'content-available': 1
          }
        }
      }
    };

    const response = await admin.messaging().send(message);
    return { success: true, messageId: response };
  } catch (error) {
    console.error('Error sending data notification:', error);
    return { success: false, error: error.message };
  }
};

// Verify Firebase ID token (for phone authentication)
const verifyFirebaseIdToken = async (idToken) => {
  if (!firebaseInitialized) {
    throw new Error('Firebase not configured');
  }

  try {
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    return {
      success: true,
      uid: decodedToken.uid,
      phone: decodedToken.phone_number,
      email: decodedToken.email
    };
  } catch (error) {
    console.error('Error verifying Firebase ID token:', error);
    return { success: false, error: error.message };
  }
};

// Check if Firebase is initialized
const isFirebaseInitialized = () => firebaseInitialized;

module.exports = {
  initializeFirebase,
  sendPushNotification,
  sendMultiplePushNotifications,
  sendDataNotification,
  verifyFirebaseIdToken,
  isFirebaseInitialized
};
