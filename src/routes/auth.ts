import { Router, Request, Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import { query, queryOne } from '../db/connection';
import { createError } from '../middleware/errorHandler';
import { generateAccessToken, generateRefreshToken, verifyRefreshToken } from '../utils/jwt';
import { authenticate } from '../middleware/auth';
import { z, ZodError } from 'zod';
import { logger } from '../utils/logger';

const router = Router();

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  first_name: z.string().optional(),
  last_name: z.string().optional(),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string(),
});

// POST /api/auth/register - Register new user
router.post('/register', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const validatedData = registerSchema.parse(req.body);

    // Check if user already exists
    const existing = await queryOne('SELECT id FROM users WHERE email = $1', [validatedData.email]);
    if (existing) {
      throw createError('User with this email already exists', 409);
    }

    // Hash password
    const passwordHash = await bcrypt.hash(validatedData.password, 10);

    // Create user
    const user = await queryOne(
      `INSERT INTO users (email, password_hash, first_name, last_name, role)
       VALUES ($1, $2, $3, $4, 'viewer')
       RETURNING id, email, first_name, last_name, role, created_at`,
      [
        validatedData.email,
        passwordHash,
        validatedData.first_name || null,
        validatedData.last_name || null,
      ]
    );

    // Generate tokens
    const accessToken = generateAccessToken({
      userId: user.id,
      email: user.email,
      role: user.role,
    });
    const refreshToken = generateRefreshToken({
      userId: user.id,
      email: user.email,
      role: user.role,
    });

    res.status(201).json({
      success: true,
      data: {
        user,
        accessToken,
        refreshToken,
      },
    });
  } catch (error) {
    if (error instanceof ZodError) {
      return next(createError('Validation error: ' + error.issues.map((e: z.ZodIssue) => e.message).join(', '), 400));
    }
    next(error);
  }
});

// POST /api/auth/login - Login user
router.post('/login', async (req: Request, res: Response, next: NextFunction) => {
  try {
    logger.debug('Login attempt received', { email: req.body.email });
    
    const validatedData = loginSchema.parse(req.body);

    // Find user
    const user = await queryOne<{
      id: string;
      email: string;
      password_hash: string;
      first_name: string | null;
      last_name: string | null;
      role: string;
      is_active: boolean;
      account_id: string | null;
    }>(
      'SELECT id, email, password_hash, first_name, last_name, role, is_active, account_id FROM users WHERE email = $1',
      [validatedData.email]
    );

    if (!user) {
      logger.warn('Login failed: User not found', { email: validatedData.email });
      throw createError('Invalid email or password', 401);
    }

    if (!user.is_active) {
      logger.warn('Login failed: Account deactivated', { userId: user.id });
      throw createError('Account is deactivated', 403);
    }

    // Verify password
    const isValid = await bcrypt.compare(validatedData.password, user.password_hash);
    if (!isValid) {
      logger.warn('Login failed: Invalid password', { userId: user.id });
      throw createError('Invalid email or password', 401);
    }

    logger.info('Login successful', { userId: user.id, role: user.role });

    // Generate tokens with company_id included
    const accessToken = generateAccessToken({
      userId: user.id,
      email: user.email,
      role: user.role,
      companyId: user.account_id || null,
    });
    const refreshToken = generateRefreshToken({
      userId: user.id,
      email: user.email,
      role: user.role,
      companyId: user.account_id || null,
    });

    res.json({
      success: true,
      data: {
        user: {
          id: user.id,
          email: user.email,
          first_name: user.first_name,
          last_name: user.last_name,
          role: user.role,
          company_id: user.account_id || null,
        },
        accessToken,
        refreshToken,
      },
    });
  } catch (error: any) {
    logger.error('Login error:', error.message);
    
    if (error instanceof ZodError) {
      return next(createError('Validation error: ' + error.issues.map((e: z.ZodIssue) => e.message).join(', '), 400));
    }
    
    // If it's already an AppError with statusCode, pass it through
    if (error.statusCode) {
      return next(error);
    }
    
    // Handle database connection errors
    if (error.code === 'ECONNREFUSED' || error.code === 'ENOTFOUND') {
      return next(createError('Database connection failed. Please check your database configuration.', 503));
    }
    
    // Handle JWT errors
    if (error.message && error.message.includes('secret')) {
      return next(createError('JWT configuration error. Please check JWT_SECRET and JWT_REFRESH_SECRET.', 500));
    }
    
    next(error);
  }
});

// POST /api/auth/refresh - Refresh access token
router.post('/refresh', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { refreshToken } = req.body;

    if (!refreshToken) {
      throw createError('Refresh token required', 400);
    }

    const payload = verifyRefreshToken(refreshToken);

    // Fetch current user data to get updated company_id
    const user = await queryOne<{
      id: string;
      email: string;
      role: string;
      account_id: string | null;
    }>(
      'SELECT id, email, role, account_id FROM users WHERE id = $1',
      [payload.userId]
    );

    if (!user) {
      throw createError('User not found', 404);
    }

    // Generate new access token with updated company_id
    const accessToken = generateAccessToken({
      userId: payload.userId,
      email: payload.email,
      role: user.role,
      companyId: user.account_id || null,
    });

    res.json({
      success: true,
      data: {
        accessToken,
        company_id: user.account_id || null,
      },
    });
  } catch (error) {
    next(createError('Invalid refresh token', 401));
  }
});

// GET /api/auth/me - Get current user
router.get('/me', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user?.userId;

    const user = await queryOne(
      'SELECT id, email, first_name, last_name, role, is_active, account_id, created_at FROM users WHERE id = $1',
      [userId]
    );

    if (!user) {
      throw createError('User not found', 404);
    }

    res.json({
      success: true,
      data: {
        ...user,
        company_id: user.account_id || null,
      },
    });
  } catch (error) {
    next(error);
  }
});

export default router;

