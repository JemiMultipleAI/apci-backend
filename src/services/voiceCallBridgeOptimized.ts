import { logger } from '../utils/logger';
import { env } from '../config/env';
import { sendAudioToStream, MediaStreamConnection } from './twilioMediaStreams';
import { STTResult } from './speechToText';
import { sendMessageToAgent } from './agentService'; // Use unified agent service (OpenAI Chat API)
import { upsertConversation, addMessageToConversation } from './conversationService';
import { buildSystemPrompt, getConversationHistory } from './openaiAgent';
import { Readable } from 'stream';
import { ElevenLabsClient, RealtimeEvents, AudioFormat, CommitStrategy } from '@elevenlabs/elevenlabs-js';

interface PreloadedContext {
  systemPrompt: string;
  conversationHistory: Array<{ role: 'user' | 'assistant'; content: string; timestamp: Date }>;
  loadedAt: number;
}

interface VoiceCallBridge {
  callSid: string;
  agentId: string; // Agent config ID (used for context, not WebSocket)
  contactId?: string;
  accountId?: string;
  conversationId?: string; // MongoDB conversation document ID
  audioBuffer: Buffer[];
  textBuffer: string;
  lastSttTime: number;
  isProcessing: boolean;
  ttsClient?: ElevenLabsClient;
  voiceId: string;
  sttConnection?: any; // ElevenLabs realtime STT connection (official SDK)
  pendingTranscript: string;
  transcriptTimeout?: NodeJS.Timeout;
  firstAudioSent: boolean; // Track if we've sent the first audio (to add delay after template)
  lastSttLogTime: number; // Track when we last logged STT activity
  isWaitingForResponse: boolean; // Track if we're waiting for AI response
  isAISpeaking: boolean; // Track if AI is currently speaking (to suppress STT during echo)
  aiSpeechStartTime?: number; // When AI started speaking
  aiSpeechEndTime?: number; // When AI finished speaking
  lastTranscriptText?: string; // Track last transcript to detect duplicates
  lastTranscriptTime?: number; // Track when last transcript was received
  lastTranscriptProcessedTime?: number; // Track when we last processed a transcript (for cooldown)
  instructions?: string; // Campaign instructions for AI context
  preloadedContext?: PreloadedContext; // Preloaded CRM context to reduce latency
  shouldStopAudio?: boolean; // Flag to stop sending audio chunks (for user interruption)
  ignoreTranscriptsUntil?: number; // Timestamp until which to ignore transcripts (for clearing buffer)
}

// Store active bridges
const activeBridges = new Map<string, VoiceCallBridge>();

// Buffer for audio chunks received before bridge is ready
const pendingAudioBuffers = new Map<string, Array<{ chunk: Buffer; timestamp: number }>>();

// Cache for preloaded context (keyed by contactId + accountId for retrieval before call connects)
const preloadedContextCache = new Map<string, PreloadedContext>();

// Helper to generate cache key
function getPreloadCacheKey(contactId: string, accountId: string): string {
  return `${contactId}:${accountId}`;
}

/**
 * Start voice call bridge with simplified flow:
 * Twilio Audio → OpenAI STT → OpenAI Chat API → ElevenLabs TTS → Twilio Audio
 * OPTIMIZED VERSION: Trusts ulaw_8000 output and streams TTS chunks immediately
 */
