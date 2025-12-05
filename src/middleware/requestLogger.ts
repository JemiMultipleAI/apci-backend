import { Request, Response, NextFunction } from 'express';

export const requestLogger = (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  const startTime = Date.now();
  const timestamp = new Date().toISOString();
  
  // Skip logging for health check to reduce noise
  if (req.path === '/health') {
    return next();
  }
  
  // Log request details
  console.log(`\n🔵 [API] ${timestamp} - ${req.method} ${req.path}`);
  console.log(`🔵 [API] Query params:`, req.query);
  if (req.method !== 'GET' && req.body) {
    // Mask sensitive data in body
    const bodyCopy = { ...req.body };
    if (bodyCopy.password) bodyCopy.password = '***';
    console.log(`🔵 [API] Body:`, bodyCopy);
  } else {
    console.log(`🔵 [API] Body: N/A`);
  }
  
  // Log auth header (masked)
  const authHeader = req.headers.authorization;
  if (authHeader) {
    const tokenPreview = authHeader.substring(0, 20) + '...';
    console.log(`🔵 [API] Authorization header: ${tokenPreview}`);
  } else {
    console.log(`🔵 [API] No Authorization header`);
  }
  
  // Log user agent and IP
  console.log(`🔵 [API] IP: ${req.ip || req.socket.remoteAddress}`);
  console.log(`🔵 [API] User-Agent: ${req.get('user-agent')?.substring(0, 50)}...`);
  
  // Capture response
  const originalSend = res.send;
  res.send = function (body) {
    const duration = Date.now() - startTime;
    console.log(`✅ [API] ${req.method} ${req.path} - ${res.statusCode} (${duration}ms)`);
    
    // Log error responses
    if (res.statusCode >= 400) {
      try {
        const errorBody = typeof body === 'string' ? JSON.parse(body) : body;
        console.log(`❌ [API] Error response:`, errorBody);
      } catch (e) {
        console.log(`❌ [API] Error response (raw):`, body);
      }
    }
    
    return originalSend.call(this, body);
  };
  
  next();
};

