import { Router, Request, Response, NextFunction } from 'express';
import { authenticate } from '../middleware/auth';
import { query } from '../db/connection';
import { createError } from '../middleware/errorHandler';
import multer from 'multer';
import { parse } from 'csv-parse/sync';
import { stringify } from 'csv-stringify/sync';

// Extend Express Request to include multer file
interface MulterRequest extends Omit<Request, 'file'> {
  file?: {
    fieldname: string;
    originalname: string;
    encoding: string;
    mimetype: string;
    size: number;
    buffer: Buffer;
  };
}

const router = Router();

// Configure multer for file uploads
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
  fileFilter: (_req: Request, file: any, cb: any) => {
    if (file.mimetype === 'text/csv' || file.originalname.endsWith('.csv')) {
      cb(null, true);
    } else {
      cb(new Error('Only CSV files are allowed'));
    }
  },
});

// POST /api/import-export/contacts/import - Import contacts from CSV
router.post(
  '/contacts/import',
  authenticate,
  upload.single('file'),
  async (req: MulterRequest, res: Response, next: NextFunction) => {
    try {
      if (!req.file) {
        throw createError('No file uploaded', 400);
      }

      const csvContent = req.file.buffer.toString('utf-8');
      
      // Parse CSV using csv-parse
      let records: Record<string, string>[];
      try {
        records = parse(csvContent, {
          columns: true,
          skip_empty_lines: true,
          trim: true,
          relax_quotes: true,
          relax_column_count: true,
        }) as Record<string, string>[];
      } catch (parseError: any) {
        throw createError(`CSV parsing error: ${parseError.message}`, 400);
      }

      if (records.length === 0) {
        throw createError('CSV file is empty', 400);
      }

      // Validate required columns
      const requiredColumns = ['first_name', 'last_name'];
      const csvColumns = Object.keys(records[0]);
      const missingColumns = requiredColumns.filter(col => !csvColumns.includes(col));

      if (missingColumns.length > 0) {
        throw createError(`Missing required columns: ${missingColumns.join(', ')}`, 400);
      }

      // Process records
      const results = {
        total: records.length,
        success: 0,
        failed: 0,
        errors: [] as string[],
      };

      for (const record of records) {
        try {
          await query(
            `INSERT INTO contacts (
              first_name, last_name, email, phone, mobile,
              job_title, department, lifecycle_stage, notes, created_by
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
            [
              record.first_name || '',
              record.last_name || '',
              record.email || null,
              record.phone || null,
              record.mobile || null,
              record.job_title || null,
              record.department || null,
              record.lifecycle_stage || 'lead',
              record.notes || null,
              req.user?.userId || null,
            ]
          );
          results.success++;
        } catch (error: any) {
          results.failed++;
          results.errors.push(`Row ${results.total - records.length + 1}: ${error.message}`);
        }
      }

      res.json({
        success: true,
        data: results,
      });
    } catch (error) {
      next(error);
    }
  }
);

// GET /api/import-export/contacts/export - Export contacts to CSV
router.get('/contacts/export', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { lifecycle_stage, limit } = req.query;
    
    let whereClause = '';
    const params: any[] = [];
    
    if (lifecycle_stage) {
      whereClause = 'WHERE lifecycle_stage = $1';
      params.push(lifecycle_stage);
    }

    const limitClause = limit ? `LIMIT $${params.length + 1}` : '';
    if (limit) params.push(parseInt(limit as string));

    const contacts = await query(
      `SELECT 
        first_name, last_name, email, phone, mobile,
        job_title, department, lifecycle_stage, notes,
        created_at, updated_at
      FROM contacts ${whereClause} ORDER BY created_at DESC ${limitClause}`,
      params
    );

    // Generate CSV using csv-stringify
    const columns = [
      'first_name', 'last_name', 'email', 'phone', 'mobile',
      'job_title', 'department', 'lifecycle_stage', 'notes',
      'created_at', 'updated_at'
    ];
    
    const csv = stringify(contacts, {
      header: true,
      columns: columns,
    });

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=contacts-export.csv');
    res.send(csv);
  } catch (error) {
    next(error);
  }
});

// POST /api/import-export/accounts/import - Import accounts from CSV
router.post(
  '/accounts/import',
  authenticate,
  upload.single('file'),
  async (req: MulterRequest, res: Response, next: NextFunction) => {
    try {
      if (!req.file) {
        throw createError('No file uploaded', 400);
      }

      const csvContent = req.file.buffer.toString('utf-8');
      
      // Parse CSV using csv-parse
      let records: Record<string, string>[];
      try {
        records = parse(csvContent, {
          columns: true,
          skip_empty_lines: true,
          trim: true,
          relax_quotes: true,
          relax_column_count: true,
        }) as Record<string, string>[];
      } catch (parseError: any) {
        throw createError(`CSV parsing error: ${parseError.message}`, 400);
      }

      if (records.length === 0) {
        throw createError('CSV file is empty', 400);
      }

      if (!records[0].name) {
        throw createError('Missing required column: name', 400);
      }

      const results = {
        total: records.length,
        success: 0,
        failed: 0,
        errors: [] as string[],
      };

      for (const record of records) {
        try {
          await query(
            `INSERT INTO accounts (
              name, website, industry, phone, email,
              address, city, state, country, postal_code, created_by
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
            [
              record.name || '',
              record.website || null,
              record.industry || null,
              record.phone || null,
              record.email || null,
              record.address || null,
              record.city || null,
              record.state || null,
              record.country || null,
              record.postal_code || null,
              req.user?.userId || null,
            ]
          );
          results.success++;
        } catch (error: any) {
          results.failed++;
          results.errors.push(`Row ${results.total - records.length + 1}: ${error.message}`);
        }
      }

      res.json({
        success: true,
        data: results,
      });
    } catch (error) {
      next(error);
    }
  }
);

// GET /api/import-export/accounts/export - Export accounts to CSV
router.get('/accounts/export', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const accounts = await query(
      `SELECT 
        name, website, industry, phone, email,
        address, city, state, country, postal_code,
        created_at, updated_at
      FROM accounts ORDER BY created_at DESC`
    );

    // Generate CSV using csv-stringify
    const columns = [
      'name', 'website', 'industry', 'phone', 'email',
      'address', 'city', 'state', 'country', 'postal_code',
      'created_at', 'updated_at'
    ];
    
    const csv = stringify(accounts, {
      header: true,
      columns: columns,
    });

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=accounts-export.csv');
    res.send(csv);
  } catch (error) {
    next(error);
  }
});

// GET /api/import-export/deals/export - Export deals to CSV
router.get('/deals/export', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const deals = await query(
      `SELECT 
        name, stage, value, probability, currency,
        expected_close_date, actual_close_date, description,
        created_at, updated_at
      FROM deals ORDER BY created_at DESC`
    );

    // Generate CSV using csv-stringify
    const columns = [
      'name', 'stage', 'value', 'probability', 'currency',
      'expected_close_date', 'actual_close_date', 'description',
      'created_at', 'updated_at'
    ];
    
    const csv = stringify(deals, {
      header: true,
      columns: columns,
    });

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=deals-export.csv');
    res.send(csv);
  } catch (error) {
    next(error);
  }
});

export default router;