export async function startVoiceCallBridge(
  streamConnection: MediaStreamConnection,
  agentId: string,
  contactId?: string,
  accountId?: string,
  customIntroduction?: string,
  instructions?: string // Campaign instructions for AI context
): Promise<void> {
  const callSid = streamConnection.callSid;
  const voiceId = env.ELEVENLABS_VOICE_ID || '21m00Tcm4TlvDq8ikWAM';

  logger.info('[VOICE_BRIDGE_OPTIMIZED] Starting optimized bridge (ElevenLabs STT → OpenAI Chat → ElevenLabs TTS)', {
    callSid,
    agentId: agentId.substring(0, 8) + '...',
    contactId,
    accountId: accountId || 'MISSING',
    hasAccountId: !!accountId,
    hasContactId: !!contactId,
    sttProvider: 'elevenlabs', // FORCED for optimized version (real-time streaming)
    ttsProvider: 'elevenlabs', // FORCED for optimized version
    aiProvider: 'openai',
    note: accountId 
      ? '✅ Agent will have CRM context (campaigns, deals, contact info)' 
      : '⚠️ No accountId - agent will NOT have CRM context (generic responses only)',
  });

  // Initialize ElevenLabs TTS client
  let ttsClient: any = null;
  if (env.ELEVENLABS_API_KEY) {
    try {
      ttsClient = new ElevenLabsClient({
        apiKey: env.ELEVENLABS_API_KEY,
      });
      logger.info('[VOICE_BRIDGE_OPTIMIZED] ElevenLabs TTS client initialized', { callSid });
    } catch (error: any) {
      logger.error('[VOICE_BRIDGE_OPTIMIZED] Failed to initialize TTS client', {
        callSid,
        error: error.message,
      });
    }
  } else {
    logger.warn('[VOICE_BRIDGE_OPTIMIZED] ELEVENLABS_API_KEY not configured - TTS will not work', { callSid });
  }

  // Create STT connection using official SDK - FORCE ElevenLabs for optimized version
  // Per docs: https://elevenlabs.io/docs/developers/guides/cookbooks/speech-to-text/realtime/server-side-streaming
  let sttConnection: any = null;
  
  if (!env.ELEVENLABS_API_KEY) {
    logger.warn('[VOICE_BRIDGE_OPTIMIZED] ELEVENLABS_API_KEY not configured - STT will not work', {
      callSid,
      note: 'ELEVENLABS_API_KEY required for optimized version (both STT and TTS)',
    });
  } else {
    try {
      const sttClient = new ElevenLabsClient({
        apiKey: env.ELEVENLABS_API_KEY,
      });

      // Connect using official SDK with manual audio chunking
      sttConnection = await sttClient.speechToText.realtime.connect({
        modelId: 'scribe_v2_realtime',
        audioFormat: AudioFormat.ULAW_8000,
        sampleRate: 8000,
        commitStrategy: CommitStrategy.VAD,
        vadThreshold: 0.4,
        vadSilenceThresholdSecs: 1.5,
        minSpeechDurationMs: 100,
        minSilenceDurationMs: 100,
        includeTimestamps: true,
      });

      // Set up event handlers per official SDK documentation
      sttConnection.on(RealtimeEvents.SESSION_STARTED, (data: any) => {
        logger.info('[VOICE_BRIDGE_OPTIMIZED] ✅ ElevenLabs STT session started', {
          callSid,
          sessionData: data,
          note: 'Using ElevenLabs Scribe v2 Realtime for lower latency STT',
        });
      });

      sttConnection.on(RealtimeEvents.PARTIAL_TRANSCRIPT, (transcript: any) => {
        const text = typeof transcript === 'string' ? transcript : (transcript.text || '');
        logger.info('[VOICE_BRIDGE_OPTIMIZED] 🎤 ElevenLabs PARTIAL transcript', {
          callSid,
          text,
          confidence: transcript.confidence,
          note: 'Partial transcript from ElevenLabs STT',
        });
        
        if (text && text.trim()) {
          handleSTTResult(callSid, {
            text: text.trim(),
            isFinal: false,
            confidence: transcript.confidence,
          });
        }
      });

      sttConnection.on(RealtimeEvents.COMMITTED_TRANSCRIPT, (transcript: any) => {
        const text = typeof transcript === 'string' ? transcript : (transcript.text || '');
        logger.info('[VOICE_BRIDGE_OPTIMIZED] ✅ ElevenLabs COMMITTED transcript', {
          callSid,
          text,
          confidence: transcript.confidence,
          note: 'Final transcript from ElevenLabs STT',
        });
        
        if (text && text.trim()) {
          handleSTTResult(callSid, {
            text: text.trim(),
            isFinal: true,
            confidence: transcript.confidence,
          });
        }
      });

      sttConnection.on(RealtimeEvents.COMMITTED_TRANSCRIPT_WITH_TIMESTAMPS, (transcript: any) => {
        const text = typeof transcript === 'string' ? transcript : (transcript.text || '');
        logger.info('[VOICE_BRIDGE_OPTIMIZED] ✅ ElevenLabs COMMITTED transcript with timestamps', {
          callSid,
          text,
          words: transcript.words,
          confidence: transcript.confidence,
          note: 'Final transcript with word-level timestamps from ElevenLabs STT',
        });
        
        if (text && text.trim()) {
          handleSTTResult(callSid, {
            text: text.trim(),
            isFinal: true,
            confidence: transcript.confidence,
          });
        }
      });

      sttConnection.on(RealtimeEvents.ERROR, (error: any) => {
        logger.error('[VOICE_BRIDGE_OPTIMIZED] ❌ ElevenLabs STT error', {
          callSid,
          error: error.message || error,
          errorType: error.type,
          note: 'Error from ElevenLabs STT connection',
        });
      });

      sttConnection.on(RealtimeEvents.CLOSE, () => {
        logger.info('[VOICE_BRIDGE_OPTIMIZED] ElevenLabs STT connection closed', {
          callSid,
          note: 'STT connection closed',
        });
      });

      logger.info('[VOICE_BRIDGE_OPTIMIZED] ElevenLabs STT connection created (real-time streaming)', {
        callSid,
        note: 'Using ElevenLabs Scribe v2 Realtime for lower latency STT',
      });
    } catch (error: any) {
      logger.error('[VOICE_BRIDGE_OPTIMIZED] Failed to create ElevenLabs STT connection', {
        callSid,
        error: error.message,
        note: 'STT will not be available for this call',
      });
    }
  }

  const bridge: VoiceCallBridge = {
    callSid,
    agentId, // Agent config ID (for context in OpenAI Chat API)
    contactId,
    accountId,
    audioBuffer: [],
    textBuffer: '',
    lastSttTime: Date.now(),
    isProcessing: false,
    ttsClient,
    voiceId,
    sttConnection: sttConnection || undefined,
    pendingTranscript: '',
    firstAudioSent: false,
    lastSttLogTime: 0,
    isWaitingForResponse: false,
    isAISpeaking: false, // AI not speaking initially
    lastTranscriptText: undefined,
    lastTranscriptTime: undefined,
    instructions, // Store campaign instructions for all messages
  };

  activeBridges.set(callSid, bridge);

  // Check for preloaded context in cache first
  const cacheKey = accountId && contactId ? getPreloadCacheKey(contactId, accountId) : null;
  const cachedContext = cacheKey ? preloadedContextCache.get(cacheKey) : undefined;

  if (cachedContext) {
    // Use preloaded context immediately
    bridge.preloadedContext = cachedContext;
    preloadedContextCache.delete(cacheKey); // Clean up cache
    logger.info('[VOICE_BRIDGE_OPTIMIZED] Using preloaded context from cache', {
      callSid,
      hasSystemPrompt: !!cachedContext.systemPrompt,
      historyLength: cachedContext.conversationHistory.length,
      loadTimeMs: Date.now() - cachedContext.loadedAt,
      note: '✅ Context was preloaded before call - zero latency!',
    });
  } else if (accountId && contactId) {
    // Fallback: Preload context asynchronously (if not already cached)
    preloadContextForCall(accountId, contactId, instructions).then((context) => {
      if (activeBridges.has(callSid)) {
        const bridge = activeBridges.get(callSid);
        if (bridge) {
          bridge.preloadedContext = context;
          logger.info('[VOICE_BRIDGE_OPTIMIZED] Context preloaded successfully', {
            callSid,
            hasSystemPrompt: !!context.systemPrompt,
            historyLength: context.conversationHistory.length,
            loadTimeMs: Date.now() - context.loadedAt,
            note: 'First AI response will be faster - no database queries needed',
          });
        }
      }
    }).catch((error: any) => {
      logger.warn('[VOICE_BRIDGE_OPTIMIZED] Failed to preload context', {
        callSid,
        error: error.message,
        note: 'Will load on-demand (slower)',
      });
    });
  } else {
    logger.debug('[VOICE_BRIDGE_OPTIMIZED] Skipping context preload - missing accountId or contactId', {
      callSid,
      hasAccountId: !!accountId,
      hasContactId: !!contactId,
    });
  }

  // Flush any buffered audio chunks that arrived before bridge was ready
  const bufferedChunks = pendingAudioBuffers.get(callSid);
  if (bufferedChunks && bufferedChunks.length > 0) {
    logger.info('[VOICE_BRIDGE_OPTIMIZED] Flushing buffered audio chunks', {
      callSid,
      bufferedChunkCount: bufferedChunks.length,
      note: 'Processing audio that arrived before bridge was ready',
    });
    
    for (const { chunk, timestamp } of bufferedChunks) {
      await handleInboundAudio(callSid, chunk, timestamp);
    }
    
    pendingAudioBuffers.delete(callSid);
    
    logger.info('[VOICE_BRIDGE_OPTIMIZED] Finished flushing buffered audio chunks', {
      callSid,
      processedChunks: bufferedChunks.length,
    });
  }

  logger.info('[VOICE_BRIDGE_OPTIMIZED] Bridge started successfully', {
    callSid,
    hasSttConnection: !!sttConnection,
    hasTtsClient: !!ttsClient,
  });

  // Send initial greeting/context message to the AI agent
  // This will trigger the AI to respond with a greeting so the caller hears something immediately
  if (ttsClient && env.OPENAI_API_KEY) {
    // Build greeting message with campaign instructions if available
    let greetingMessage: string;
    
    if (instructions && instructions.trim()) {
      // If campaign instructions are provided, include them in the prompt
      // Make it explicit: greet first, ask for time, then discuss the campaign
      if (customIntroduction && customIntroduction.trim()) {
        greetingMessage = `${customIntroduction.trim()}\n\nYou are calling about a campaign. Please follow this flow:\n1. Greet the caller warmly and introduce yourself\n2. Ask if they have a moment to spare or if now is a good time to talk\n3. Once they confirm, discuss the campaign based on these instructions:\n\n${instructions.trim()}\n\nStart the conversation now.`;
      } else {
        greetingMessage = `You are calling about a campaign. Please follow this flow:\n1. Greet the caller warmly and introduce yourself\n2. Ask if they have a moment to spare or if now is a good time to talk\n3. Once they confirm, discuss the campaign based on these instructions:\n\n${instructions.trim()}\n\nStart the conversation now.`;
      }
    } else {
      // Fallback to custom introduction or default greeting
      greetingMessage = customIntroduction && customIntroduction.trim()
        ? customIntroduction.trim()
        : 'The caller has just connected to the call. Please introduce yourself briefly and ask how you can help them today.';
    }
    
    // OPTIMIZATION: Send greeting immediately - don't wait for preload
    // Preload will be used if ready, otherwise load on-demand (still faster than waiting)
    // This reduces initial greeting delay from ~8 seconds to ~2-3 seconds
    const bridge = activeBridges.get(callSid);
    const hasPreloadedContext = !!bridge?.preloadedContext;
    
    logger.info('[VOICE_BRIDGE_OPTIMIZED] Sending initial greeting immediately', {
      callSid,
      hasInstructions: !!instructions,
      greetingLength: greetingMessage.length,
      hasAccountId: !!accountId,
      hasContactId: !!contactId,
      hasPreloadedContext,
      note: hasPreloadedContext
        ? '✅ Preload ready - will use cached context (fastest)'
        : '⚠️ Preload not ready - will load on-demand (still faster than waiting)',
    });
    
    // Send greeting immediately - don't wait for preload
    // The sendMessageToAgent function will use preloaded context if available,
    // or load on-demand if not ready yet (happens in parallel, doesn't block)
    sendTextToAgent(callSid, greetingMessage).catch((error: any) => {
      logger.error('[VOICE_BRIDGE_OPTIMIZED] Failed to send initial greeting to agent', { 
        callSid, 
        error: error.message,
        stack: error.stack,
        note: 'AI will not speak until caller says something first',
      });
    });
  } else {
    const missing = [];
    if (!ttsClient) missing.push('TTS client (ELEVENLABS_API_KEY)');
    if (!env.OPENAI_API_KEY) missing.push('OpenAI API key');
    logger.warn('[VOICE_BRIDGE_OPTIMIZED] Cannot send initial greeting - missing configuration', { 
      callSid,
      missing: missing.join(', '),
      note: 'AI will not speak until caller says something first',
    });
  }
}

