import { Request, Response, NextFunction } from 'express';
import { verifyAccessToken, TokenPayload } from '../utils/jwt';
import { createError } from './errorHandler';
import { isSuperAdmin, getUserCompanyId } from '../utils/companyAccess';
import { logger } from '../utils/logger';

// Extend Express Request to include user and cached company_id
declare global {
  namespace Express {
    interface Request {
      user?: TokenPayload;
      userCompanyId?: string | null; // Cached company_id to avoid repeated DB queries
    }
  }
}

export const authenticate = (
  req: Request,
  _res: Response,
  next: NextFunction
) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      logger.debug('Authentication failed: No token provided', req.method, req.path);
      throw createError('No token provided', 401);
    }

    const token = authHeader.substring(7); // Remove 'Bearer ' prefix
    const decoded = verifyAccessToken(token);
    logger.debug('Token verified successfully', { userId: decoded.userId, role: decoded.role });

    req.user = decoded;
    
    // Cache company_id from JWT if available, otherwise will be fetched by enrichUser middleware
    if (decoded.companyId !== undefined) {
      req.userCompanyId = decoded.companyId;
    }
    
    next();
  } catch (error: any) {
    logger.error('Authentication failed:', error.message);
    next(createError(error.message || 'Invalid token', 401));
  }
};

/**
 * Middleware to enrich request with user's company_id if not already cached
 * This avoids repeated database queries for company_id
 */
export const enrichUser = async (
  req: Request,
  _res: Response,
  next: NextFunction
) => {
  try {
    if (req.user && req.userCompanyId === undefined) {
      // Only fetch from DB if not in JWT
      req.userCompanyId = await getUserCompanyId(req.user);
      logger.debug('Fetched company_id from database', { userId: req.user.userId, companyId: req.userCompanyId });
    }
    next();
  } catch (error: any) {
    logger.error('Failed to enrich user:', error.message);
    next(createError('Failed to load user information', 500));
  }
};

// Role-based authorization middleware
export const authorize = (...roles: string[]) => {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) {
      return next(createError('Unauthorized', 401));
    }

    // Super_admin bypasses role checks
    if (isSuperAdmin(req.user)) {
      return next();
    }

    if (roles.length > 0 && req.user.role && !roles.includes(req.user.role)) {
      return next(createError('Forbidden: Insufficient permissions', 403));
    }

    next();
  };
};

// Middleware to require company access
export const requireCompanyAccess = (accountId: string) => {
  return async (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) {
      return next(createError('Unauthorized', 401));
    }

    // Use cached company_id if available
    const userCompanyId = req.userCompanyId ?? await getUserCompanyId(req.user);
    
    // Super_admin has access to all companies
    if (isSuperAdmin(req.user)) {
      return next();
    }

    // User can only access their own company
    if (userCompanyId !== accountId) {
      logger.warn('Company access denied', { userId: req.user.userId, requestedCompanyId: accountId, userCompanyId });
      return next(createError('Forbidden: You do not have access to this company', 403));
    }

    next();
  };
};

