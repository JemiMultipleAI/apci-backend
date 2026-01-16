import { logger } from '../utils/logger';
import { env } from '../config/env';
import { sendAudioToStream, MediaStreamConnection } from './twilioMediaStreams';
import { createSTTStream, STTStream, STTResult } from './speechToText';
import { sendMessageToAgent } from './agentService'; // Use unified agent service (OpenAI Chat API)
import { upsertConversation, addMessageToConversation } from './conversationService';
import { buildSystemPrompt, getConversationHistory } from './openaiAgent';
import { ElevenLabsClient } from '@elevenlabs/elevenlabs-js';

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
  ttsClient?: any;
  voiceId: string;
  sttStream?: STTStream;
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

  logger.info('[VOICE_BRIDGE] Starting simplified bridge (OpenAI STT → OpenAI Chat → ElevenLabs TTS)', {
    callSid,
    agentId: agentId.substring(0, 8) + '...',
    contactId,
    accountId: accountId || 'MISSING',
    hasAccountId: !!accountId,
    hasContactId: !!contactId,
    sttProvider: env.STT_PROVIDER || 'openai',
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
      logger.info('[VOICE_BRIDGE] ElevenLabs TTS client initialized', { callSid });
    } catch (error: any) {
      logger.error('[VOICE_BRIDGE] Failed to initialize TTS client', {
        callSid,
        error: error.message,
      });
    }
  } else {
    logger.warn('[VOICE_BRIDGE] ELEVENLABS_API_KEY not configured - TTS will not work', { callSid });
  }

  // Create STT stream for real-time transcription (OpenAI Whisper by default)
  const sttStream = createSTTStream((result: STTResult) => {
    handleSTTResult(callSid, result);
  });

  if (!sttStream) {
    logger.warn('[VOICE_BRIDGE] STT stream not available - audio will not be transcribed', {
      callSid,
      sttProvider: env.STT_PROVIDER || 'openai',
      hasOpenAIKey: !!env.OPENAI_API_KEY,
    });
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
    sttStream: sttStream || undefined,
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
    logger.info('[VOICE_BRIDGE] Using preloaded context from cache', {
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
          logger.info('[VOICE_BRIDGE] Context preloaded successfully', {
            callSid,
            hasSystemPrompt: !!context.systemPrompt,
            historyLength: context.conversationHistory.length,
            loadTimeMs: Date.now() - context.loadedAt,
            note: 'First AI response will be faster - no database queries needed',
          });
        }
      }
    }).catch((error: any) => {
      logger.warn('[VOICE_BRIDGE] Failed to preload context', {
        callSid,
        error: error.message,
        note: 'Will load on-demand (slower)',
      });
    });
  } else {
    logger.debug('[VOICE_BRIDGE] Skipping context preload - missing accountId or contactId', {
      callSid,
      hasAccountId: !!accountId,
      hasContactId: !!contactId,
    });
  }

  // Flush any buffered audio chunks that arrived before bridge was ready
  const bufferedChunks = pendingAudioBuffers.get(callSid);
  if (bufferedChunks && bufferedChunks.length > 0) {
    logger.info('[VOICE_BRIDGE] Flushing buffered audio chunks', {
      callSid,
      bufferedChunkCount: bufferedChunks.length,
      note: 'Processing audio that arrived before bridge was ready',
    });
    
    for (const { chunk, timestamp } of bufferedChunks) {
      await handleInboundAudio(callSid, chunk, timestamp);
    }
    
    pendingAudioBuffers.delete(callSid);
    
    logger.info('[VOICE_BRIDGE] Finished flushing buffered audio chunks', {
      callSid,
      processedChunks: bufferedChunks.length,
    });
  }

  logger.info('[VOICE_BRIDGE] Bridge started successfully', {
    callSid,
    hasSttStream: !!sttStream,
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
    
    logger.info('[VOICE_BRIDGE] Sending initial greeting immediately', {
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
      logger.error('[VOICE_BRIDGE] Failed to send initial greeting to agent', { 
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
    logger.warn('[VOICE_BRIDGE] Cannot send initial greeting - missing configuration', { 
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
      logger.info('[VOICE_BRIDGE] Bridge not ready, buffering audio chunks', {
        callSid,
        chunkSize: audioChunk.length,
        timestamp,
        note: 'Audio will be processed once bridge is ready',
      });
    }
    
    const buffer = pendingAudioBuffers.get(callSid)!;
    buffer.push({ chunk: audioChunk, timestamp });
    
    if (buffer.length % 10 === 0) {
      logger.debug('[VOICE_BRIDGE] Buffering audio chunk (bridge not ready)', {
        callSid,
        bufferedChunks: buffer.length,
        chunkSize: audioChunk.length,
      });
    }
    
    return;
  }

  // Don't block audio from STT - allow interruption detection
  // Echo filtering happens in handleSTTResult based on timing
  // We need to keep audio flowing to STT so user can interrupt
  // Note: Audio will be filtered in handleSTTResult if it's echo

  // Send audio to STT stream
  if (bridge.sttStream) {
    try {
      bridge.sttStream.write(audioChunk);
      bridge.lastSttTime = Date.now();
    } catch (error: any) {
      logger.error('[VOICE_BRIDGE] STT stream error', {
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
    
    logger.warn('[VOICE_BRIDGE] STT stream not available, buffering audio', {
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
      logger.debug('[VOICE_BRIDGE] Ignoring transcript - likely echo while AI speaking', {
        callSid,
        text: result.text.substring(0, 50),
        timeSinceAIStarted,
        note: 'Filtering echo - user can interrupt with longer speech',
      });
      return;
    }
    
    // User is interrupting - stop AI and process their input
    logger.info('[VOICE_BRIDGE] 🛑 User interrupting AI', {
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
      logger.debug('[VOICE_BRIDGE] Ignoring system prompt phrase (AI echo)', {
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
      logger.debug('[VOICE_BRIDGE] Ignoring transcript - too soon after last one', {
        callSid,
        text: finalText.substring(0, 50),
        timeSinceLastProcess,
        note: 'Cooldown period - prevent rapid duplicate processing',
      });
      return;
    }

    // Duplicate transcript detection: ignore if same transcript within 10 seconds (increased from 5s)
    // This catches repeated echo like "Thank you." appearing multiple times after AI responses
    if (bridge.lastTranscriptText === finalText && 
        bridge.lastTranscriptTime && 
        (now - bridge.lastTranscriptTime) < 10000) {
      logger.debug('[VOICE_BRIDGE] Ignoring duplicate transcript', {
        callSid,
        text: finalText,
        timeSinceLastTranscript: now - (bridge.lastTranscriptTime || 0),
        note: 'Same transcript received within 10 seconds - likely duplicate/echo',
      });
      return;
    }

    // Enhanced echo filtering: check time since AI finished speaking
    const timeSinceAIFinished = bridge.aiSpeechEndTime 
      ? now - bridge.aiSpeechEndTime 
      : Infinity;
    
    // If AI is still speaking (isAISpeaking = true), allow interruption
    // Don't filter as echo if user is actively interrupting with substantial text
    const isUserInterrupting = bridge.isAISpeaking && finalText.trim().length > 10;
    
    // List of common echo phrases that match AI responses
    // When AI says "You're welcome!", echo often becomes "Thank you." or "you"
    // These are legitimate user responses but become echo when transcribed too quickly after AI speech
    // Note: Removed 'hello' and 'hi' - these are legitimate user greetings, not echo
    const echoPhrases = ['thank you', 'thank you.', 'thanks', 'thanks.', 'welcome'];
    const singleWordEchoPhrases = ['you', 'wel', 'come', 'than', 'thank']; // Very short fragments only
    const normalizedTextForEcho = finalText.toLowerCase().trim();
    
    // For phrases: exact match or starts/ends with phrase
    const matchesPhrase = echoPhrases.some(phrase => 
      normalizedTextForEcho === phrase || 
      normalizedTextForEcho.startsWith(phrase + ' ') ||
      normalizedTextForEcho.endsWith(' ' + phrase) ||
      normalizedTextForEcho.includes(' ' + phrase + ' ')
    );
    
    // For single words: only match if text is very short (likely echo fragment)
    // Don't match "you" in "Yeah, you can tell me more" - that's legitimate speech
    const matchesSingleWord = finalText.trim().length <= 10 && singleWordEchoPhrases.some(phrase => {
      // Use word boundaries - match standalone word only
      const wordBoundaryRegex = new RegExp(`\\b${phrase}\\b`, 'i');
      return wordBoundaryRegex.test(normalizedTextForEcho);
    });
    
    const isEchoPhrase = matchesPhrase || matchesSingleWord;
    
    // Extended echo window for specific phrases (like "thank you" after "you're welcome")
    // These phrases can appear as echo even 15-20 seconds after AI speaks due to buffering/delays
    // Use longer window for echo phrases (20 seconds) vs normal phrases (3 seconds)
    const echoWindowMs = isEchoPhrase ? 20000 : 3000; // 20 seconds for echo phrases, 3 seconds for others
    const isWithinEchoWindow = timeSinceAIFinished < echoWindowMs;
    
    // Don't filter if user is actively interrupting (substantial text while AI is speaking)
    if (isUserInterrupting) {
      logger.info('[VOICE_BRIDGE] User interrupting - allowing through', {
        callSid,
        text: finalText.substring(0, 50),
        note: 'User is interrupting AI - not filtering as echo',
      });
      // Continue to process - don't return here
    } else if (isWithinEchoWindow && isEchoPhrase) {
      // Only filter echo phrases if NOT interrupting
      // Also don't filter if text is substantial (longer sentences are legitimate)
      const isSubstantialText = finalText.trim().length > 15;
      
      if (isSubstantialText) {
        logger.debug('[VOICE_BRIDGE] Allowing substantial text despite echo phrase match', {
          callSid,
          text: finalText.substring(0, 50),
          length: finalText.length,
          note: 'Text is substantial - likely legitimate user input, not echo',
        });
        // Continue to process - don't filter substantial text
      } else {
        logger.debug('[VOICE_BRIDGE] Ignoring likely echo phrase', {
          callSid,
          text: finalText,
          timeSinceAIFinished,
          echoWindowMs,
          note: `Phrase matches common echo pattern within ${echoWindowMs}ms of AI response - likely echo`,
        });
        return;
      }
    }
    
    // Also filter very short fragments within echo window (existing logic, but with extended window)
    const isVeryShortFragment = finalText.length < 5 && finalText.length > 0;
    if (isVeryShortFragment && isWithinEchoWindow) {
      logger.debug('[VOICE_BRIDGE] Ignoring likely echo fragment', {
        callSid,
        text: finalText,
        timeSinceAIFinished,
        note: 'Very short fragment within 3 seconds of AI response - likely echo',
      });
      return;
    }
    
    // Process legitimate transcripts (including interruptions)
    // Allow processing even if waiting for response (user can interrupt)
    if (finalText) { // Removed !bridge.isWaitingForResponse check to allow interruption
      logger.info('[VOICE_BRIDGE] 📝 Transcript:', {
        callSid,
        text: finalText,
        timeSinceAIFinished: timeSinceAIFinished !== Infinity ? timeSinceAIFinished : 'N/A',
        note: timeSinceAIFinished !== Infinity && timeSinceAIFinished < 3000 
          ? 'Within echo window but passed filters - likely legitimate' 
          : 'Outside echo window - definitely legitimate',
      });
      
      // Update last transcript tracking
      bridge.lastTranscriptText = finalText;
      bridge.lastTranscriptTime = now;
      bridge.lastTranscriptProcessedTime = now; // Track when we processed this transcript (for cooldown)
      
      bridge.pendingTranscript = '';
      bridge.isWaitingForResponse = true;
      
      // If AI was speaking, stop it
      if (bridge.isAISpeaking) {
        bridge.shouldStopAudio = true;
        bridge.isAISpeaking = false;
        bridge.aiSpeechEndTime = Date.now();
        logger.info('[VOICE_BRIDGE] 🛑 Stopped AI - user interrupted', { callSid });
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
            logger.info('[VOICE_BRIDGE] 📝 Sending interim transcript:', {
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
    logger.warn('[VOICE_BRIDGE] Cannot send text - bridge not available', { callSid });
    return;
  }

  if (!text.trim()) {
    bridge.isWaitingForResponse = false;
    return;
  }

  try {
    // CRITICAL: Clear STT buffer BEFORE getting AI response to prevent processing stale audio
    // This prevents echo fragments from being transcribed from audio buffered before AI spoke
    if (bridge.sttStream && typeof bridge.sttStream.clear === 'function') {
      bridge.sttStream.clear();
      logger.debug('[VOICE_BRIDGE] Cleared STT buffer - preparing for AI response', { callSid });
    }

    // Check if we have preloaded context (for faster response)
    const hasPreloadedContext = !!bridge.preloadedContext;
    const contextAge = bridge.preloadedContext 
      ? Date.now() - bridge.preloadedContext.loadedAt 
      : 0;
    
    logger.info('[VOICE_BRIDGE] 📤 Sending to AI', {
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

    // CRITICAL: Clear STT buffer again before starting TTS (extra safety)
    // This ensures no audio is processed while AI is generating response
    if (bridge.sttStream && typeof bridge.sttStream.clear === 'function') {
      bridge.sttStream.clear();
      logger.debug('[VOICE_BRIDGE] Cleared STT buffer again - before TTS', { callSid });
    }

    // DON'T reset isWaitingForResponse here - let sendAgentResponseAsAudio handle it after audio finishes
    // This prevents new transcripts from being processed while AI is speaking

    if (response.success && response.response) {
      logger.info('[VOICE_BRIDGE] ✅ AI response received', {
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
          logger.error('[VOICE_BRIDGE] Failed to store AI response', error, {
            callSid,
            note: 'Call continues despite conversation storage failure',
          });
        }
      }
      
      await sendAgentResponseAsAudio(callSid, response.response);
      // Don't reset isWaitingForResponse here - let sendAgentResponseAsAudio handle it
    } else {
      bridge.isWaitingForResponse = false; // Only reset on error (no audio will be played)
      logger.error('[VOICE_BRIDGE] ❌ AI response failed', {
        callSid,
        error: response.error,
      });
    }
  } catch (error: any) {
    bridge.isWaitingForResponse = false; // Only reset on exception (no audio will be played)
    logger.error('[VOICE_BRIDGE] ❌ Exception sending to AI', {
      callSid,
      error: error.message,
    });
  }
}

/**
 * Convert agent text response to audio and send to caller
 */
async function sendAgentResponseAsAudio(callSid: string, text: string): Promise<void> {
  const bridge = activeBridges.get(callSid);
  if (!bridge || !bridge.ttsClient) {
    logger.error('[VOICE_BRIDGE] TTS client not available', { 
      callSid,
      hasBridge: !!bridge,
      hasTtsClient: !!(bridge && bridge.ttsClient),
    });
    return;
  }

  if (!text || !text.trim()) {
    logger.warn('[VOICE_BRIDGE] Cannot convert empty text to audio', { callSid });
    return;
  }

  try {
    logger.info('[VOICE_BRIDGE] Converting text to audio via ElevenLabs TTS', {
      callSid,
      textLength: text.length,
      textPreview: text.substring(0, 50) + '...',
      voiceId: bridge.voiceId,
      hasTtsClient: !!bridge.ttsClient,
    });

    // Use ElevenLabs streaming TTS with ulaw_8000 output format (direct μ-law 8kHz - no conversion needed!)
    // Based on ElevenLabs Twilio integration guide: https://elevenlabs.io/docs/developers/guides/cookbooks/text-to-speech/twilio
    // Using exact format from docs: camelCase parameters and send all audio at once
    let audioStream;
    try {
      // Try camelCase format as shown in ElevenLabs docs
      audioStream = await bridge.ttsClient.textToSpeech.convert(bridge.voiceId, {
        text,
        modelId: 'eleven_flash_v2_5', // camelCase as per ElevenLabs Twilio guide
        outputFormat: 'ulaw_8000', // camelCase - Direct μ-law 8kHz output - no conversion needed!
      });
    } catch (error: any) {
      // If camelCase fails, try snake_case (SDK might accept both)
      logger.warn('[VOICE_BRIDGE] camelCase format failed, trying snake_case', {
        callSid,
        error: error.message,
      });
      try {
        audioStream = await bridge.ttsClient.textToSpeech.convert(bridge.voiceId, {
          text,
          model_id: 'eleven_flash_v2_5',
          output_format: 'ulaw_8000',
        });
      } catch (error2: any) {
        logger.error('[VOICE_BRIDGE] Failed to convert text to audio with ulaw_8000 format', {
          callSid,
          camelCaseError: error.message,
          snakeCaseError: error2.message,
          note: 'Both formats failed - check SDK version',
        });
        throw error2; // Re-throw the last error
      }
    }

    // Accumulate all audio chunks from ElevenLabs (as per docs - send all at once)
    const audioChunks: Buffer[] = [];
    let chunkCount = 0;
    for await (const audioChunk of audioStream) {
      audioChunks.push(Buffer.from(audioChunk));
      chunkCount++;
    }

    if (audioChunks.length === 0) {
      logger.error('[VOICE_BRIDGE] ❌ No audio chunks received from ElevenLabs', {
        callSid,
        textLength: text.length,
        note: 'ElevenLabs TTS stream returned empty - check API key, voice ID, and text content',
      });
      return;
    }

    // Combine all audio chunks into single buffer
    const rawAudioBuffer = Buffer.concat(audioChunks);
    
    logger.debug('[VOICE_BRIDGE] ✅ Received audio from ElevenLabs', {
      callSid,
      chunkCount,
      totalBytes: rawAudioBuffer.length,
      avgChunkSize: Math.round(rawAudioBuffer.length / chunkCount),
    });
    
    // Official @elevenlabs/elevenlabs-js package correctly handles ulaw_8000 output format
    // No conversion needed - trust the official package
    
    if (!bridge.firstAudioSent) {
      bridge.firstAudioSent = true;
    }

    // Check if bridge still exists (stream might have closed)
    const bridgeStillExists = activeBridges.has(callSid);
    if (!bridgeStillExists) {
      bridge.isAISpeaking = false;
      return;
    }

    // Mark AI as speaking - suppress STT during this time to prevent echo
    bridge.isAISpeaking = true;
    bridge.aiSpeechStartTime = Date.now();
    
    // CRITICAL: Clear STT buffer when AI starts speaking to prevent processing stale audio
    // This prevents echo fragments like "you" from being transcribed from audio buffered before AI spoke
    if (bridge.sttStream && typeof bridge.sttStream.clear === 'function') {
      bridge.sttStream.clear();
      logger.debug('[VOICE_BRIDGE] Cleared STT buffer - AI is speaking', { callSid });
    }
    
    // CRITICAL FIXES: Prevent looping by clearing pending transcripts and keeping isWaitingForResponse true
    // 1. Clear any pending interim transcripts (prevent sending stale transcripts)
    bridge.pendingTranscript = '';
    
    // 2. Cancel any pending interim transcript timeout (prevent it from firing right after AI speaks)
    if (bridge.transcriptTimeout) {
      clearTimeout(bridge.transcriptTimeout);
      bridge.transcriptTimeout = undefined;
    }
    
    // 3. Keep isWaitingForResponse true - don't reset it here! Will reset after audio finishes playing
    // This prevents new transcripts from being processed while AI is speaking or just finished
    bridge.isWaitingForResponse = true;
    
    // Calculate estimated speech duration from audio buffer size (μ-law 8kHz: 8000 bytes = 1 second)
    const baseAudioDurationMs = Math.round((rawAudioBuffer.length / 8000) * 1000);
    
    // Dynamic buffer calculation based on audio duration (aggressive for 50% latency reduction):
    // - Short audio (< 3s): +30% buffer (minimum 500ms) - much faster responses
    // - Medium (3-10s): +15% buffer (minimum 1000ms) - balanced for normal speech
    // - Long (> 10s): Fixed 2000ms buffer - longer audio needs processing time
    let dynamicBufferMs: number;
    if (baseAudioDurationMs < 3000) {
      dynamicBufferMs = Math.max(500, Math.round(baseAudioDurationMs * 0.3)); // Reduced from 1500ms min, 50% to 30%
    } else if (baseAudioDurationMs < 10000) {
      dynamicBufferMs = Math.max(1000, Math.round(baseAudioDurationMs * 0.15)); // Reduced from 2000ms min, 25% to 15%
    } else {
      dynamicBufferMs = 2000; // Reduced from 3000ms
    }
    
    // Network and processing buffer: account for Twilio playback delay and network latency
    const networkProcessingBufferMs = 200; // Reduced from 500ms to 200ms (60% reduction for 50% latency cut)
    
    // Total wait time: audio duration + dynamic buffer + network processing
    const totalWaitTimeMs = baseAudioDurationMs + dynamicBufferMs + networkProcessingBufferMs;
    const audioSendTime = Date.now();
    
    logger.info('[VOICE_BRIDGE] 🎤 AI speaking', {
      callSid,
      durationSeconds: (baseAudioDurationMs / 1000).toFixed(1),
      totalWaitTimeMs,
      dynamicBufferMs,
      networkBufferMs: networkProcessingBufferMs,
    });

    // CHUNKED AUDIO SENDING: Send audio in 2-second chunks to allow interruption
    // This allows user to interrupt AI mid-speech by stopping further chunks
    const CHUNK_SIZE_BYTES = 16000; // ~2 seconds at 8kHz μ-law (8000 bytes = 1 second)
    // Calculate delay relative to chunk duration (20-30% of chunk time)
    // Longer chunks need more time for interruption detection
    const CHUNK_DELAY_PERCENT = 0.25; // 25% of chunk duration (500ms for 2s chunks, 250ms for 1s chunks)
    const MIN_CHUNK_DELAY_MS = 200; // Minimum delay (for very short chunks)
    const MAX_CHUNK_DELAY_MS = 600; // Maximum delay (cap to prevent too slow)
    
    // Calculate relative delay based on chunk size
    const calculateChunkDelay = (chunkSizeBytes: number): number => {
      const chunkDurationMs = (chunkSizeBytes / 8000) * 1000;
      const relativeDelay = Math.round(chunkDurationMs * CHUNK_DELAY_PERCENT);
      return Math.max(MIN_CHUNK_DELAY_MS, Math.min(MAX_CHUNK_DELAY_MS, relativeDelay));
    };
    
    bridge.shouldStopAudio = false; // Reset interruption flag
    
    let totalBytesSent = 0;
    let chunkIndex = 0;
    const totalChunks = Math.ceil(rawAudioBuffer.length / CHUNK_SIZE_BYTES);
    
    logger.info('[VOICE_BRIDGE] 🎤 Sending audio in chunks (allows interruption)', {
      callSid,
      totalBytes: rawAudioBuffer.length,
      chunkSize: CHUNK_SIZE_BYTES,
      totalChunks,
      estimatedDurationSeconds: (baseAudioDurationMs / 1000).toFixed(1),
    });
    
    // Send audio in chunks with interruption detection
    const sendChunks = async (): Promise<void> => {
      for (let i = 0; i < totalChunks; i++) {
        // Check if user interrupted
        const currentBridge = activeBridges.get(callSid);
        if (!currentBridge || currentBridge.shouldStopAudio) {
          logger.info('[VOICE_BRIDGE] 🛑 Audio sending stopped - user interrupted', {
            callSid,
            chunkIndex: i,
            totalChunks,
            bytesSent: totalBytesSent,
            bytesRemaining: rawAudioBuffer.length - totalBytesSent,
          });
          break;
        }
        
        // Extract chunk
        const chunkStart = i * CHUNK_SIZE_BYTES;
        const chunkEnd = Math.min(chunkStart + CHUNK_SIZE_BYTES, rawAudioBuffer.length);
        const chunk = rawAudioBuffer.slice(chunkStart, chunkEnd);
        
        // Send chunk
        const success = sendAudioToStream(callSid, chunk);
        if (!success) {
          logger.warn('[VOICE_BRIDGE] Failed to send audio chunk', {
            callSid,
            chunkIndex: i,
            note: 'Stream may have closed',
          });
          break;
        }
        
        totalBytesSent += chunk.length;
        chunkIndex = i + 1;
        
        // After sending each chunk, check for interruption before sending the next one
        // Wait between chunks to allow time for interruption detection
        // Delay is relative to chunk size - longer chunks need more time for interruption detection
        // Only delay if not the last chunk
        if (i < totalChunks - 1) {
          // Calculate delay relative to next chunk's size (for last chunk, use actual size)
          const nextChunkStart = (i + 1) * CHUNK_SIZE_BYTES;
          const nextChunkEnd = Math.min(nextChunkStart + CHUNK_SIZE_BYTES, rawAudioBuffer.length);
          const nextChunkSize = nextChunkEnd - nextChunkStart;
          const chunkDelayMs = calculateChunkDelay(nextChunkSize);
          
          logger.debug('[VOICE_BRIDGE] Chunk delay calculation', {
            callSid,
            chunkIndex: i + 1,
            nextChunkSize,
            nextChunkDurationMs: (nextChunkSize / 8000) * 1000,
            calculatedDelayMs: chunkDelayMs,
            delayPercent: ((chunkDelayMs / ((nextChunkSize / 8000) * 1000)) * 100).toFixed(1) + '%',
          });
          
          // Wait and check for interruption during the delay
          await new Promise(resolve => setTimeout(resolve, chunkDelayMs));
          
          // Check if user interrupted during the delay
          const currentBridge = activeBridges.get(callSid);
          if (!currentBridge || currentBridge.shouldStopAudio) {
            logger.info('[VOICE_BRIDGE] 🛑 Interruption detected between chunks', {
              callSid,
              chunkIndex: i + 1, // Next chunk that would have been sent
              chunksSent: i + 1,
              totalChunks,
              bytesSent: totalBytesSent,
              delayMs: chunkDelayMs,
              note: 'User interrupted - stopping before sending next chunk',
            });
            break; // Stop sending more chunks
          }
        }
      }
      
      // Check if audio was interrupted
      const finalBridge = activeBridges.get(callSid);
      const wasInterrupted = finalBridge?.shouldStopAudio || false;
      const actualBytesSent = totalBytesSent;
      const actualDurationMs = Math.round((actualBytesSent / 8000) * 1000);
      
      if (wasInterrupted) {
        logger.info('[VOICE_BRIDGE] 🛑 Audio interrupted by user', {
          callSid,
          bytesSent: actualBytesSent,
          bytesTotal: rawAudioBuffer.length,
          durationSentSeconds: (actualDurationMs / 1000).toFixed(1),
          note: 'User interrupted - remaining audio not sent',
        });
      } else {
        logger.info('[VOICE_BRIDGE] ✅ All audio chunks sent', {
          callSid,
          totalChunks,
          totalBytes: actualBytesSent,
        });
      }
      
      // Schedule STT to resume after AI finishes speaking
      // Use actual duration of sent audio (not total)
      const actualWaitTimeMs = actualDurationMs + dynamicBufferMs + networkProcessingBufferMs;
      
      setTimeout(() => {
        if (activeBridges.has(callSid)) {
          const currentBridge = activeBridges.get(callSid);
          if (currentBridge && currentBridge.isAISpeaking && !currentBridge.shouldStopAudio) {
            currentBridge.isAISpeaking = false;
            currentBridge.aiSpeechEndTime = Date.now();
            
            // CRITICAL: Clear STT buffer when AI finishes speaking to prevent processing residual audio
            if (currentBridge.sttStream && typeof currentBridge.sttStream.clear === 'function') {
              currentBridge.sttStream.clear();
              logger.debug('[VOICE_BRIDGE] Cleared STT buffer - AI finished speaking, ready for user input', { callSid });
            }
            
            // Immediately allow processing new transcripts (echo filtering will handle false positives)
            // Reduced delay - echo filtering in handleSTTResult is sufficient
            const postSpeechDelayMs = 500; // Reduced from 1500ms - echo filtering handles the rest
            
            // Set isWaitingForResponse to false immediately (echo filtering will prevent false triggers)
            currentBridge.isWaitingForResponse = false;
            
            // Small delay to log the state change
            setTimeout(() => {
              if (activeBridges.has(callSid)) {
                const finalBridge = activeBridges.get(callSid);
                if (finalBridge) {
                  logger.debug('[VOICE_BRIDGE] Ready for user input', {
                    callSid,
                    timeSinceAIFinished: Date.now() - (finalBridge.aiSpeechEndTime || 0),
                    note: 'isWaitingForResponse is false - STT will process user input',
                  });
                }
              }
            }, postSpeechDelayMs);
            
            const actualWaitTime = Date.now() - audioSendTime;
            logger.info('[VOICE_BRIDGE] ✅ AI finished speaking - ready for input', {
              callSid,
              estimatedDurationMs: actualDurationMs,
              totalWaitTimeMs: actualWaitTimeMs,
              actualWaitTime,
              postSpeechDelayMs,
              wasInterrupted,
            });
          }
        }
      }, actualWaitTimeMs);
    };
    
    // Start sending chunks (don't await - let it run in background)
    sendChunks().catch((error: any) => {
      logger.error('[VOICE_BRIDGE] Error sending audio chunks', {
        callSid,
        error: error.message,
      });
      const errorBridge = activeBridges.get(callSid);
      if (errorBridge) {
        errorBridge.isAISpeaking = false;
        errorBridge.isWaitingForResponse = false;
      }
    });
  } catch (error: any) {
    logger.error('[VOICE_BRIDGE] ❌ Exception while converting text to audio', {
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

  logger.info('[VOICE_BRIDGE] Stopping bridge', { callSid });

  // Close STT stream if open
  if (bridge.sttStream) {
    bridge.sttStream.close();
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
    logger.error('[VOICE_BRIDGE] Error preloading context', {
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
    logger.debug('[VOICE_BRIDGE] Context already preloaded', {
      contactId,
      accountId,
      cacheKey,
    });
    return;
  }

  logger.info('[VOICE_BRIDGE] Starting preload before call', {
    contactId,
    accountId,
    hasInstructions: !!instructions,
    note: 'Preloading context while Twilio call is connecting - reduces latency',
  });

  // Start preloading (don't await - let it run in background)
  preloadContextForCall(accountId, contactId, instructions)
    .then((context) => {
      preloadedContextCache.set(cacheKey, context);
      logger.info('[VOICE_BRIDGE] Context preloaded before call', {
        contactId,
        accountId,
        hasSystemPrompt: !!context.systemPrompt,
        historyLength: context.conversationHistory.length,
        loadTimeMs: Date.now() - context.loadedAt,
        note: 'Context ready - will be used when bridge connects',
      });
    })
    .catch((error: any) => {
      logger.warn('[VOICE_BRIDGE] Failed to preload context before call', {
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

