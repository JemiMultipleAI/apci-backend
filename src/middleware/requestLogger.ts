import { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger';
import { getRequestId } from '../utils/requestId';

// Extend Express Request to include request ID
declare global {
  namespace Express {
    interface Request {
      requestId?: string;
    }
  }
}

export const requestLogger = (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  const startTime = Date.now();
  const requestId = getRequestId(req);
  req.requestId = requestId;

  // Add request ID to response headers
  res.setHeader('X-Request-ID', requestId);
  
  // Skip detailed logging for health check to reduce noise
  if (req.path === '/health') {
    return next();
  }
  
  // Log request details with structured logging
  const requestLog: any = {
    requestId,
    method: req.method,
    path: req.path,
    query: req.query,
    ip: req.ip || req.socket.remoteAddress,
    userAgent: req.get('user-agent')?.substring(0, 100),
  };

  if (req.method !== 'GET' && req.body) {
    // Mask sensitive data in body
    const bodyCopy = { ...req.body };
    if (bodyCopy.password) bodyCopy.password = '***';
    if (bodyCopy.token) bodyCopy.token = '***';
    requestLog.body = bodyCopy;
  }

  logger.debug('Request received:', requestLog);
  
  // Capture response
  const originalSend = res.send;
  res.send = function (body) {
    const duration = Date.now() - startTime;
    const responseLog: any = {
      requestId,
      method: req.method,
      path: req.path,
      statusCode: res.statusCode,
      duration: `${duration}ms`,
    };
    
    // Log error responses with details
    if (res.statusCode >= 400) {
      try {
        const errorBody = typeof body === 'string' ? JSON.parse(body) : body;
        responseLog.error = errorBody;
        logger.warn('Request error:', responseLog);
      } catch (e) {
        responseLog.errorBody = body;
        logger.warn('Request error (raw):', responseLog);
      }
    } else {
      logger.info('Request completed:', responseLog);
    }
    
    return originalSend.call(this, body);
  };
  
  next();
};

