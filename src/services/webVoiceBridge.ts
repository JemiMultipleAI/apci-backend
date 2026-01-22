/**
 * Web Voice Bridge - Browser-based voice testing
 * COMPLETELY SEPARATE from Twilio voice implementation (voiceCallBridge.ts, voiceCallBridgeOptimized.ts)
 * Uses WebSocket instead of Twilio Media Streams
 * For testing voice functionality without Twilio credits
 */

import { WebSocket } from 'ws';
import { logger } from '../utils/logger';
import { env } from '../config/env';
import { ElevenLabsClient, RealtimeEvents, AudioFormat, CommitStrategy } from '@elevenlabs/elevenlabs-js';
import { sendMessageToAgent } from './agentService';
import { upsertConversation, addMessageToConversation } from './conversationService';
import { buildSystemPrompt, getConversationHistory } from './openaiAgent';
import { Readable } from 'stream';
import { randomUUID } from 'crypto';

interface PreloadedContext {
  systemPrompt: string;
  conversationHistory: Array<{ role: 'user' | 'assistant'; content: string; timestamp: Date }>;
  loadedAt: number;
}

interface WebVoiceSession {
  sessionId: string;
  ws: WebSocket;
  userId: string;
  accountId?: string;
  contactId?: string;
  agentId: string;
  ttsClient?: ElevenLabsClient;
  sttConnection?: any; // ElevenLabs realtime STT connection (official SDK)
  isAISpeaking: boolean;
  aiSpeechStartTime?: number;
  aiSpeechEndTime?: number;
  lastAISpeechText?: string;
  conversationId?: string;
  instructions?: string;
  customIntroduction?: string; // Custom introduction from campaign
  preloadedContext?: PreloadedContext;
  shouldStopAudio?: boolean;
  ignoreTranscriptsUntil?: number;
  recentTranscripts?: Array<{ text: string; time: number }>;
  lastTranscriptText?: string;
  lastTranscriptTime?: number;
  lastTranscriptProcessedTime?: number;
  processedPartialTranscripts?: Array<{ text: string; time: number }>; // Track partial transcripts that were processed (to avoid duplicate final processing)
  pendingAgentRequest?: { text: string; timestamp: number }; // Track pending agent request (for race condition prevention)
  lastInterruptionTime?: number; // Track last interruption time (for debouncing rapid interruptions)
}

// Store active web voice sessions (separate from Twilio bridges)
const activeWebSessions = new Map<string, WebVoiceSession>();

// Cache for preloaded context (separate from Twilio cache)
const preloadedContextCache = new Map<string, PreloadedContext>();

function getPreloadCacheKey(contactId: string, accountId: string): string {
  return `web:${contactId}:${accountId}`;
}

/**
 * Extract key intent words from text (removes filler words, focuses on meaning)
 */
function extractKeyIntent(text: string): string[] {
  const stopWords = new Set([
    'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
    'of', 'with', 'by', 'from', 'as', 'is', 'are', 'was', 'were', 'be',
    'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will',
    'would', 'could', 'should', 'may', 'might', 'can', 'this', 'that',
    'these', 'those', 'i', 'you', 'he', 'she', 'it', 'we', 'they', 'me',
    'him', 'her', 'us', 'them', 'my', 'your', 'his', 'her', 'its', 'our',
    'their', 'what', 'which', 'who', 'when', 'where', 'why', 'how', 'yes',
    'no', 'ok', 'okay', 'please', 'thank', 'thanks', 'tell', 'me', 'more',
  ]);

  return text.toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(word => word.length > 2 && !stopWords.has(word));
}

/**
 * Check if two texts have similar intent (using key words)
 */
function hasSimilarIntent(text1: string, text2: string, threshold: number = 0.5): boolean {
  const intent1 = new Set(extractKeyIntent(text1));
  const intent2 = new Set(extractKeyIntent(text2));

  if (intent1.size === 0 || intent2.size === 0) return false;

  const intersection = new Set([...intent1].filter(w => intent2.has(w)));
  const union = new Set([...intent1, ...intent2]);

  const similarity = intersection.size / union.size;
  const isSubset = intersection.size >= Math.min(intent1.size, intent2.size) * 0.7;

  return similarity >= threshold || isSubset;
}

/**
 * Remove echo by comparing transcription to AI's speech
 * Removes scattered echo words (not just consecutive sequences)
 */
