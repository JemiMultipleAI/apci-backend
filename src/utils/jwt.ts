import jwt from 'jsonwebtoken';
import { env } from '../config/env';

export interface TokenPayload {
  userId: string;
  email: string;
  role?: string;
  companyId?: string | null; // Company ID for faster access without DB query
}

export const generateAccessToken = (payload: TokenPayload): string => {
  return jwt.sign(payload, env.JWT_SECRET, {
    expiresIn: env.JWT_EXPIRES_IN,
  } as jwt.SignOptions);
};

export const generateRefreshToken = (payload: TokenPayload): string => {
  return jwt.sign(payload, env.JWT_REFRESH_SECRET, {
    expiresIn: env.JWT_REFRESH_EXPIRES_IN,
  } as jwt.SignOptions);
};

export const verifyAccessToken = (token: string): TokenPayload => {
  try {
    return jwt.verify(token, env.JWT_SECRET) as TokenPayload;
  } catch (error: any) {
    // Log the actual JWT error for debugging
    const errorMessage = error.name === 'TokenExpiredError' 
      ? `Token expired at ${new Date(error.expiredAt).toISOString()}`
      : error.name === 'JsonWebTokenError'
      ? `Invalid token: ${error.message}`
      : error.message || 'Unknown error';
    
    throw new Error(`Invalid or expired access token: ${errorMessage}`);
  }
};

export const verifyRefreshToken = (token: string): TokenPayload => {
  try {
    return jwt.verify(token, env.JWT_REFRESH_SECRET) as TokenPayload;
  } catch (error) {
    throw new Error('Invalid or expired refresh token');
  }
};

