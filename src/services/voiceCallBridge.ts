import { logger } from '../utils/logger';
import { env } from '../config/env';
import { sendAudioToStream, MediaStreamConnection } from './twilioMediaStreams';
import { createSTTStream, STTStream, STTResult } from './speechToText';
import { ensureUlawFormat, isMp3Format } from '../utils/audioConverter';
import { sendMessageToAgent } from './agentService'; // Use unified agent service (OpenAI Chat API)
import { upsertConversation, addMessageToConversation } from './conversationService';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ElevenLabsClient } = require('elevenlabs');

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
  instructions?: string; // Campaign instructions for AI context
}

// Store active bridges
const activeBridges = new Map<string, VoiceCallBridge>();

// Buffer for audio chunks received before bridge is ready
const pendingAudioBuffers = new Map<string, Array<{ chunk: Buffer; timestamp: number }>>();

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
      // Make it explicit: greet first, then discuss the campaign
      if (customIntroduction && customIntroduction.trim()) {
        greetingMessage = `${customIntroduction.trim()}\n\nYou are calling about a campaign. Please:\n1. Greet the caller warmly\n2. Then discuss the campaign based on these instructions:\n\n${instructions.trim()}\n\nStart the conversation now.`;
      } else {
        greetingMessage = `You are calling about a campaign. Please:\n1. Greet the caller warmly\n2. Then discuss the campaign based on these instructions:\n\n${instructions.trim()}\n\nStart the conversation now.`;
      }
    } else {
      // Fallback to custom introduction or default greeting
      greetingMessage = customIntroduction && customIntroduction.trim()
        ? customIntroduction.trim()
        : 'The caller has just connected to the call. Please introduce yourself briefly and ask how you can help them today.';
    }
    
    logger.info('[VOICE_BRIDGE] Sending initial greeting to AI agent', { 
      callSid,
      hasTtsClient: !!ttsClient,
      hasOpenAIKey: !!env.OPENAI_API_KEY,
      hasCustomIntroduction: !!customIntroduction,
      hasInstructions: !!instructions,
      greetingLength: greetingMessage.length,
      note: instructions 
        ? '✅ Campaign instructions included - AI will have full context like email/SMS'
        : '⚠️ No campaign instructions - using generic greeting',
    });
    
    // Send initial greeting to trigger AI response
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

  // Echo suppression: Skip STT while AI is speaking
  if (bridge.isAISpeaking) {
    return; // Skip silently while AI is speaking
  }

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

  // CRITICAL: Ignore ALL transcripts while AI is currently speaking
  // This prevents transcribing the AI's own voice (echo suppression)
  if (bridge.isAISpeaking) {
    logger.debug('[VOICE_BRIDGE] Ignoring transcript - AI is speaking', {
      callSid,
      text: result.text.substring(0, 50),
      note: 'Not processing transcripts while AI speaks to prevent echo',
    });
    return;
  }

  if (result.isFinal) {
    const finalText = result.text.trim();
    
    if (!finalText) {
      return; // Ignore empty transcripts
    }

    const now = Date.now();

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
    // Extended echo window to 3 seconds to catch delayed echo transcription
    const timeSinceAIFinished = bridge.aiSpeechEndTime 
      ? now - bridge.aiSpeechEndTime 
      : Infinity;
    
    // Extended echo window: filter transcripts within 3 seconds of AI finishing (increased from 1s)
    // This accounts for audio processing delays and transcription latency
    const isWithinEchoWindow = timeSinceAIFinished < 3000;
    
    // List of common echo phrases that match AI responses
    // When AI says "You're welcome!", echo often becomes "Thank you." or "you"
    // These are legitimate user responses but become echo when transcribed too quickly after AI speech
    const echoPhrases = ['thank you', 'thank you.', 'thanks', 'thanks.', 'you', 'wel', 'come', 'than', 'thank', 'welcome'];
    const normalizedText = finalText.toLowerCase().trim();
    const isEchoPhrase = echoPhrases.some(phrase => normalizedText === phrase || normalizedText.includes(phrase));
    
    // Filter echo phrases within echo window
    if (isWithinEchoWindow && isEchoPhrase) {
      logger.debug('[VOICE_BRIDGE] Ignoring likely echo phrase', {
        callSid,
        text: finalText,
        timeSinceAIFinished,
        note: 'Phrase matches common echo pattern within 3 seconds of AI response - likely echo',
      });
      return;
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
    
    // Process legitimate transcripts (including "yes"/"no" after a pause, or any longer text)
    if (finalText && !bridge.isWaitingForResponse) {
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
      
      bridge.pendingTranscript = '';
      bridge.isWaitingForResponse = true;
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
        }, 2000); // Wait 2 seconds of silence before sending interim
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

    logger.info('[VOICE_BRIDGE] 📤 Sending to AI', {
      callSid,
      text: text.substring(0, 150),
      textLength: text.length,
      hasAccountId: !!bridge.accountId,
      hasContactId: !!bridge.contactId,
      note: bridge.accountId && bridge.contactId
        ? '✅ Agent will have full CRM context (campaigns, deals, contact info, conversation history)'
        : bridge.accountId
        ? '⚠️ Has accountId but no contactId - will have campaigns/deals but limited contact context'
        : '❌ No accountId - agent will NOT have CRM context (generic responses only)',
    });

    // Use unified agent service (OpenAI Chat API)
    // Pass accountId and contactId to get CRM context (same as SMS/Email)
    // Pass campaign instructions for ongoing conversation context
    const response = await sendMessageToAgent(
      bridge.agentId,
      text,
      undefined,
      bridge.contactId,
      bridge.accountId,
      3,
      bridge.instructions // Pass campaign instructions for all messages
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
    
    // Check if we received MP3 format (ElevenLabs may return MP3 even when requesting ulaw_8000)
    const isMp3 = isMp3Format(rawAudioBuffer);
    
    // Convert to μ-law 8kHz if needed (handles MP3 conversion)
    const muLawBuffer = await ensureUlawFormat(rawAudioBuffer);
    
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
    const baseAudioDurationMs = Math.round((muLawBuffer.length / 8000) * 1000);
    
    // Dynamic buffer calculation based on audio duration:
    // - Short audio (< 3s): +50% buffer (minimum 1500ms) - faster responses need less buffer
    // - Medium (3-10s): +25% buffer (minimum 2000ms) - balanced for normal speech
    // - Long (> 10s): Fixed 3000ms buffer - longer audio needs more processing time
    let dynamicBufferMs: number;
    if (baseAudioDurationMs < 3000) {
      dynamicBufferMs = Math.max(1500, Math.round(baseAudioDurationMs * 0.5));
    } else if (baseAudioDurationMs < 10000) {
      dynamicBufferMs = Math.max(2000, Math.round(baseAudioDurationMs * 0.25));
    } else {
      dynamicBufferMs = 3000; // Fixed buffer for very long audio
    }
    
    // Network and processing buffer: account for Twilio playback delay and network latency
    const networkProcessingBufferMs = 1000;
    
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

    // Send all audio at once
    const success = sendAudioToStream(callSid, muLawBuffer);
    if (!success) {
      bridge.isAISpeaking = false;
      bridge.isWaitingForResponse = false;
      return;
    }

    // Schedule STT to resume after AI finishes speaking
    // Use dynamic timeout based on audio duration to ensure proper echo suppression
    setTimeout(() => {
      if (activeBridges.has(callSid)) {
        const currentBridge = activeBridges.get(callSid);
        if (currentBridge && currentBridge.isAISpeaking) {
          currentBridge.isAISpeaking = false;
          currentBridge.aiSpeechEndTime = Date.now();
          
          // Post-speech delay: additional buffer after audio finishes to allow echo to settle
          // This prevents immediate transcription of echo/crosstalk after AI finishes speaking
          const postSpeechDelayMs = 1000; // Fixed 1 second delay after audio finishes
          
          setTimeout(() => {
            if (activeBridges.has(callSid)) {
              const finalBridge = activeBridges.get(callSid);
              if (finalBridge) {
                finalBridge.isWaitingForResponse = false;
              }
            }
          }, postSpeechDelayMs);
          
          const actualWaitTime = Date.now() - audioSendTime;
          logger.info('[VOICE_BRIDGE] ✅ AI finished speaking - ready for input', {
            callSid,
            estimatedDurationMs: baseAudioDurationMs,
            totalWaitTimeMs,
            actualWaitTime,
            postSpeechDelayMs,
          });
        }
      }
    }, totalWaitTimeMs);
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