/**
 * Handle inbound audio from Twilio Media Stream
 * Simplified flow: Send audio to STT → Get transcript → Send to OpenAI Chat API → Get response → TTS → Send audio back
 */
export async function handleInboundAudio(
  callSid: string,
  audioChunk: Buffer,
  timestamp: number
): Promise<void> {
  const bridge = activeBridges.get(callSid);
  if (!bridge) {
    // Bridge not ready yet - buffer the audio
    if (!pendingAudioBuffers.has(callSid)) {
      pendingAudioBuffers.set(callSid, []);
      logger.info('[VOICE_BRIDGE_OPTIMIZED] Bridge not ready, buffering audio chunks', {
        callSid,
        chunkSize: audioChunk.length,
        timestamp,
        note: 'Audio will be processed once bridge is ready',
      });
    }
    
    const buffer = pendingAudioBuffers.get(callSid)!;
    buffer.push({ chunk: audioChunk, timestamp });
    
    if (buffer.length % 10 === 0) {
      logger.debug('[VOICE_BRIDGE_OPTIMIZED] Buffering audio chunk (bridge not ready)', {
        callSid,
        bufferedChunks: buffer.length,
        chunkSize: audioChunk.length,
      });
    }
    
    return;
  }

  // CRITICAL: Don't send audio to STT while AI is speaking (per ElevenLabs docs)
  // This prevents echo from agent's voice being picked up by user's microphone
  // We allow interruption by resuming STT after a short delay (handled in sendAgentResponseAsAudio)
  if (bridge.isAISpeaking) {
    // Don't send to STT while AI is speaking - prevents echo
    // Audio will resume automatically when AI finishes (via ignoreTranscriptsUntil mechanism)
    return;
  }

  // Send audio to STT connection using official SDK
  if (bridge.sttConnection) {
    try {
      // Convert audio chunk to base64 and send using official SDK
      // Per docs: https://elevenlabs.io/docs/developers/guides/cookbooks/speech-to-text/realtime/server-side-streaming
      // Audio is μ-law 8kHz format from Twilio (matches connection config: AudioFormat.ULAW_8000, sampleRate: 8000)
      const audioBase64 = audioChunk.toString('base64');
      
      bridge.sttConnection.send({
        audioBase64,
        sampleRate: 8000, // Must match connection config (ULAW_8000 format)
      });
      
      bridge.lastSttTime = Date.now();
    } catch (error: any) {
      logger.error('[VOICE_BRIDGE_OPTIMIZED] STT connection error', {
        callSid,
        error: error.message,
      });
      
      // Last resort: buffer audio if STT fails
      bridge.audioBuffer.push(audioChunk);
      bridge.lastSttTime = Date.now();
    }
  } else {
    // STT not available - buffer audio as last resort
    bridge.audioBuffer.push(audioChunk);
    bridge.lastSttTime = Date.now();
    
    logger.warn('[VOICE_BRIDGE_OPTIMIZED] STT connection not available, buffering audio', {
      callSid,
      chunkSize: audioChunk.length,
      timestamp,
      bufferSize: bridge.audioBuffer.length,
    });
  }
}