function removeEchoFromTranscript(
  transcript: string,
  aiSpeechText: string | undefined
): string {
  if (!aiSpeechText || !transcript) {
    return transcript;
  }

  const normalize = (text: string) =>
    text.toLowerCase()
      .replace(/[^\w\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

  const normalizedTranscript = normalize(transcript);
  const normalizedAISpeech = normalize(aiSpeechText);

  const transcriptWords = normalizedTranscript.split(/\s+/);
  const aiWords = normalizedAISpeech.split(/\s+/);

  const aiWordSet = new Set(aiWords.filter(w => w.length > 2));

  const cleanedWords = transcriptWords.filter(word => {
    if (word.length <= 2) return true;

    const isInAISpeech = aiWordSet.has(word);

    if (isInAISpeech) {
      const wordIndex = transcriptWords.indexOf(word);
      if (wordIndex >= 0 && wordIndex < transcriptWords.length - 1) {
        const nextWord = transcriptWords[wordIndex + 1];
        if (aiWordSet.has(nextWord)) {
          return false;
        }
      }

      const aiWordCount = transcriptWords.filter(w => aiWordSet.has(w)).length;
      const similarity = aiWordCount / transcriptWords.length;
      if (similarity > 0.7) {
        return false;
      }
    }

    return true;
  });

  const cleaned = cleanedWords.join(' ').trim();

  if (cleaned !== normalizedTranscript) {
    logger.debug('[WEB_VOICE] Removed echo from transcript', {
      original: transcript,
      cleaned,
      aiSpeech: aiSpeechText.substring(0, 50),
    });
  }

  return cleaned || transcript;
}

/**
 * Preload CRM context for a call to reduce latency
 */
async function preloadContextForCall(
  accountId: string,
  contactId: string,
  campaignInstructions?: string
): Promise<PreloadedContext> {
  const loadStartTime = Date.now();

  try {
    const [systemPrompt, conversationHistory] = await Promise.all([
      buildSystemPrompt(accountId, contactId, campaignInstructions),
      getConversationHistory(contactId, accountId),
    ]);

    return {
      systemPrompt,
      conversationHistory,
      loadedAt: loadStartTime,
    };
  } catch (error: any) {
    logger.error('[WEB_VOICE] Error preloading context', {
      error: error.message,
      accountId,
      contactId,
    });
    return {
      systemPrompt: '',
      conversationHistory: [],
      loadedAt: loadStartTime,
    };
  }
}

/**
 * Start a web voice session (for browser-based testing)
 * COMPLETELY SEPARATE from Twilio voice calls
 */
export async function startWebVoiceSession(
  ws: WebSocket,
  sessionId: string,
  userId: string,
  agentId: string,
  accountId?: string,
  contactId?: string,
  instructions?: string,
  customIntroduction?: string
): Promise<void> {
  logger.info('[WEB_VOICE] Starting web voice session', {
    sessionId,
    userId,
    agentId,
    accountId: accountId || 'none',
    contactId: contactId || 'none',
    note: 'Web-based voice testing - completely separate from Twilio implementation',
  });

  // Initialize ElevenLabs TTS client
  let ttsClient: any = null;
  if (env.ELEVENLABS_API_KEY) {
    try {
      ttsClient = new ElevenLabsClient({
        apiKey: env.ELEVENLABS_API_KEY,
      });
      logger.info('[WEB_VOICE] ElevenLabs TTS client initialized', { sessionId });
    } catch (error: any) {
      logger.error('[WEB_VOICE] Failed to initialize TTS client', {
        sessionId,
        error: error.message,
      });
    }
  } else {
    logger.warn('[WEB_VOICE] ELEVENLABS_API_KEY not configured - TTS will not work', { sessionId });
  }

  // Create STT connection using official SDK
  // Use PCM format for web (browser sends PCM, not μ-law)
  let sttConnection: any = null;

  if (!env.ELEVENLABS_API_KEY) {
    logger.warn('[WEB_VOICE] ELEVENLABS_API_KEY not configured - STT will not work', {
      sessionId,
      note: 'ELEVENLABS_API_KEY required for web voice (both STT and TTS)',
    });
  } else {
    try {
      const sttClient = new ElevenLabsClient({
        apiKey: env.ELEVENLABS_API_KEY,
      });

      // Browser typically sends 16kHz PCM, but can also send 44.1kHz or 48kHz
      // We'll use PCM_16000 for lower latency (smaller data size)
      sttConnection = await sttClient.speechToText.realtime.connect({
        modelId: 'scribe_v2_realtime',
        audioFormat: AudioFormat.PCM_16000, // Browser sends PCM, not μ-law
        sampleRate: 16000,
        commitStrategy: CommitStrategy.VAD,
        vadThreshold: 0.4,
        vadSilenceThresholdSecs: 1.5,
        minSpeechDurationMs: 100,
        minSilenceDurationMs: 100,
        includeTimestamps: true,
      });

      // Set up STT event handlers
      sttConnection.on(RealtimeEvents.SESSION_STARTED, (data: any) => {
        logger.info('[WEB_VOICE] ✅ ElevenLabs STT session started', {
          sessionId,
          sessionData: data,
        });
      });

      sttConnection.on(RealtimeEvents.PARTIAL_TRANSCRIPT, (transcript: any) => {
        const text = typeof transcript === 'string' ? transcript : (transcript.text || '');
        if (text && text.trim()) {
          handleSTTResult(sessionId, {
            text: text.trim(),
            isFinal: false,
            confidence: transcript.confidence,
          });
        }
      });

      sttConnection.on(RealtimeEvents.COMMITTED_TRANSCRIPT, (transcript: any) => {
        const text = typeof transcript === 'string' ? transcript : (transcript.text || '');
        logger.info('[WEB_VOICE] ✅ ElevenLabs COMMITTED transcript', {
          sessionId,
          text,
          confidence: transcript.confidence,
        });

        if (text && text.trim()) {
          handleSTTResult(sessionId, {
            text: text.trim(),
            isFinal: true,
            confidence: transcript.confidence,
          });
        }
      });

      sttConnection.on(RealtimeEvents.ERROR, (error: any) => {
        logger.error('[WEB_VOICE] ❌ ElevenLabs STT error', {
          sessionId,
          error: error.message || error,
        });
      });

      sttConnection.on(RealtimeEvents.CLOSE, () => {
        logger.info('[WEB_VOICE] ElevenLabs STT connection closed', { sessionId });
      });

      logger.info('[WEB_VOICE] ElevenLabs STT connection created', {
        sessionId,
        note: 'Using ElevenLabs Scribe v2 Realtime for web voice STT',
      });
    } catch (error: any) {
      logger.error('[WEB_VOICE] Failed to create ElevenLabs STT connection', {
        sessionId,
        error: error.message,
      });
    }
  }

  const session: WebVoiceSession = {
    sessionId,
    ws,
    userId,
    accountId,
    contactId,
    agentId,
    ttsClient,
    sttConnection: sttConnection || undefined,
    isAISpeaking: false,
    instructions,
    customIntroduction, // Store custom introduction if provided
  };

  activeWebSessions.set(sessionId, session);

  // Check for preloaded context
  const cacheKey = accountId && contactId ? getPreloadCacheKey(contactId, accountId) : null;
  const cachedContext = cacheKey ? preloadedContextCache.get(cacheKey) : undefined;

  if (cachedContext) {
    session.preloadedContext = cachedContext;
    preloadedContextCache.delete(cacheKey);
    logger.info('[WEB_VOICE] Using preloaded context from cache', {
      sessionId,
      hasSystemPrompt: !!cachedContext.systemPrompt,
      historyLength: cachedContext.conversationHistory.length,
      loadTimeMs: Date.now() - cachedContext.loadedAt,
    });
  } else if (accountId && contactId) {
    preloadContextForCall(accountId, contactId, instructions).then((context) => {
      if (activeWebSessions.has(sessionId)) {
        const s = activeWebSessions.get(sessionId);
        if (s) {
          s.preloadedContext = context;
          logger.info('[WEB_VOICE] Context preloaded successfully', {
            sessionId,
            hasSystemPrompt: !!context.systemPrompt,
            historyLength: context.conversationHistory.length,
          });
        }
      }
    }).catch((error: any) => {
      logger.warn('[WEB_VOICE] Failed to preload context', {
        sessionId,
        error: error.message,
      });
    });
  }

  // Send welcome message
  ws.send(JSON.stringify({
    type: 'session_started',
    sessionId,
    message: 'Web voice session started',
  }));

  // Send initial greeting
  logger.info('[WEB_VOICE] Initial greeting check', {
    sessionId,
    hasTTSClient: !!ttsClient,
    hasOpenAIKey: !!env.OPENAI_API_KEY,
    hasElevenLabsKey: !!env.ELEVENLABS_API_KEY,
    hasSTTConnection: !!sttConnection,
    hasInstructions: !!instructions,
    hasCustomIntroduction: !!customIntroduction,
  });

  if (ttsClient && env.OPENAI_API_KEY) {
    // Use custom introduction if provided, otherwise use default greeting
    let greetingMessage: string;
    if (customIntroduction && customIntroduction.trim()) {
      greetingMessage = customIntroduction.trim();
    } else if (instructions && instructions.trim()) {
      greetingMessage = `You are calling about a campaign. Please greet the caller warmly, ask if they have a moment to spare, and then discuss the campaign based on these instructions:\n\n${instructions.trim()}\n\nStart the conversation now.`;
    } else {
      greetingMessage = 'The caller has just connected to the call. Please introduce yourself briefly and ask how you can help them today.';
    }

    logger.info('[WEB_VOICE] ✅ Sending initial greeting', {
      sessionId,
      hasInstructions: !!instructions,
      hasCustomIntroduction: !!customIntroduction,
      greetingLength: greetingMessage.length,
      greetingPreview: greetingMessage.substring(0, 100),
    });

    sendTextToAgentWeb(sessionId, greetingMessage).catch((error: any) => {
      logger.error('[WEB_VOICE] ❌ Failed to send initial greeting', {
        sessionId,
        error: error.message,
        stack: error.stack,
      });
    });
  } else {
    logger.warn('[WEB_VOICE] ⚠️ Cannot send initial greeting - missing requirements', {
      sessionId,
      hasTTSClient: !!ttsClient,
      hasOpenAIKey: !!env.OPENAI_API_KEY,
      hasElevenLabsKey: !!env.ELEVENLABS_API_KEY,
      note: 'Both TTS client and OPENAI_API_KEY are required for initial greeting',
    });
  }

  // Handle WebSocket close
  ws.on('close', () => {
    stopWebVoiceSession(sessionId);
  });

  ws.on('error', (error: any) => {
    logger.error('[WEB_VOICE] WebSocket error', {
      sessionId,
      error: error.message,
    });
    stopWebVoiceSession(sessionId);
  });
}

/**
 * Handle audio data from browser
 * Browser sends PCM 16-bit audio chunks (typically 16kHz)
 */
export function handleWebAudio(sessionId: string, audioData: Buffer, sampleRate: number = 16000): void {
  const session = activeWebSessions.get(sessionId);
  if (!session || !session.sttConnection) {
    return;
  }

  // ECHO PREVENTION: Don't send to STT while AI is speaking (with delay for interruption)
  const ECHO_PREVENTION_DELAY_MS = 800;

  if (session.isAISpeaking && session.aiSpeechStartTime) {
    const timeSinceAIStarted = Date.now() - session.aiSpeechStartTime;
    if (timeSinceAIStarted < ECHO_PREVENTION_DELAY_MS) {
      return; // Prevent echo
    }
    // After delay, allow audio to flow (enables interruption detection)
  }

  try {
    // Convert Buffer to base64 and send to ElevenLabs STT
    // Browser sends PCM, ElevenLabs expects PCM_16000 format
    const audioBase64 = audioData.toString('base64');

    session.sttConnection.send({
      audioBase64,
      sampleRate: sampleRate, // Use provided sample rate (typically 16000)
    });
  } catch (error: any) {
    logger.error('[WEB_VOICE] Failed to send audio to STT', {
      sessionId,
      error: error.message,
    });
  }
}

/**
 * Handle STT result
 */
function handleSTTResult(sessionId: string, result: { text: string; isFinal: boolean; confidence?: number }): void {
  const session = activeWebSessions.get(sessionId);
  if (!session) return;

  // Check ignore window
  if (session.ignoreTranscriptsUntil && Date.now() < session.ignoreTranscriptsUntil) {
    return;
  }

  // Interruption detection (same logic as optimized bridge)
  if (session.isAISpeaking) {
    const timeSinceAIStarted = session.aiSpeechStartTime
      ? Date.now() - session.aiSpeechStartTime
      : Infinity;

    // Quick interruption keywords (detect even in partial transcripts)
    // FIX: Already using word boundaries (good!)
    const interruptionKeywords = ['stop', 'wait', 'hold', 'pause', 'enough', 'no'];
    const hasInterruptionKeyword = interruptionKeywords.some(keyword =>
      new RegExp(`\\b${keyword}\\b`, 'i').test(result.text)
    );

    // FIX: Debounce rapid interruptions (prevent "stop stop stop" spam)
    const now = Date.now();
    const lastInterruptionTime = session.lastInterruptionTime || 0;
    const timeSinceLastInterruption = now - lastInterruptionTime;

    if (hasInterruptionKeyword && timeSinceLastInterruption < 500) {
      logger.debug('[WEB_VOICE] Ignoring rapid repeated interruption', {
        sessionId,
        text: result.text,
        timeSinceLastInterruption,
        note: 'Debouncing rapid interruptions - only process first one',
      });
      return;
    }

    // Update last interruption time
    if (hasInterruptionKeyword) {
      session.lastInterruptionTime = now;
    }

    const isQuickInterruption = hasInterruptionKeyword && result.text.trim().length >= 3;
    const isSubstantialSpeech = result.isFinal &&
      result.text.trim().length > 5 &&
      (timeSinceAIStarted > 1500 || result.text.trim().length > 15);

    if (!isQuickInterruption && !isSubstantialSpeech) {
      logger.debug('[WEB_VOICE] Ignoring transcript - likely echo while AI speaking', {
        sessionId,
        text: result.text.substring(0, 50),
        timeSinceAIStarted,
        isFinal: result.isFinal,
        hasKeyword: hasInterruptionKeyword,
      });
      return;
    }

    // User interrupting
    logger.info('[WEB_VOICE] 🛑 User interrupting AI', {
      sessionId,
      text: result.text.substring(0, 100),
      timeSinceAIStarted,
      isQuickInterruption,
      isFinal: result.isFinal,
    });

    session.shouldStopAudio = true;
    session.isAISpeaking = false;
    session.aiSpeechEndTime = Date.now();

    if (isQuickInterruption && !result.isFinal) {
      // Process partial transcript with keyword immediately
      const interruptionText = result.text.trim();
      
      // FIX: Track processed partial transcripts to avoid duplicate processing when final arrives
      if (!session.processedPartialTranscripts) {
        session.processedPartialTranscripts = [];
      }
      session.processedPartialTranscripts.push({
        text: interruptionText,
        time: now,
      });
      // Keep only last 3 partial transcripts
      if (session.processedPartialTranscripts.length > 3) {
        session.processedPartialTranscripts.shift();
      }
      
      sendTextToAgentWeb(sessionId, interruptionText);
      return;
    }
  }

  if (result.isFinal) {
    let finalText = result.text.trim();
    if (!finalText) return;

    // FIX: Check if this final transcript was already processed as a partial
    const now = Date.now();
    const wasProcessedAsPartial = session.processedPartialTranscripts?.some(ppt => {
      const timeSincePartial = now - ppt.time;
      return timeSincePartial < 2000 && hasSimilarIntent(finalText, ppt.text, 0.8);
    });

    if (wasProcessedAsPartial) {
      logger.debug('[WEB_VOICE] Ignoring final transcript - already processed as partial', {
        sessionId,
        text: finalText,
        note: 'Preventing duplicate processing - partial transcript was already handled',
      });
      return;
    }

    // Echo removal
    if (session.lastAISpeechText) {
      const originalText = finalText;
      finalText = removeEchoFromTranscript(finalText, session.lastAISpeechText);

      if (!finalText || !finalText.trim()) {
        logger.debug('[WEB_VOICE] Transcript was all echo - filtered out', {
          sessionId,
          original: originalText,
        });
        return;
      }
    }

    // Duplicate detection (now already defined above)
    if (session.lastTranscriptText === finalText && session.lastTranscriptTime) {
      const timeSinceLastTranscript = now - session.lastTranscriptTime;
      if (timeSinceLastTranscript < 1000) {
        logger.debug('[WEB_VOICE] Ignoring duplicate transcript', {
          sessionId,
          text: finalText,
          timeSinceLastTranscript,
        });
        return;
      }
    }

    // Repeated similar intent detection
    if (!session.recentTranscripts) {
      session.recentTranscripts = [];
    }

    const thirtySecondsAgo = now - 30000;
    session.recentTranscripts = session.recentTranscripts.filter(t => t.time > thirtySecondsAgo);

    const isRepeated = session.recentTranscripts.some(recent => {
      const timeSinceRecent = now - recent.time;
      return timeSinceRecent <= 15000 && hasSimilarIntent(finalText, recent.text, 0.5);
    });

    if (isRepeated) {
      logger.debug('[WEB_VOICE] Ignoring repeated similar intent', {
        sessionId,
        text: finalText,
        recentCount: session.recentTranscripts.length,
      });
      return;
    }

    session.recentTranscripts.push({
      text: finalText,
      time: now,
    });

    if (session.recentTranscripts.length > 5) {
      session.recentTranscripts.shift();
    }

    session.lastTranscriptText = finalText;
    session.lastTranscriptTime = now;

    // Cooldown check
    const timeSinceLastProcess = session.lastTranscriptProcessedTime
      ? now - session.lastTranscriptProcessedTime
      : Infinity;

    if (timeSinceLastProcess < 500) {
      logger.debug('[WEB_VOICE] Ignoring transcript - too soon after last one', {
        sessionId,
        text: finalText.substring(0, 50),
        timeSinceLastProcess,
      });
      return;
    }

    logger.info('[WEB_VOICE] 📝 Processing transcript', {
      sessionId,
      text: finalText.substring(0, 50),
    });

    session.lastTranscriptProcessedTime = now;
    sendTextToAgentWeb(sessionId, finalText);
  } else {
    // Partial transcript - check for interruption keywords
    const interruptionKeywords = ['stop', 'wait', 'hold', 'pause', 'enough', 'no'];
    const hasInterruptionKeyword = interruptionKeywords.some(keyword =>
      new RegExp(`\\b${keyword}\\b`, 'i').test(result.text)
    );

    if (hasInterruptionKeyword && session.isAISpeaking && result.text.trim().length >= 3) {
      // FIX: Debounce rapid interruptions
      const now = Date.now();
      const lastInterruptionTime = session.lastInterruptionTime || 0;
      const timeSinceLastInterruption = now - lastInterruptionTime;

      if (timeSinceLastInterruption < 500) {
        logger.debug('[WEB_VOICE] Ignoring rapid repeated interruption (partial)', {
          sessionId,
          text: result.text,
          timeSinceLastInterruption,
        });
        return;
      }

      session.lastInterruptionTime = now;

      const interruptionText = result.text.trim();

      // FIX: Track processed partial transcripts
      if (!session.processedPartialTranscripts) {
        session.processedPartialTranscripts = [];
      }
      session.processedPartialTranscripts.push({
        text: interruptionText,
        time: now,
      });
      if (session.processedPartialTranscripts.length > 3) {
        session.processedPartialTranscripts.shift();
      }

      logger.info('[WEB_VOICE] 🛑 Fast interruption detection (partial transcript)', {
        sessionId,
        text: interruptionText.substring(0, 100),
      });
      session.shouldStopAudio = true;
      session.isAISpeaking = false;
      session.aiSpeechEndTime = now;
      session.lastTranscriptProcessedTime = now;
      sendTextToAgentWeb(sessionId, interruptionText);
    }
  }
}

/**
 * Send text to agent and convert response to audio
 */
async function sendTextToAgentWeb(sessionId: string, text: string): Promise<void> {
  const session = activeWebSessions.get(sessionId);
  if (!session) {
    logger.warn('[WEB_VOICE] Cannot send text - session not available', { sessionId });
    return;
  }

  if (!text.trim()) {
    logger.debug('[WEB_VOICE] Empty text - skipping agent call', { sessionId });
    session.isAISpeaking = false;
    return;
  }

  logger.info('[WEB_VOICE] 📤 Sending text to agent', {
    sessionId,
    textLength: text.length,
    textPreview: text.substring(0, 100),
    hasAccountId: !!session.accountId,
    hasContactId: !!session.contactId,
    hasInstructions: !!session.instructions,
    agentId: session.agentId,
  });

  // FIX: Cancel previous request if still pending (race condition prevention)
  if (session.pendingAgentRequest) {
    logger.info('[WEB_VOICE] 🚫 Cancelling previous agent request', {
      sessionId,
      previousText: session.pendingAgentRequest.text,
      newText: text,
      timeSincePrevious: Date.now() - session.pendingAgentRequest.timestamp,
      note: 'User interrupted - only processing latest request',
    });
  }

  // Store new request
  session.pendingAgentRequest = { text, timestamp: Date.now() };

  try {
    // Ignore transcripts temporarily before getting AI response
    if (session.sttConnection) {
      session.ignoreTranscriptsUntil = Date.now() + 500;
    }

    // Send to OpenAI via agent service (reuse existing service)
    const response = await sendMessageToAgent(
      session.agentId,
      text,
      undefined,
      session.contactId,
      session.accountId,
      3,
      session.instructions,
      session.preloadedContext
    );

    // FIX: Only process if this is still the latest request (race condition prevention)
    if (session.pendingAgentRequest?.text !== text) {
      logger.debug('[WEB_VOICE] Ignoring response - newer request exists', {
        sessionId,
        thisText: text,
        latestText: session.pendingAgentRequest?.text,
        note: 'User interrupted again - only processing latest request',
      });
      return;
    }

    if (session.sttConnection) {
      session.ignoreTranscriptsUntil = Date.now() + 500;
    }

    if (response.success && response.response) {
      logger.info('[WEB_VOICE] ✅ AI response received', {
        sessionId,
        responseLength: response.response.length,
        responsePreview: response.response.substring(0, 150),
      });

      // Store in conversation
      if (session.contactId && session.accountId) {
        try {
          if (!session.conversationId) {
            const conversation = await upsertConversation(
              session.contactId,
              session.accountId,
              'call',
              undefined,
              undefined
            );
            session.conversationId = conversation._id.toString();
          }

          if (session.conversationId) {
            await addMessageToConversation(
              session.conversationId,
              'assistant',
              response.response,
              { message_id: sessionId }
            );
          }
        } catch (error: any) {
          logger.error('[WEB_VOICE] Failed to store conversation', {
            sessionId,
            error: error.message,
          });
        }
      }

      // Convert to audio and send to browser
      await sendAgentResponseAsAudio(sessionId, response.response);
    } else {
      // Only reset if this was the latest request
      if (session.pendingAgentRequest?.text === text) {
        session.isAISpeaking = false;
        session.pendingAgentRequest = undefined;
      }
      logger.error('[WEB_VOICE] ❌ AI response failed', {
        sessionId,
        error: response.error,
      });
    }
  } catch (error: any) {
    // Only reset if this was the latest request
    if (session.pendingAgentRequest?.text === text) {
      session.isAISpeaking = false;
      session.pendingAgentRequest = undefined;
    }
    logger.error('[WEB_VOICE] ❌ Exception sending to AI', {
      sessionId,
      error: error.message,
    });
  } finally {
    // Clear pending request if this was the latest one
    if (session.pendingAgentRequest?.text === text) {
      session.pendingAgentRequest = undefined;
    }
  }
}

/**
 * Convert agent response to audio and send to browser via WebSocket
 */
async function sendAgentResponseAsAudio(sessionId: string, text: string): Promise<void> {
  const session = activeWebSessions.get(sessionId);
  if (!session || !session.ttsClient) {
    logger.error('[WEB_VOICE] TTS client not available', {
      sessionId,
      hasSession: !!session,
      hasTtsClient: !!(session && session.ttsClient),
    });
    return;
  }

  if (!text || !text.trim()) {
    logger.warn('[WEB_VOICE] Cannot convert empty text to audio', { sessionId });
    return;
  }

  try {
    session.isAISpeaking = true;
    session.aiSpeechStartTime = Date.now();
    session.lastAISpeechText = text;

    if (session.sttConnection) {
      session.ignoreTranscriptsUntil = Date.now() + 500;
    }

    const voiceId = env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM';

    logger.info('[WEB_VOICE] Converting text to audio via ElevenLabs TTS', {
      sessionId,
      textLength: text.length,
      textPreview: text.substring(0, 50) + '...',
      voiceId,
    });

    // Get TTS audio from ElevenLabs
    // Use PCM format for web (browser can play PCM directly)
    // Use 16kHz to match STT and work on all ElevenLabs tiers
    const response = await session.ttsClient.textToSpeech.convert(voiceId, {
      text,
      modelId: 'eleven_flash_v2_5',
      outputFormat: 'pcm_16000', // PCM 16kHz - works on all tiers, matches STT sample rate
    });

    // Stream audio chunks to browser
    const readableStream = Readable.from(response);
    let totalBytes = 0;
    let chunkCount = 0;

    readableStream.on('data', (chunk: Buffer) => {
      if (session.shouldStopAudio) {
        readableStream.destroy();
        return;
      }

      // Send audio chunk to browser via WebSocket
      try {
        const base64Audio = chunk.toString('base64');
        
        // Add debug logging for first chunk
        if (chunkCount === 0) {
          logger.debug('[WEB_VOICE] First audio chunk sent', {
            sessionId,
            chunkSize: chunk.length,
            base64Length: base64Audio.length,
            base64Preview: base64Audio.substring(0, 50),
            isValidBase64: /^[A-Za-z0-9+/=]*$/.test(base64Audio),
          });
        }

        session.ws.send(JSON.stringify({
          type: 'audio_chunk',
          audio: base64Audio, // Base64 encode for JSON
          sampleRate: 16000, // Changed from 44100 to 16000 to match TTS output
          format: 'pcm',
        }));

        totalBytes += chunk.length;
        chunkCount++;
      } catch (error: any) {
        logger.error('[WEB_VOICE] Failed to send audio chunk', {
          sessionId,
          error: error.message,
          chunkSize: chunk.length,
        });
      }
    });

    readableStream.on('end', () => {
      const durationMs = Math.round((totalBytes / (16000 * 2)) * 1000); // 2 bytes per sample (16-bit), 16kHz sample rate

      logger.info('[WEB_VOICE] ✅ Audio streaming completed', {
        sessionId,
        totalBytes,
        chunkCount,
        estimatedDurationSeconds: (durationMs / 1000).toFixed(1),
      });

      // Reset speaking state after audio finishes
      setTimeout(() => {
        if (activeWebSessions.has(sessionId)) {
          const s = activeWebSessions.get(sessionId);
          if (s && !s.shouldStopAudio) {
            s.isAISpeaking = false;
            s.aiSpeechEndTime = Date.now();
            s.ignoreTranscriptsUntil = Date.now() + 500;
          }
        }
      }, durationMs + 500);

      session.ws.send(JSON.stringify({
        type: 'audio_end',
        totalBytes,
        durationMs,
      }));
    });

    readableStream.on('error', (error: any) => {
      logger.error('[WEB_VOICE] Audio stream error', {
        sessionId,
        error: error.message,
      });
      session.isAISpeaking = false;
    });
  } catch (error: any) {
    logger.error('[WEB_VOICE] ❌ Exception while converting text to audio', {
      sessionId,
      error: error.message,
      stack: error.stack,
      textLength: text.length,
    });
    session.isAISpeaking = false;
  }
}

/**
 * Stop web voice session
 */
export function stopWebVoiceSession(sessionId: string): void {
  const session = activeWebSessions.get(sessionId);
  if (!session) {
    return;
  }

  logger.info('[WEB_VOICE] Stopping web voice session', { sessionId });

  // Close STT connection
  if (session.sttConnection) {
    try {
      session.sttConnection.commit();
      session.sttConnection.close();
      logger.info('[WEB_VOICE] ElevenLabs STT connection closed', { sessionId });
    } catch (error: any) {
      logger.error('[WEB_VOICE] Error closing STT connection', {
        sessionId,
        error: error.message,
      });
    }
  }

  activeWebSessions.delete(sessionId);
}

/**
 * Get web voice session
 */
export function getWebVoiceSession(sessionId: string): WebVoiceSession | undefined {
  return activeWebSessions.get(sessionId);
}

/**
 * Export function to preload context before web voice session (similar to Twilio)
 */
export async function preloadContextBeforeWebVoice(
  accountId: string,
  contactId: string,
  instructions?: string
): Promise<void> {
  const cacheKey = getPreloadCacheKey(contactId, accountId);

  if (preloadedContextCache.has(cacheKey)) {
    logger.debug('[WEB_VOICE] Context already preloaded', {
      contactId,
      accountId,
      cacheKey,
    });
    return;
  }

  logger.info('[WEB_VOICE] Starting preload before web voice session', {
    contactId,
    accountId,
    hasInstructions: !!instructions,
  });

  preloadContextForCall(accountId, contactId, instructions)
    .then((context) => {
      preloadedContextCache.set(cacheKey, context);
      logger.info('[WEB_VOICE] Context preloaded before web voice session', {
        contactId,
        accountId,
        hasSystemPrompt: !!context.systemPrompt,
        historyLength: context.conversationHistory.length,
        loadTimeMs: Date.now() - context.loadedAt,
      });
    })
    .catch((error: any) => {
      logger.warn('[WEB_VOICE] Failed to preload context before web voice session', {
        contactId,
        accountId,
        error: error.message,
      });
    });
}
