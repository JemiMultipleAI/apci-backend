import { Router, Request, Response, NextFunction } from 'express';
import { authenticate, enrichUser } from '../middleware/auth';
import { createError, ErrorCodes } from '../middleware/errorHandler';
import { getEffectiveCompanyId } from '../utils/companyAccess';
import { logger } from '../utils/logger';
import { Conversation } from '../models/mongodb/Conversation';
import { query } from '../db/connection';

const router = Router();

// GET /api/inbox - Get inbox messages (all channels)
router.get('/', authenticate, enrichUser, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.user) {
      return next(createError('Unauthorized', 401, ErrorCodes.UNAUTHORIZED));
    }

    const { 
      channel,
      unread_only = 'false',
      contact_id,
      page = '1', 
      limit = '50',
      company_id 
    } = req.query;

    const effectiveCompanyId = await getEffectiveCompanyId(
      req.user,
      company_id as string | undefined,
      req.userCompanyId
    );

    // Build filter for conversations
    const filter: any = {
      ...(effectiveCompanyId && { account_id: effectiveCompanyId }),
      ...(channel && { channel: channel as 'email' | 'sms' | 'call' }),
      ...(contact_id && { contact_id: contact_id as string }),
    };

    // Get conversations with user messages (inbound)
    const conversations = await Conversation.find(filter)
      .sort({ updated_at: -1 })
      .lean();

    // Extract messages and format for inbox
    interface InboxMessage {
      id: string;
      conversationId: string;
      contactId: string;
      channel: 'email' | 'sms' | 'call';
      subject: string | null;
      from: string | undefined;
      to: string | undefined;
      content: string;
      timestamp: Date;
      read: boolean;
      threadId?: string;
      campaignId?: string;
    }
    const inboxMessages: InboxMessage[] = [];
    
    for (const conv of conversations) {
      // Get user messages (inbound)
      const userMessages = conv.messages?.filter(m => m.role === 'user') || [];
      
      for (const message of userMessages) {
        // Check if message is read (could be stored in metadata)
        const isRead = message.metadata?.read === true;
        
        if (unread_only === 'true' && isRead) {
          continue; // Skip read messages if unread_only is true
        }

        inboxMessages.push({
          id: message.message_id || `${conv._id}-${message.timestamp}`,
          conversationId: conv._id.toString(),
          contactId: conv.contact_id,
          channel: conv.channel,
          subject: conv.subject || (conv.channel === 'email' ? 'No Subject' : null),
          from: conv.channel === 'email' ? message.metadata?.from : message.metadata?.from_phone,
          to: conv.channel === 'email' ? message.metadata?.to : message.metadata?.to_phone,
          content: message.content,
          timestamp: message.timestamp,
          read: isRead,
          threadId: conv.thread_id,
          campaignId: conv.campaign_id,
        });
      }
    }

    // Sort by timestamp (newest first)
    inboxMessages.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    // Pagination
    const pageNum = parseInt(page as string, 10);
    const limitNum = parseInt(limit as string, 10);
    const skip = (pageNum - 1) * limitNum;
    const paginatedMessages = inboxMessages.slice(skip, skip + limitNum);

    res.json({
      success: true,
      data: paginatedMessages,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total: inboxMessages.length,
        totalPages: Math.ceil(inboxMessages.length / limitNum),
      },
      unreadCount: inboxMessages.filter(m => !m.read).length,
    });
  } catch (error: any) {
    logger.error('[INBOX] List error:', {
      error: error.message,
      requestId: req.requestId,
    });
    next(error);
  }
});

// GET /api/inbox/thread/:threadId - Get conversation thread
router.get('/thread/:threadId', authenticate, enrichUser, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.user) {
      return next(createError('Unauthorized', 401, ErrorCodes.UNAUTHORIZED));
    }

    const { threadId } = req.params;
    const { company_id } = req.query;

    const effectiveCompanyId = await getEffectiveCompanyId(
      req.user,
      company_id as string | undefined,
      req.userCompanyId
    );

    const filter: any = {
      thread_id: threadId,
      ...(effectiveCompanyId && { account_id: effectiveCompanyId }),
    };

    const conversation = await Conversation.findOne(filter).lean();

    if (!conversation) {
      return next(createError('Thread not found', 404, ErrorCodes.NOT_FOUND));
    }

    // Format messages for display
    const messages = (conversation.messages || []).map((msg: any) => ({
      id: msg.message_id || `${conversation._id}-${msg.timestamp}`,
      role: msg.role,
      content: msg.content,
      timestamp: msg.timestamp,
      metadata: msg.metadata,
    }));

    res.json({
      success: true,
      data: {
        threadId: conversation.thread_id,
        contactId: conversation.contact_id,
        channel: conversation.channel,
        subject: conversation.subject,
        messages,
        summary: conversation.summary,
        metadata: conversation.metadata,
      },
    });
  } catch (error: any) {
    logger.error('[INBOX] Thread error:', {
      error: error.message,
      requestId: req.requestId,
    });
    next(error);
  }
});