/**
 * Handle STT transcription result
 * Simplified flow: Transcript → OpenAI Chat API → Response → ElevenLabs TTS → Audio to Twilio
 */
function handleSTTResult(callSid: string, result: STTResult): void {
  const bridge = activeBridges.get(callSid);
  if (!bridge) return;

  // Check if we should ignore transcripts (simulates clearing buffer)
  if (bridge.ignoreTranscriptsUntil && Date.now() < bridge.ignoreTranscriptsUntil) {
    logger.debug('[VOICE_BRIDGE_OPTIMIZED] Ignoring transcript - within ignore window', {
      callSid,
      text: result.text.substring(0, 50),
      ignoreUntil: bridge.ignoreTranscriptsUntil,
      currentTime: Date.now(),
    });
    return;
  }

  // Allow user to interrupt AI - process transcripts even when AI is speaking
  // But filter echo (very short fragments or known echo phrases within echo window)
  if (bridge.isAISpeaking) {
    // Check if this is likely user speech (not echo)
    const timeSinceAIStarted = bridge.aiSpeechStartTime 
      ? Date.now() - bridge.aiSpeechStartTime 
      : Infinity;
    
    // Allow interruption if:
    // 1. User has been speaking for a while (substantial text, not just echo)
    // 2. OR it's been more than 2 seconds since AI started (echo window passed)
    const isLikelyUserSpeech = result.isFinal && 
      result.text.trim().length > 10 && // Substantial text (not just "you" or "thank")
      (timeSinceAIStarted > 2000 || result.text.trim().length > 20); // Either time passed or substantial text
    
    if (!isLikelyUserSpeech) {
      logger.debug('[VOICE_BRIDGE_OPTIMIZED] Ignoring transcript - likely echo while AI speaking', {
        callSid,
        text: result.text.substring(0, 50),
        timeSinceAIStarted,
        note: 'Filtering echo - user can interrupt with longer speech',
      });
      return;
    }
    
    // User is interrupting - stop AI and process their input
    logger.info('[VOICE_BRIDGE_OPTIMIZED] 🛑 User interrupting AI', {
      callSid,
      text: result.text.substring(0, 100),
      timeSinceAIStarted,
      note: 'Processing user input immediately - stopping audio chunks',
    });
    
    // Stop sending audio chunks
    bridge.shouldStopAudio = true;
    bridge.isAISpeaking = false;
    bridge.aiSpeechEndTime = Date.now();
  }

  if (result.isFinal) {
    const finalText = result.text.trim();
    
    if (!finalText) {
      return; // Ignore empty transcripts
    }

    // FILTER: Ignore known system prompt phrases (AI's own voice being transcribed)
    // These phrases appear in the system prompt and get transcribed when AI speaks them
    // More specific matching - require longer phrase matches to avoid false positives
    const systemPromptPhrases = [
      'the caller may ask about campaigns, deals, or account information',
      'campaigns, deals, or account information, details, tell me more',
      'your name is alice',
      'you are alice',
      'customer service assistant for a crm platform',
      'you are a helpful customer service assistant',
    ];
    const normalizedTextForSystemPrompt = finalText.toLowerCase();
    // Require longer phrase matches (at least 30 characters) to avoid false positives
    // Also check for repeated patterns (system prompt gets transcribed multiple times)
    const hasRepeatedPattern = (finalText.match(/campaigns, deals, or account information/g) || []).length > 1;
    const isSystemPromptPhrase = (finalText.length > 30 || hasRepeatedPattern) && systemPromptPhrases.some(phrase => 
      normalizedTextForSystemPrompt.includes(phrase.toLowerCase())
    );
    
    if (isSystemPromptPhrase) {
      logger.debug('[VOICE_BRIDGE_OPTIMIZED] Ignoring system prompt phrase (AI echo)', {
        callSid,
        text: finalText,
        note: 'This is from the system prompt - AI is speaking its own instructions',
      });
      return;
    }

    const now = Date.now();
    
    // Add cooldown: don't process new transcripts within 500ms of last one (75% reduction)
    // This prevents rapid duplicate processing of the same audio
    // Note: Still has 10-second duplicate text check as backup safety net
    const timeSinceLastProcess = bridge.lastTranscriptProcessedTime 
      ? now - bridge.lastTranscriptProcessedTime 
      : Infinity;
    
    if (timeSinceLastProcess < 500) {
      logger.debug('[VOICE_BRIDGE_OPTIMIZED] Ignoring transcript - too soon after last one', {
        callSid,
        text: finalText.substring(0, 50),
        timeSinceLastProcess,
        note: 'Cooldown period - prevent rapid duplicate processing',
      });
      return;
    }

    // NOTE: For optimized version using ElevenLabs STT with VAD (Voice Activity Detection),
    // echo suppression is handled by ElevenLabs. We trust their VAD to filter echoes.
    // Removed aggressive echo filtering - ElevenLabs STT should handle this better.
    
    // Only keep minimal filtering for obvious duplicates (same text within 1 second)
    if (bridge.lastTranscriptText === finalText && bridge.lastTranscriptTime) {
      const timeSinceLastTranscript = now - bridge.lastTranscriptTime;
      if (timeSinceLastTranscript < 1000) {
        logger.debug('[VOICE_BRIDGE_OPTIMIZED] Ignoring duplicate transcript', {
          callSid,
          text: finalText,
          timeSinceLastTranscript,
          note: 'Same transcript received within 1 second - likely duplicate',
        });
        return;
      }
    }
    
    // Update last transcript tracking
    bridge.lastTranscriptText = finalText;
    bridge.lastTranscriptTime = now;
    
    // Continue processing - trust ElevenLabs VAD for echo suppression
    logger.debug('[VOICE_BRIDGE_OPTIMIZED] Processing transcript (ElevenLabs VAD handles echo)', {
      callSid,
      text: finalText.substring(0, 50),
      isFinal: result.isFinal,
      note: 'Trusting ElevenLabs VAD for echo suppression',
    });
    
    // Process legitimate transcripts (including interruptions)
    // Allow processing even if waiting for response (user can interrupt)
    if (finalText) { // Removed !bridge.isWaitingForResponse check to allow interruption
      logger.info('[VOICE_BRIDGE_OPTIMIZED] 📝 Transcript:', {
        callSid,
        text: finalText,
        note: 'Processing transcript - ElevenLabs VAD handles echo suppression',
      });
      bridge.lastTranscriptProcessedTime = now; // Track when we processed this transcript (for cooldown)
      
      bridge.pendingTranscript = '';
      bridge.isWaitingForResponse = true;
      
      // If AI was speaking, stop it
      if (bridge.isAISpeaking) {
        bridge.shouldStopAudio = true;
        bridge.isAISpeaking = false;
        bridge.aiSpeechEndTime = Date.now();
        logger.info('[VOICE_BRIDGE_OPTIMIZED] 🛑 Stopped AI - user interrupted', { callSid });
      }
      
      sendTextToAgent(callSid, finalText);
    }
    // Silently ignore if empty or already waiting for response
  } else {
    // Interim result - accumulate for potential early sending
    // Only accumulate if AI is not speaking
    if (!bridge.isAISpeaking) {
      bridge.pendingTranscript = result.text.trim();
      
      if (bridge.transcriptTimeout) {
        clearTimeout(bridge.transcriptTimeout);
      }
      
      // Send interim if substantial and no response pending
      // Only send if it looks like a complete sentence (has punctuation)
      const hasPunctuation = /[.!?]$/.test(bridge.pendingTranscript);
      const isSubstantial = bridge.pendingTranscript.length > 15;
      
      if ((isSubstantial || hasPunctuation) && !bridge.isWaitingForResponse) {
        bridge.transcriptTimeout = setTimeout(() => {
          if (bridge.pendingTranscript && !bridge.isWaitingForResponse && !bridge.isAISpeaking) {
            logger.info('[VOICE_BRIDGE_OPTIMIZED] 📝 Sending interim transcript:', {
              callSid,
              text: bridge.pendingTranscript,
            });
            bridge.isWaitingForResponse = true;
            bridge.lastTranscriptText = bridge.pendingTranscript;
            bridge.lastTranscriptTime = Date.now();
            sendTextToAgent(callSid, bridge.pendingTranscript);
            bridge.pendingTranscript = '';
          }
        }, 300); // Reduced from 1000ms to 300ms (70% reduction for 50% latency cut)
      }
    }
  }
}


