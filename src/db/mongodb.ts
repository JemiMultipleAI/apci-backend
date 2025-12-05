import mongoose from 'mongoose';
import { env } from '../config/env';
import { logger } from '../utils/logger';

let isConnected = false;

/**
 * Connect to MongoDB
 */
export async function connectMongoDB(): Promise<void> {
  if (isConnected) {
    return;
  }

  if (!env.MONGODB_URI) {
    logger.warn('MONGODB_URI not configured, MongoDB features will be disabled');
    return;
  }

  try {
    await mongoose.connect(env.MONGODB_URI);
    isConnected = true;
    logger.info('MongoDB connected successfully');
  } catch (error: any) {
    logger.error('MongoDB connection error:', error.message);
    throw error;
  }
}

/**
 * Disconnect from MongoDB
 */
export async function disconnectMongoDB(): Promise<void> {
  if (!isConnected) {
    return;
  }

  try {
    await mongoose.disconnect();
    isConnected = false;
    logger.info('MongoDB disconnected');
  } catch (error: any) {
    logger.error('MongoDB disconnection error:', error.message);
  }
}

/**
 * Check if MongoDB is connected
 */
export function isMongoDBConnected(): boolean {
  return isConnected && mongoose.connection.readyState === 1;
}

