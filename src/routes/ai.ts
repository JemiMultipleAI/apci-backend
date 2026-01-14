import { Router, Request, Response, NextFunction } from 'express';
import { authenticate, enrichUser } from '../middleware/auth';
import { analyzeSentiment, predictChurn, getNextBestAction } from '../services/ai';
import { createError } from '../middleware/errorHandler';
import { env } from '../config/env';
import { sendMessageToAgent } from '../services/agentService';
import { randomUUID } from 'crypto';

const router = Router();

// In-memory conversation storage for chatbot testing
// Key: conversationId, Value: Array of messages { role: 'user' | 'assistant', content: string, timestamp: Date }
const conversationHistory = new Map<string, Array<{ role: 'user' | 'assistant'; content: string; timestamp: Date }>>();

// Clean up old conversations (older than 1 hour) periodically
setInterval(() => {
  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  for (const [conversationId, messages] of conversationHistory.entries()) {
    if (messages.length > 0) {
      const lastMessage = messages[messages.length - 1];
      if (lastMessage.timestamp.getTime() < oneHourAgo) {
        conversationHistory.delete(conversationId);
      }
    }
  }
}, 15 * 60 * 1000); // Run every 15 minutes

// GET /api/ai/status - Check AI provider configuration and status
router.get('/status', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const hasOpenAIKey = !!env.OPENAI_API_KEY && env.OPENAI_API_KEY.trim().length > 0;
    const openAIKeyPrefix = env.OPENAI_API_KEY ? env.OPENAI_API_KEY.substring(0, 7) + '...' : 'not set';
    const openAIKeyLength = env.OPENAI_API_KEY?.length || 0;
    
    const activeProvider = 'openai';
    const reason = hasOpenAIKey ? 'OpenAI is configured and ready' : 'OpenAI API key is missing';
    const isProjectKey = env.OPENAI_API_KEY?.startsWith('sk-proj-');
    const isOpenRouter = env.OPENAI_API_KEY?.startsWith('sk-or-');
    const isCustomBaseURL = !!env.OPENAI_BASE_URL;

    res.json({
      success: true,
      data: {
        provider: activeProvider,
        reason,
        note: 'ElevenLabs agent removed - using OpenAI only (ElevenLabs TTS remains)',
        openai: {
          apiKeyPresent: hasOpenAIKey,
          apiKeyPrefix: openAIKeyPrefix,
          apiKeyLength: openAIKeyLength,
          keyType: isProjectKey ? 'project_key (sk-proj-*)' : isOpenRouter ? 'openrouter (sk-or-*)' : hasOpenAIKey ? 'standard (sk-*)' : 'not_set',
          model: env.OPENAI_MODEL || 'gpt-4o-mini',
          baseURL: env.OPENAI_BASE_URL || (isOpenRouter ? 'https://openrouter.ai/api/v1 (auto-detected)' : 'https://api.openai.com/v1 (default)'),
          isCustomBaseURL: isCustomBaseURL,
          isUsingOpenRouter: isOpenRouter,
          status: hasOpenAIKey ? 'ready' : 'missing_api_key',
        },
        elevenlabs: {
          apiKeyPresent: !!env.ELEVENLABS_API_KEY,
          voiceId: env.ELEVENLABS_VOICE_ID || 'default',
          status: env.ELEVENLABS_API_KEY ? 'ready' : 'missing_api_key',
          note: 'TTS only (agent removed)',
        },
      },
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/ai/sentiment - Analyze sentiment from text
router.post('/sentiment', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { text } = req.body;

    if (!text || typeof text !== 'string') {
      throw createError('Text is required', 400);
    }

    const result = await analyzeSentiment(text);

    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/ai/churn/:contactId - Predict churn for a contact
router.get('/churn/:contactId', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { contactId } = req.params;
    const prediction = await predictChurn(contactId);

    res.json({
      success: true,
      data: {
        contactId,
        ...prediction,
        riskLevel: prediction.probability >= 70 ? 'high' : prediction.probability >= 40 ? 'medium' : 'low',
      },
    });
  } catch (error) {
    next(error);
  }
});

// GET /api/ai/next-action/:contactId - Get next best action for a contact
router.get('/next-action/:contactId', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { contactId } = req.params;
    const recommendation = await getNextBestAction(contactId);

    res.json({
      success: true,
      data: {
        contactId,
        ...recommendation,
      },
    });
  } catch (error) {
    next(error);
  }
});

// POST /api/ai/chat - Chat with the AI agent for testing
// Allows testing conversations with optional CRM context (contactId/accountId)
router.post('/chat', authenticate, enrichUser, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { message, conversationId, contactId, accountId, clearHistory } = req.body;

    if (!message || typeof message !== 'string') {
      throw createError('Message is required', 400);
    }

    // Use provided accountId or user's company ID
    const effectiveAccountId = accountId || req.userCompanyId || null;

    // Generate or use provided conversation ID
    let currentConversationId = conversationId;
    if (!currentConversationId || clearHistory) {
      currentConversationId = randomUUID();
    }

    // Get or create conversation history
    let messages = conversationHistory.get(currentConversationId) || [];

    // Clear history if requested
    if (clearHistory) {
      messages = [];
    }

    // Add user message to history
    const userMessage = {
      role: 'user' as const,
      content: message,
      timestamp: new Date(),
    };
    messages.push(userMessage);

    // Use a placeholder agent ID for testing
    const agentId = 'chatbot-test-agent';

    // Send message to agent with optional CRM context
    const agentResponse = await sendMessageToAgent(
      agentId,
      message,
      undefined, // agentConfigId
      contactId || undefined,
      effectiveAccountId || undefined
    );

    if (!agentResponse.success || !agentResponse.response) {
      // Remove user message from history if agent failed
      messages.pop();
      
      return res.status(500).json({
        success: false,
        error: agentResponse.error || 'Failed to get response from AI agent',
        conversationId: currentConversationId,
      });
    }

    // Add assistant response to history
    const assistantMessage = {
      role: 'assistant' as const,
      content: agentResponse.response,
      timestamp: new Date(),
    };
    messages.push(assistantMessage);

    // Keep only last 20 messages to prevent memory issues
    if (messages.length > 20) {
      messages = messages.slice(-20);
    }

    // Store updated conversation history
    conversationHistory.set(currentConversationId, messages);

    res.json({
      success: true,
      data: {
        conversationId: currentConversationId,
        message: agentResponse.response,
        responseTimeMs: agentResponse.responseTimeMs,
        hasContactContext: !!contactId,
        hasAccountContext: !!effectiveAccountId,
        messageCount: messages.length,
      },
    });
  } catch (error: any) {
    next(error);
  }
});

// GET /api/ai/chat/:conversationId - Get conversation history
router.get('/chat/:conversationId', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { conversationId } = req.params;
    const messages = conversationHistory.get(conversationId) || [];

    res.json({
      success: true,
      data: {
        conversationId,
        messages,
        messageCount: messages.length,
      },
    });
  } catch (error: any) {
    next(error);
  }
});

// DELETE /api/ai/chat/:conversationId - Clear conversation history
router.delete('/chat/:conversationId', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { conversationId } = req.params;
    conversationHistory.delete(conversationId);

    res.json({
      success: true,
      message: 'Conversation history cleared',
    });
  } catch (error: any) {
    next(error);
  }
});

export default router;