// Old WebSocket-based agent connection removed - now using OpenAI Chat API via agentService

/**
 * Send text to OpenAI Chat API via unified agent service
 * Then convert response to audio using ElevenLabs TTS
 */
async function sendTextToAgent(callSid: string, text: string): Promise<void> {
  const bridge = activeBridges.get(callSid);
  if (!bridge) {
    logger.warn('[VOICE_BRIDGE_OPTIMIZED] Cannot send text - bridge not available', { callSid });
    return;
  }

  if (!text.trim()) {
    bridge.isWaitingForResponse = false;
    return;
  }

  try {
    // CRITICAL: Ignore transcripts temporarily BEFORE getting AI response to prevent processing stale audio
    // This prevents echo fragments from being transcribed from audio buffered before AI spoke
    // Official SDK doesn't have a clear() method, so we use timestamp-based filtering
    if (bridge.sttConnection) {
      bridge.ignoreTranscriptsUntil = Date.now() + 500; // Ignore transcripts for 500ms
      logger.debug('[VOICE_BRIDGE_OPTIMIZED] Ignoring transcripts temporarily - preparing for AI response', { callSid });
    }

    // Check if we have preloaded context (for faster response)
    const hasPreloadedContext = !!bridge.preloadedContext;
    const contextAge = bridge.preloadedContext 
      ? Date.now() - bridge.preloadedContext.loadedAt 
      : 0;
    
    logger.info('[VOICE_BRIDGE_OPTIMIZED] 📤 Sending to AI', {
      callSid,
      text: text.substring(0, 150),
      textLength: text.length,
      hasAccountId: !!bridge.accountId,
      hasContactId: !!bridge.contactId,
      hasPreloadedContext,
      contextAgeMs: contextAge,
      note: hasPreloadedContext
        ? `✅ Using preloaded context (${contextAge}ms old) - faster response expected`
        : bridge.accountId && bridge.contactId
        ? '⚠️ No preloaded context - loading on-demand (slower)'
        : '❌ No accountId - agent will NOT have CRM context (generic responses only)',
    });

    // Use unified agent service (OpenAI Chat API)
    // Pass accountId and contactId to get CRM context (same as SMS/Email)
    // Pass campaign instructions for ongoing conversation context
    // Pass preloaded context if available (reduces latency significantly)
    const response = await sendMessageToAgent(
      bridge.agentId,
      text,
      undefined,
      bridge.contactId,
      bridge.accountId,
      3,
      bridge.instructions, // Pass campaign instructions for all messages
      bridge.preloadedContext // Pass preloaded context if available
    );

    // CRITICAL: Ignore transcripts temporarily before starting TTS (extra safety)
    // This ensures no audio is processed while AI is generating response
    // Official SDK doesn't have a clear() method, so we use timestamp-based filtering
    if (bridge.sttConnection) {
      bridge.ignoreTranscriptsUntil = Date.now() + 500; // Ignore transcripts for 500ms
      logger.debug('[VOICE_BRIDGE_OPTIMIZED] Ignoring transcripts temporarily - before TTS', { callSid });
    }

    // DON'T reset isWaitingForResponse here - let sendAgentResponseAsAudio handle it after audio finishes
    // This prevents new transcripts from being processed while AI is speaking

    if (response.success && response.response) {
      logger.info('[VOICE_BRIDGE_OPTIMIZED] ✅ AI response received', {
        callSid,
        responseLength: response.response.length,
        responsePreview: response.response.substring(0, 150),
      });
      
      // Store AI response in conversation
      if (bridge.contactId && bridge.accountId) {
        try {
          // Ensure conversation exists
          if (!bridge.conversationId) {
            const conversation = await upsertConversation(
              bridge.contactId,
              bridge.accountId,
              'call',
              undefined,
              undefined
            );
            bridge.conversationId = conversation._id.toString();
          }
          
          // Add assistant message to conversation
          if (bridge.conversationId) {
            await addMessageToConversation(
              bridge.conversationId,
              'assistant',
              response.response,
              {
                message_id: callSid,
                // tokens_used not available in AgentResponse, but can be enhanced later
              }
            );
          }
        } catch (error: any) {
          logger.error('[VOICE_BRIDGE_OPTIMIZED] Failed to store AI response', error, {
            callSid,
            note: 'Call continues despite conversation storage failure',
          });
        }
      }
      
      await sendAgentResponseAsAudio(callSid, response.response);
      // Don't reset isWaitingForResponse here - let sendAgentResponseAsAudio handle it
    } else {
      bridge.isWaitingForResponse = false; // Only reset on error (no audio will be played)
      logger.error('[VOICE_BRIDGE_OPTIMIZED] ❌ AI response failed', {
        callSid,
        error: response.error,
      });
    }
  } catch (error: any) {
    bridge.isWaitingForResponse = false; // Only reset on exception (no audio will be played)
    logger.error('[VOICE_BRIDGE_OPTIMIZED] ❌ Exception sending to AI', {
      callSid,
      error: error.message,
    });
  }
}

