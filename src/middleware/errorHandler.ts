import { Request, Response, NextFunction } from 'express';
import { env } from '../config/env';
import { logger } from '../utils/logger';
import { getRequestId } from '../utils/requestId';

export interface AppError extends Error {
  statusCode?: number;
  code?: string;
  details?: any;
}

export const errorHandler = (
  err: AppError,
  req: Request,
  res: Response,
  _next: NextFunction
) => {
  const statusCode = err.statusCode || 500;
  const message = err.message || 'Internal Server Error';
  const requestId = getRequestId(req);

  // Log error with structured logging
  const errorLog: any = {
    requestId,
    message: err.message,
    statusCode,
    path: req.path,
    method: req.method,
    code: err.code,
    details: err.details,
  };

  if (env.NODE_ENV === 'development') {
    errorLog.stack = err.stack;
  }

  if (statusCode >= 500) {
    logger.error('Server error:', errorLog);
  } else if (statusCode >= 400) {
    logger.warn('Client error:', errorLog);
  } else {
    logger.info('Error handled:', errorLog);
  }

  res.status(statusCode).json({
    success: false,
    error: {
      message,
      code: err.code,
      requestId,
      ...(env.NODE_ENV === 'development' && { 
        stack: err.stack,
        details: err.details,
      }),
    },
  });
};

export const createError = (
  message: string, 
  statusCode: number = 500,
  code?: string,
  details?: any
): AppError => {
  const error: AppError = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  error.details = details;
  return error;
};

/**
 * Common error codes
 */
export const ErrorCodes = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  RATE_LIMIT_EXCEEDED: 'RATE_LIMIT_EXCEEDED',
  EXTERNAL_SERVICE_ERROR: 'EXTERNAL_SERVICE_ERROR',
  DATABASE_ERROR: 'DATABASE_ERROR',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;