// PUT /api/inbox/message/:messageId/read - Mark message as read
router.put('/message/:messageId/read', authenticate, enrichUser, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.user) {
      return next(createError('Unauthorized', 401, ErrorCodes.UNAUTHORIZED));
    }

    const { messageId } = req.params;
    const { read = true } = req.body;

    // Find conversation containing this message
    const conversations = await Conversation.find({}).lean();
    
    for (const conv of conversations) {
      const message = conv.messages?.find((m: any) => 
        (m.message_id === messageId) || 
        (`${conv._id}-${m.timestamp}` === messageId)
      );

      if (message) {
        // Update message metadata
        await Conversation.updateOne(
          { _id: conv._id, 'messages.message_id': message.message_id },
          { 
            $set: { 
              'messages.$.metadata.read': read,
              'messages.$.metadata.read_at': read ? new Date() : null,
            } 
          }
        );

        return res.json({
          success: true,
          data: { messageId, read },
        });
      }
    }

    return next(createError('Message not found', 404, ErrorCodes.NOT_FOUND));
  } catch (error: any) {
    logger.error('[INBOX] Mark read error:', {
      error: error.message,
      requestId: req.requestId,
    });
    next(error);
  }
});

// POST /api/inbox/reply - Send reply to conversation
router.post('/reply', authenticate, enrichUser, async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!req.user) {
      return next(createError('Unauthorized', 401, ErrorCodes.UNAUTHORIZED));
    }

    const { threadId, message, contactId, accountId, channel } = req.body;

    if (!threadId || !message || !contactId || !accountId || !channel) {
      return next(createError('Missing required fields: threadId, message, contactId, accountId, channel', 400, ErrorCodes.VALIDATION_ERROR));
    }

    // Check company access
    const effectiveCompanyId = await getEffectiveCompanyId(
      req.user,
      accountId,
      req.userCompanyId
    );

    if (effectiveCompanyId && effectiveCompanyId !== accountId) {
      return next(createError('Forbidden: You do not have access to this conversation', 403, ErrorCodes.FORBIDDEN));
    }

    // Find conversation
    const conversation = await Conversation.findOne({
      thread_id: threadId,
      contact_id: contactId,
      account_id: accountId,
      channel: channel as 'email' | 'sms' | 'call',
    });

    if (!conversation) {
      return next(createError('Conversation not found', 404, ErrorCodes.NOT_FOUND));
    }

    // Add assistant message (reply)
    const { addMessageToConversation } = await import('../services/conversationService');
    await addMessageToConversation(
      conversation._id.toString(),
      'assistant',
      message,
      {
        sent_by: req.user.userId,
        sent_at: new Date(),
      }
    );

    // Send message via appropriate channel
    const { sendEmail } = await import('../services/email');
    const { sendSMS } = await import('../services/sms');

    if (channel === 'email') {
      const contact = await query<{ email: string }>('SELECT email FROM contacts WHERE id = $1', [contactId]);
      if (contact[0]?.email) {
        await sendEmail({
          to: contact[0].email,
          subject: conversation.subject || 'Re: Your message',
          html: message,
        });
      }
    } else if (channel === 'sms') {
      const contact = await query<{ mobile: string }>('SELECT mobile FROM contacts WHERE id = $1', [contactId]);
      if (contact[0]?.mobile) {
        await sendSMS({
          to: contact[0].mobile,
          message: message.substring(0, 320), // SMS limit
        });
      }
    }

    res.json({
      success: true,
      data: { threadId, message: 'Reply sent successfully' },
    });
  } catch (error: any) {
    logger.error('[INBOX] Reply error:', {
      error: error.message,
      requestId: req.requestId,
    });
    next(error);
  }
});

export default router;