/**
 * Convert agent text response to audio and send to caller
 * OPTIMIZED VERSION: Trusts ulaw_8000 output and streams chunks immediately
 */
async function sendAgentResponseAsAudio(callSid: string, text: string): Promise<void> {
  const bridge = activeBridges.get(callSid);
  if (!bridge || !bridge.ttsClient) {
    logger.error('[VOICE_BRIDGE_OPTIMIZED] TTS client not available', { 
      callSid,
      hasBridge: !!bridge,
      hasTtsClient: !!(bridge && bridge.ttsClient),
    });
    return;
  }

  if (!text || !text.trim()) {
    logger.warn('[VOICE_BRIDGE_OPTIMIZED] Cannot convert empty text to audio', { callSid });
    return;
  }

  try {
    logger.info('[VOICE_BRIDGE_OPTIMIZED] Converting text to audio via ElevenLabs TTS (optimized)', {
      callSid,
      textLength: text.length,
      textPreview: text.substring(0, 50) + '...',
      voiceId: bridge.voiceId,
      hasTtsClient: !!bridge.ttsClient,
      note: 'OPTIMIZED: Trusting ulaw_8000 output and streaming chunks immediately',
    });

    // Use ElevenLabs streaming TTS with ulaw_8000 output format
    // Based on ElevenLabs Twilio integration guide: https://elevenlabs.io/docs/developers/guides/cookbooks/text-to-speech/twilio
    let response;
    try {
      // Use camelCase format as shown in ElevenLabs docs
      response = await bridge.ttsClient.textToSpeech.convert(bridge.voiceId, {
        text,
        modelId: 'eleven_flash_v2_5', // camelCase as per ElevenLabs Twilio guide
        outputFormat: 'ulaw_8000', // camelCase - Direct μ-law 8kHz output
      });
    } catch (error: any) {
      // If camelCase fails, try snake_case (SDK might accept both)
      logger.warn('[VOICE_BRIDGE_OPTIMIZED] camelCase format failed, trying snake_case', {
        callSid,
        error: error.message,
      });
      try {
        response = await bridge.ttsClient.textToSpeech.convert(bridge.voiceId, {
          text,
          modelId: 'eleven_flash_v2_5',
          outputFormat: 'ulaw_8000',
        });
      } catch (error2: any) {
        logger.error('[VOICE_BRIDGE_OPTIMIZED] Failed to convert text to audio with ulaw_8000 format', {
          callSid,
          camelCaseError: error.message,
          snakeCaseError: error2.message,
          note: 'Both formats failed - check SDK version',
        });
        throw error2; // Re-throw the last error
      }
    }

    // Convert response to Readable stream (as per ElevenLabs Twilio guide)
    const readableStream = Readable.from(response);

    // Helper function to collect all chunks (exactly as per ElevenLabs sample)
    const streamToArrayBuffer = (readableStream: Readable): Promise<ArrayBuffer> => {
      return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];

        readableStream.on('data', (chunk: Buffer) => {
          chunks.push(chunk);
        });

        readableStream.on('end', () => {
          resolve(Buffer.concat(chunks).buffer);
        });

        readableStream.on('error', reject);
      });
    };

    // Mark AI as speaking - suppress STT during this time to prevent echo
    bridge.isAISpeaking = true;
    bridge.aiSpeechStartTime = Date.now();
    
    // CRITICAL: Ignore transcripts temporarily when AI starts speaking to prevent processing stale audio
    // Official SDK doesn't have a clear() method, so we use timestamp-based filtering
    if (bridge.sttConnection) {
      bridge.ignoreTranscriptsUntil = Date.now() + 500; // Ignore transcripts for 500ms
      logger.debug('[VOICE_BRIDGE_OPTIMIZED] Ignoring transcripts temporarily - AI is speaking', { callSid });
    }
    
    // CRITICAL FIXES: Prevent looping by clearing pending transcripts
    bridge.pendingTranscript = '';
    if (bridge.transcriptTimeout) {
      clearTimeout(bridge.transcriptTimeout);
      bridge.transcriptTimeout = undefined;
    }
    bridge.isWaitingForResponse = true;
    
    logger.info('[VOICE_BRIDGE_OPTIMIZED] 🎤 Collecting all audio chunks (as per ElevenLabs sample)', {
      callSid,
      note: 'Following ElevenLabs sample exactly - collecting all chunks before sending',
    });

    // Collect all chunks first (exactly as per ElevenLabs sample)
    const audioArrayBuffer = await streamToArrayBuffer(readableStream);
    
    // Convert to Buffer and send all at once (exactly as per ElevenLabs sample)
    // Official @elevenlabs/elevenlabs-js package correctly handles ulaw_8000 output format
    const completeAudioBuffer = Buffer.from(audioArrayBuffer as any);
    
    logger.info('[VOICE_BRIDGE_OPTIMIZED] ✅ Collected all audio chunks', {
      callSid,
      totalBytes: completeAudioBuffer.length,
      estimatedDurationSeconds: (completeAudioBuffer.length / 8000).toFixed(1),
      note: 'Official @elevenlabs/elevenlabs-js package - ulaw_8000 format should be correct',
    });

    // Send all audio at once (exactly as per ElevenLabs sample pattern)
    // Note: sendAudioToStream already handles base64 encoding and Twilio message format
    const success = sendAudioToStream(callSid, completeAudioBuffer);
    
    if (!success) {
      logger.error('[VOICE_BRIDGE_OPTIMIZED] Failed to send audio', {
        callSid,
        totalBytes: completeAudioBuffer.length,
      });
      bridge.isAISpeaking = false;
      bridge.isWaitingForResponse = false;
      return;
    }

    const totalBytesSent = completeAudioBuffer.length;
    const actualDurationMs = Math.round((totalBytesSent / 8000) * 1000);
    
    logger.info('[VOICE_BRIDGE_OPTIMIZED] ✅ Audio sent (as per ElevenLabs sample)', {
      callSid,
      totalBytes: totalBytesSent,
      estimatedDurationSeconds: (actualDurationMs / 1000).toFixed(1),
      note: 'Following ElevenLabs sample exactly - collected all chunks before sending',
    });
    
    // Schedule STT to resume after AI finishes speaking
    const dynamicBufferMs = actualDurationMs < 3000 
      ? Math.max(500, Math.round(actualDurationMs * 0.3))
      : actualDurationMs < 10000
      ? Math.max(1000, Math.round(actualDurationMs * 0.15))
      : 2000;
    const networkProcessingBufferMs = 200;
    const totalWaitTimeMs = actualDurationMs + dynamicBufferMs + networkProcessingBufferMs;
    
    setTimeout(() => {
      if (activeBridges.has(callSid)) {
        const currentBridge = activeBridges.get(callSid);
        if (currentBridge && currentBridge.isAISpeaking && !currentBridge.shouldStopAudio) {
          currentBridge.isAISpeaking = false;
          currentBridge.aiSpeechEndTime = Date.now();
          
          // CRITICAL: Ignore transcripts temporarily when AI finishes speaking
          // Official SDK doesn't have a clear() method, so we use timestamp-based filtering
          if (currentBridge.sttConnection) {
            currentBridge.ignoreTranscriptsUntil = Date.now() + 500; // Ignore transcripts for 500ms
            logger.debug('[VOICE_BRIDGE_OPTIMIZED] Ignoring transcripts temporarily - AI finished speaking', { callSid });
          }
          
          // Immediately allow processing new transcripts (echo filtering will handle false positives)
          const postSpeechDelayMs = 500;
          currentBridge.isWaitingForResponse = false;
          
          setTimeout(() => {
            if (activeBridges.has(callSid)) {
              const finalBridge = activeBridges.get(callSid);
              if (finalBridge) {
                logger.debug('[VOICE_BRIDGE_OPTIMIZED] Ready for user input', {
                  callSid,
                  timeSinceAIFinished: Date.now() - (finalBridge.aiSpeechEndTime || 0),
                  note: 'isWaitingForResponse is false - STT will process user input',
                });
              }
            }
          }, postSpeechDelayMs);
          
          logger.info('[VOICE_BRIDGE_OPTIMIZED] ✅ AI finished speaking - ready for input', {
            callSid,
            estimatedDurationMs: actualDurationMs,
            totalWaitTimeMs,
            wasInterrupted: currentBridge.shouldStopAudio || false,
          });
        }
      }
    }, totalWaitTimeMs);
  } catch (error: any) {
    logger.error('[VOICE_BRIDGE_OPTIMIZED] ❌ Exception while converting text to audio', {
      callSid,
      error: error.message,
      stack: error.stack,
      errorType: error.constructor.name,
      textLength: text.length,
      textPreview: text.substring(0, 50),
      hasTtsClient: !!(bridge && bridge.ttsClient),
      voiceId: bridge?.voiceId,
      note: 'Check ElevenLabs API key, voice ID, network connectivity, and SDK version',
    });
    // Reset AI speaking flag on error
    if (bridge) {
      bridge.isAISpeaking = false;
    }
  }
}

