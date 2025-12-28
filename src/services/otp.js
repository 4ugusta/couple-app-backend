const twilio = require('twilio');
const Otp = require('../models/Otp');

// Initialize Twilio client
const client = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

const sendOTP = async (phone) => {
  try {
    // Create OTP in database
    const otpDoc = await Otp.createOTP(phone);

    // In development, log OTP instead of sending
    if (process.env.NODE_ENV === 'development') {
      console.log(`[DEV] OTP for ${phone}: ${otpDoc.otp}`);
      return { success: true, message: 'OTP sent successfully (dev mode)' };
    }

    // Send OTP via Twilio
    await client.messages.create({
      body: `Your Couple App verification code is: ${otpDoc.otp}. Valid for 10 minutes.`,
      from: process.env.TWILIO_PHONE_NUMBER,
      to: phone
    });

    return { success: true, message: 'OTP sent successfully' };
  } catch (error) {
    console.error('Error sending OTP:', error);
    throw new Error('Failed to send OTP');
  }
};

const verifyOTP = async (phone, otp) => {
  try {
    const result = await Otp.verifyOTP(phone, otp);
    return result;
  } catch (error) {
    console.error('Error verifying OTP:', error);
    throw new Error('Failed to verify OTP');
  }
};

module.exports = { sendOTP, verifyOTP };