/**
 * Stop voice call bridge
 */
export function stopVoiceCallBridge(callSid: string): void {
  const bridge = activeBridges.get(callSid);
  if (!bridge) {
    return;
  }

  logger.info('[VOICE_BRIDGE_OPTIMIZED] Stopping bridge', { callSid });

  // Close STT connection using official SDK
  if (bridge.sttConnection) {
    try {
      // Send final commit before closing
      bridge.sttConnection.commit();
      bridge.sttConnection.close();
      logger.info('[VOICE_BRIDGE_OPTIMIZED] ElevenLabs STT connection closed', {
        callSid,
      });
    } catch (error: any) {
      logger.error('[VOICE_BRIDGE_OPTIMIZED] Error closing STT connection', {
        callSid,
        error: error.message,
      });
    }
  }

  // Clear transcript timeout
  if (bridge.transcriptTimeout) {
    clearTimeout(bridge.transcriptTimeout);
  }

  // Remove from active bridges
  activeBridges.delete(callSid);
}

/**
 * Preload CRM context for a call to reduce latency
 * Loads system prompt and conversation history in advance
 */
async function preloadContextForCall(
  accountId: string,
  contactId: string,
  campaignInstructions?: string
): Promise<PreloadedContext> {
  const loadStartTime = Date.now();
  
  try {
    // Load system prompt and conversation history in parallel
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
    logger.error('[VOICE_BRIDGE_OPTIMIZED] Error preloading context', {
      error: error.message,
      accountId,
      contactId,
    });
    // Return empty context on error - will load on-demand
    return {
      systemPrompt: '',
      conversationHistory: [],
      loadedAt: loadStartTime,
    };
  }
}

/**
 * Export function to preload context before call (called from campaignQueue)
 * This starts preloading while Twilio call is connecting, reducing latency
 */
export async function preloadContextBeforeCall(
  accountId: string,
  contactId: string,
  instructions?: string
): Promise<void> {
  const cacheKey = getPreloadCacheKey(contactId, accountId);
  
  // Don't preload if already cached
  if (preloadedContextCache.has(cacheKey)) {
    logger.debug('[VOICE_BRIDGE_OPTIMIZED] Context already preloaded', {
      contactId,
      accountId,
      cacheKey,
    });
    return;
  }

  logger.info('[VOICE_BRIDGE_OPTIMIZED] Starting preload before call', {
    contactId,
    accountId,
    hasInstructions: !!instructions,
    note: 'Preloading context while Twilio call is connecting - reduces latency',
  });

  // Start preloading (don't await - let it run in background)
  preloadContextForCall(accountId, contactId, instructions)
    .then((context) => {
      preloadedContextCache.set(cacheKey, context);
      logger.info('[VOICE_BRIDGE_OPTIMIZED] Context preloaded before call', {
        contactId,
        accountId,
        hasSystemPrompt: !!context.systemPrompt,
        historyLength: context.conversationHistory.length,
        loadTimeMs: Date.now() - context.loadedAt,
        note: 'Context ready - will be used when bridge connects',
      });
    })
    .catch((error: any) => {
      logger.warn('[VOICE_BRIDGE_OPTIMIZED] Failed to preload context before call', {
        contactId,
        accountId,
        error: error.message,
        note: 'Will fallback to on-demand loading',
      });
    });
}

/**
 * Get active bridge
 */
export function getActiveBridge(callSid: string): VoiceCallBridge | undefined {
  return activeBridges.get(callSid);
}

/**
 * Get all active bridges (for monitoring)
 */
export function getAllActiveBridges(): VoiceCallBridge[] {
  return Array.from(activeBridges.values());
}
