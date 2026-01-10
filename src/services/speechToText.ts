import { logger } from '../utils/logger';
import { env } from '../config/env';
import OpenAI from 'openai';
import { PassThrough } from 'stream';
import ffmpeg from 'fluent-ffmpeg';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ElevenLabsClient } = require('elevenlabs');

// Set FFmpeg path from installer package (if available)
try {
  const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
  ffmpeg.setFfmpegPath(ffmpegInstaller.path);
} catch (error) {
  // FFmpeg installer not available, will try system FFmpeg
}

export interface STTResult {
  text: string;
  isFinal: boolean;
  confidence?: number;
}

export interface STTStream {
  write: (audioChunk: Buffer) => void;
  end: () => void;
  onTranscript: (callback: (result: STTResult) => void) => void;
  close: () => void;
  clear?: () => void; // Clear audio buffer to prevent processing stale audio
}

/**
 * Create a streaming STT connection
 * Supports multiple providers: OpenAI (recommended), ElevenLabs, Deepgram, Google Cloud, or Twilio
 */
export function createSTTStream(
  onTranscript: (result: STTResult) => void,
  language: string = 'en-US'
): STTStream | null {
  const provider = env.STT_PROVIDER || 'openai'; // Default to OpenAI for simpler integration

  try {
    switch (provider) {
      case 'openai':
        return createOpenAIStream(onTranscript, language);
      case 'elevenlabs':
        return createElevenLabsStream(onTranscript, language);
      case 'deepgram':
        return createDeepgramStream(onTranscript, language);
      case 'google':
        return createGoogleStream(onTranscript, language);
      case 'twilio':
        // Twilio STT requires different setup (via TwiML or API)
        logger.warn('[STT] Twilio STT not yet implemented for Media Streams');
        return null;
      default:
        logger.error('[STT] Unknown STT provider', { provider });
        return null;
    }
  } catch (error: any) {
    logger.error('[STT] Failed to create STT stream', {
      provider,
      error: error.message,
    });
    return null;
  }
}

/**
 * Create OpenAI Whisper STT stream
 * Buffers audio chunks and sends them to OpenAI Whisper API for transcription
 * Note: OpenAI Whisper is REST API (not streaming), so we buffer chunks every 1-2 seconds
 */
function createOpenAIStream(
  onTranscript: (result: STTResult) => void,
  language: string
): STTStream | null {
  if (!env.OPENAI_API_KEY) {
    logger.error('[STT] OPENAI_API_KEY not configured for OpenAI Whisper');
    return null;
  }

  try {
    const openai = new OpenAI({
      apiKey: env.OPENAI_API_KEY,
      baseURL: env.OPENAI_BASE_URL,
    });

    let audioBuffer: Buffer[] = [];
    let bufferStartTime = Date.now();
    let lastAudioReceivedTime = Date.now(); // Track when we last received audio for silence detection
    let lastRealAudioTime = Date.now(); // Track when we last received a "real" audio chunk (> 10 bytes)
    let isProcessing = false;
    let lastTranscriptTime = 0;
    const BUFFER_INTERVAL_MS = 3000; // Check every 3 seconds
    const MIN_AUDIO_BYTES = 8000; // Minimum ~1 second at 8kHz μ-law (~8000 bytes)
    const MIN_AUDIO_LENGTH_MS = 1500; // Minimum 1.5 seconds of audio before transcribing (increased for better sentence completion)
    const MAX_AUDIO_LENGTH_MS = 12000; // Maximum 12 seconds before forcing process (for long speech - increased)
    const SILENCE_DETECTION_MS = 2500; // If no new audio for 2.5 seconds, process (they stopped talking - increased for complete sentences)
    const MIN_REASONABLE_AUDIO = 4000; // Minimum ~500ms at 8kHz (need at least half a second for meaningful transcription)
    const MIN_CHUNK_SIZE_FOR_REAL_AUDIO = 10; // Chunks smaller than this are likely silence
    let bufferTimer: NodeJS.Timeout | null = null;
    let silenceDetectionTimer: NodeJS.Timeout | null = null;

    // Convert μ-law to WAV format for OpenAI Whisper
    async function convertMulawToWav(mulawBuffer: Buffer): Promise<Buffer> {
      return new Promise((resolve, reject) => {
        const inputStream = new PassThrough();
        inputStream.end(mulawBuffer);

        const outputStream = new PassThrough();
        const chunks: Buffer[] = [];

        outputStream.on('data', (chunk: Buffer) => {
          chunks.push(chunk);
        });

        outputStream.on('end', () => {
          resolve(Buffer.concat(chunks));
        });

        outputStream.on('error', (error) => {
          logger.error('[STT] Audio conversion error', { error: error.message });
          reject(error);
        });

        // Convert μ-law (8kHz) to WAV (16kHz) - Whisper prefers 16kHz
        ffmpeg(inputStream)
          .inputFormat('mulaw')
          .inputOptions(['-ar', '8000', '-ac', '1']) // Input: 8kHz mono μ-law
          .audioCodec('pcm_s16le') // Output: 16-bit PCM
          .audioFrequency(16000) // Output: 16kHz (Whisper works well with this)
          .audioChannels(1) // Mono
          .format('wav')
          .on('error', (error: any) => {
            logger.error('[STT] FFmpeg conversion error', { error: error.message });
            reject(error);
          })
          .pipe(outputStream, { end: true });
      });
    }

    // Process buffered audio
    async function processBuffer(forceReason?: string) {
      if (isProcessing || audioBuffer.length === 0) {
        return;
      }

      const totalBufferSize = audioBuffer.reduce((sum, b) => sum + b.length, 0);
      const bufferAge = Date.now() - bufferStartTime;
      const timeSinceLastAudio = Date.now() - lastAudioReceivedTime;
      const timeSinceRealAudio = Date.now() - lastRealAudioTime;
      
      // Check conditions for processing
      const hasMinSize = totalBufferSize >= MIN_AUDIO_BYTES;
      const hasMinTime = bufferAge >= MIN_AUDIO_LENGTH_MS;
      const hasMaxTime = bufferAge >= MAX_AUDIO_LENGTH_MS; // Force process after 10 seconds (long speech)
      const hasSilence = timeSinceLastAudio >= SILENCE_DETECTION_MS; // No audio for 1.5 seconds (they stopped talking)
      const hasReasonableAudio = totalBufferSize >= MIN_REASONABLE_AUDIO; // Need at least 500ms for meaningful transcription
      
      // Better silence detection: if average chunk size is very small, it's likely silence
      const avgChunkSize = audioBuffer.length > 0 
        ? audioBuffer.reduce((sum, b) => sum + b.length, 0) / audioBuffer.length 
        : 0;
      const isLikelySilence = avgChunkSize < MIN_CHUNK_SIZE_FOR_REAL_AUDIO; // If average chunk < 10 bytes, it's silence
      
      // Only allow forced processing for stream-end (not silence or max-time if buffer is too small)
      const isLegitimateForceReason = forceReason === 'stream-ended';
      
      // Don't process if chunks are too small (silence)
      if (isLikelySilence && totalBufferSize < MIN_AUDIO_BYTES) {
        scheduleProcessing();
        return;
      }
      
      // Only process if we've received real audio chunks recently
      if (timeSinceRealAudio > 5000 && totalBufferSize < MIN_AUDIO_BYTES) {
        scheduleProcessing();
        return;
      }
      
      // Don't process if too small (unless we have substantial audio)
      if (!hasMinSize && !hasReasonableAudio && !isLegitimateForceReason && (!hasMaxTime || !hasReasonableAudio) && (!hasSilence || !hasReasonableAudio)) {
        scheduleProcessing();
        return;
      }
      
      // If max-time or silence reached but audio is still too small, reset and continue waiting
      if ((hasMaxTime || hasSilence) && !hasReasonableAudio) {
        audioBuffer = [];
        bufferStartTime = Date.now();
        lastAudioReceivedTime = Date.now();
        lastRealAudioTime = Date.now();
        scheduleProcessing();
        return;
      }
      
      // Skip if still way too small (unless stream ended)
      if (totalBufferSize < MIN_REASONABLE_AUDIO && !isLegitimateForceReason) {
        scheduleProcessing();
        return;
      }

      // Capture original buffer age before resetting (needed for quality check)
      const originalBufferAge = bufferAge;
      
      isProcessing = true;
      const chunksToProcess = [...audioBuffer];
      const bufferSizeBytes = totalBufferSize;
      audioBuffer = [];
      bufferStartTime = Date.now();
      lastAudioReceivedTime = Date.now();
      lastRealAudioTime = Date.now(); // Reset real audio tracking

      // Clear timers
      if (bufferTimer) {
        clearTimeout(bufferTimer);
        bufferTimer = null;
      }
      if (silenceDetectionTimer) {
        clearTimeout(silenceDetectionTimer);
        silenceDetectionTimer = null;
      }

      try {
        // Combine audio chunks
        const combinedAudio = Buffer.concat(chunksToProcess);
        
        const reason = forceReason || 
          (hasMaxTime ? 'max-time-reached' : 
           hasSilence ? 'silence-detected' : 
           hasMinSize ? 'min-size-reached' : 
           hasReasonableAudio ? 'reasonable-size-reached' :
           'min-time-reached');

        const avgChunkSizeForLog = chunksToProcess.length > 0
          ? (bufferSizeBytes / chunksToProcess.length).toFixed(2)
          : '0';
        
        logger.debug('[STT] Processing audio buffer', {
          bufferSize: bufferSizeBytes,
          reason,
        });

        // Convert μ-law to WAV
        const wavBuffer = await convertMulawToWav(combinedAudio);

        // Send to OpenAI Whisper API
        // OpenAI SDK v4+ accepts File objects (Node.js 18+ has File in global scope)
        // Create a File object from the WAV buffer
        const { File } = require('buffer');
        const audioFile = new File([wavBuffer], 'audio.wav', { type: 'audio/wav' });

        const transcript = await openai.audio.transcriptions.create({
          file: audioFile,
          model: 'whisper-1',
          language: language.split('-')[0], // Convert en-US to en
          response_format: 'verbose_json',
        });

        const transcriptText = transcript.text ? transcript.text.trim() : '';
        const hasText = transcriptText.length > 0;

        if (hasText) {
          // Quality check: if transcript is very short and doesn't end properly, might be incomplete
          const isVeryShort = transcriptText.length < 15;
          const endsWithPunctuation = /[.!?]$/.test(transcriptText);
          const isCommonShortResponse = /^(yes|no|ok|okay|sure|thanks|thank you|bye|hello|hi|yeah|yep|nope)$/i.test(transcriptText);
          const looksComplete = transcriptText.length >= 20 || endsWithPunctuation || isCommonShortResponse;
          
          // CRITICAL: Don't re-accumulate if it's a known echo phrase - just send it and let echo filter handle it
          // Echo phrases like "you", "thank you", etc. should be sent to voice bridge where they can be filtered
          // based on timing (within echo window after AI speech)
          const isKnownEchoPhrase = /^(you|wel|come|than|thank|welcome|thank you|thank you\.|thanks|thanks\.)$/i.test(transcriptText.trim());
          
          // If it looks incomplete and we have more buffer time, skip and accumulate more
          // This handles cases where user pauses mid-sentence (e.g., "tell me more about the campaigns... [pause] ...please")
          const timeRemainingBeforeMaxTime = MAX_AUDIO_LENGTH_MS - originalBufferAge;
          const canWaitForMore = timeRemainingBeforeMaxTime > 2000 && !isLegitimateForceReason;
          
          // Don't re-accumulate if it's a known echo phrase - let the voice bridge filter handle it
          if (isKnownEchoPhrase) {
            logger.debug('[STT] Known echo phrase detected, sending to bridge for filtering', {
              text: transcriptText,
              note: 'Voice bridge will filter if within echo window after AI speech',
            });
            // Continue to send transcript - voice bridge will filter it based on timing
          } else if (isVeryShort && !looksComplete && canWaitForMore) {
            // Only re-accumulate if it's NOT a known echo phrase
            logger.debug('[STT] Transcript looks incomplete, accumulating more audio', {
              text: transcriptText,
              originalBufferAge,
              timeRemainingBeforeMaxTime,
              note: 'Will re-process with more audio to get complete sentence',
            });
            
            // Re-add chunks to buffer and continue waiting
            audioBuffer = chunksToProcess;
            bufferStartTime = Date.now() - originalBufferAge; // Restore original start time
            lastAudioReceivedTime = Date.now();
            lastRealAudioTime = Date.now();
            isProcessing = false;
            scheduleProcessing();
            scheduleSilenceDetection();
            return;
          }
          
          // Otherwise, send the transcript
          logger.info('[STT] ✅ Transcript:', {
            text: transcriptText,
            isKnownEchoPhrase: isKnownEchoPhrase || false,
            note: isKnownEchoPhrase ? 'Echo phrase - voice bridge will filter based on timing' : 'Normal transcript',
          });

          onTranscript({
            text: transcriptText,
            isFinal: true,
            confidence: transcript.segments?.[0]?.no_speech_prob !== undefined 
              ? 1 - (transcript.segments[0].no_speech_prob || 0) 
              : undefined,
          });

          lastTranscriptTime = Date.now();
        }
      } catch (error: any) {
        logger.error('[STT] OpenAI Whisper transcription failed', {
          error: error.message,
          bufferSize: chunksToProcess.reduce((sum, b) => sum + b.length, 0),
        });
      } finally {
        isProcessing = false;
      }
    }

    // Schedule periodic processing
    function scheduleProcessing() {
      if (bufferTimer) {
        clearTimeout(bufferTimer);
      }

      bufferTimer = setTimeout(() => {
        // Don't pass forceReason - let processBuffer decide based on actual conditions
        // This allows the minimum size check to work properly - scheduled checks shouldn't force processing
        processBuffer(); // Will check conditions (size, time, silence) and only process if valid
        if (audioBuffer.length > 0 && !isProcessing) {
          scheduleProcessing(); // Continue scheduling if there's still audio buffered
        }
      }, BUFFER_INTERVAL_MS);
    }

    // Schedule silence detection - waits for user to finish speaking before transcribing
    // This ensures we only process complete sentences, not mid-speech fragments
    function scheduleSilenceDetection() {
      if (silenceDetectionTimer) {
        clearTimeout(silenceDetectionTimer);
      }

      silenceDetectionTimer = setTimeout(() => {
        const timeSinceLastAudio = Date.now() - lastAudioReceivedTime;
        // Process buffer only after 2.5 seconds of silence (user has finished speaking)
        if (timeSinceLastAudio >= SILENCE_DETECTION_MS && audioBuffer.length > 0 && !isProcessing) {
          processBuffer('silence-detected');
        }
      }, SILENCE_DETECTION_MS);
    }

    return {
      write: (audioChunk: Buffer) => {
        if (audioChunk.length === 0) {
          return;
        }

        audioBuffer.push(audioChunk);
        lastAudioReceivedTime = Date.now(); // Track when we last received audio
        
        // Track when we last received a substantial chunk (real audio vs silence)
        // Chunks > 10 bytes indicate real audio, < 10 bytes are likely silence
        if (audioChunk.length > MIN_CHUNK_SIZE_FOR_REAL_AUDIO) {
          lastRealAudioTime = Date.now();
        }
        
        // Clear silence detection timer - we're receiving audio
        if (silenceDetectionTimer) {
          clearTimeout(silenceDetectionTimer);
          silenceDetectionTimer = null;
        }
        
        // Schedule silence detection (if no audio for 2.5 seconds, process - waits for user to finish speaking)
        // This ensures we only transcribe after natural pauses, not mid-speech
        scheduleSilenceDetection();
        
        // Schedule periodic processing if not already scheduled (for max-time check and periodic validation)
        if (!bufferTimer) {
          scheduleProcessing();
        }

        // REMOVED: Immediate processing triggers - these caused partial transcripts mid-speech
        // Now we ONLY process on:
        // 1. Silence detection (2500ms of no audio) - user has finished speaking
        // 2. Max time (12 seconds) - very long speech, force process to avoid hanging
        // This ensures complete sentences are captured, not mid-speech fragments
        //
        // OLD CODE (removed):
        // - Immediate processing when buffer >= 8000 bytes AND age >= 1500ms
        // - Immediate processing when buffer >= 16000 bytes AND age >= 2000ms
        // These caused transcripts to appear while user was still talking
      },
      end: () => {
        // Process any remaining audio when stream ends
        if (audioBuffer.length > 0 && !isProcessing) {
          processBuffer('stream-ended');
        }
        
        if (bufferTimer) {
          clearTimeout(bufferTimer);
          bufferTimer = null;
        }
        if (silenceDetectionTimer) {
          clearTimeout(silenceDetectionTimer);
          silenceDetectionTimer = null;
        }
        audioBuffer = [];
      },
      onTranscript: (callback: (result: STTResult) => void) => {
        // Already set up in constructor
      },
      close: () => {
        if (bufferTimer) {
          clearTimeout(bufferTimer);
          bufferTimer = null;
        }
        if (silenceDetectionTimer) {
          clearTimeout(silenceDetectionTimer);
          silenceDetectionTimer = null;
        }
        audioBuffer = [];
      },
      clear: () => {
        // Clear the audio buffer to prevent processing stale audio (e.g., when AI starts speaking)
        audioBuffer = [];
        bufferStartTime = Date.now();
        lastAudioReceivedTime = Date.now();
        lastRealAudioTime = Date.now();
        if (bufferTimer) {
          clearTimeout(bufferTimer);
          bufferTimer = null;
        }
        if (silenceDetectionTimer) {
          clearTimeout(silenceDetectionTimer);
          silenceDetectionTimer = null;
        }
        isProcessing = false;
      },
    };
  } catch (error: any) {
    logger.error('[STT] Failed to create OpenAI Whisper stream', {
      error: error.message,
    });
    return null;
  }
}

/**
 * Create ElevenLabs streaming STT connection (Scribe v2 Realtime)
 */
function createElevenLabsStream(
  onTranscript: (result: STTResult) => void,
  language: string
): STTStream | null {
  if (!env.ELEVENLABS_API_KEY) {
    logger.error('[STT] ELEVENLABS_API_KEY not configured');
    return null;
  }

  try {
    const WebSocket = require('ws');
    
    // ElevenLabs Scribe v2 Realtime WebSocket URL
    // Per docs: https://elevenlabs.io/docs/developers/guides/cookbooks/speech-to-text/streaming
    // Configuration is done via query parameters - audio format is auto-detected or set via session_started event
    // Add inactivity_timeout to prevent premature closure (max 180 seconds)
    const wsUrl = `wss://api.elevenlabs.io/v1/speech-to-text/realtime?model_id=scribe_v2_realtime&language=${language}&inactivity_timeout=180`;
    
    const ws = new WebSocket(wsUrl, {
      headers: {
        'xi-api-key': env.ELEVENLABS_API_KEY,
      },
    });

    let isOpen = false;
    const messageQueue: Buffer[] = [];

    ws.on('open', () => {
      isOpen = true;
      logger.info('[STT] ElevenLabs WebSocket connected');
      
      // Don't send config message - ElevenLabs will send session_started with config
      // Configuration is done via query parameters in the WebSocket URL
      
      // Send queued messages (convert to base64 JSON format)
      while (messageQueue.length > 0) {
        const chunk = messageQueue.shift();
        if (chunk) {
          const audioBase64 = chunk.toString('base64');
          const message = {
            audio_base_64: audioBase64,
          };
          ws.send(JSON.stringify(message));
        }
      }
    });

    ws.on('message', (data: any) => {
      try {
        // ElevenLabs sends JSON messages only (not binary)
        // Per docs: https://elevenlabs.io/docs/developers/guides/cookbooks/speech-to-text/streaming
        if (typeof data === 'string') {
          const message = JSON.parse(data);
          
          // Handle session_started event (configuration from server)
          if (message.type === 'session_started') {
            logger.info('[STT] Session started', {
              sampleRate: message.sample_rate,
              encoding: message.encoding,
            });
            return;
          }
          
          // Handle partial transcripts (interim results)
          if (message.type === 'partial_transcript') {
            logger.debug('[STT] Partial transcript received', {
              text: message.text,
            });
            if (message.text && message.text.trim()) {
              onTranscript({
                text: message.text,
                isFinal: false,
                confidence: message.confidence,
              });
            }
            return;
          }
          
          // Handle committed transcripts (final results)
          if (message.type === 'committed_transcript' || message.type === 'committed_transcript_with_timestamps') {
            logger.info('[STT] Committed transcript received', {
              text: message.text,
            });
            if (message.text && message.text.trim()) {
              onTranscript({
                text: message.text,
                isFinal: true,
                confidence: message.confidence,
              });
            }
            return;
          }
          
          // Handle error types per ElevenLabs documentation
          if (message.type === 'error' || message.type === 'auth_error' || 
              message.type === 'quota_exceeded' || message.type === 'transcriber_error' ||
              message.type === 'input_error' || message.type === 'commit_throttled' ||
              message.type === 'unaccepted_terms' || message.type === 'rate_limited' ||
              message.type === 'queue_overflow' || message.type === 'resource_exhausted' ||
              message.type === 'session_time_limit_exceeded' || message.type === 'chunk_size_exceeded' ||
              message.type === 'insufficient_audio_activity') {
            logger.error('[STT] ElevenLabs STT error', {
              errorType: message.type,
              error: message.error || message.message || JSON.stringify(message),
            });
            return;
          }
          
          // Log unknown message types for debugging
          logger.debug('[STT] Unknown ElevenLabs message type', {
            type: message.type,
            message: JSON.stringify(message).substring(0, 200),
          });
        }
      } catch (error: any) {
        logger.error('[STT] Failed to parse ElevenLabs message', {
          error: error.message,
          dataPreview: typeof data === 'string' ? data.substring(0, 200) : 'binary data',
        });
      }
    });

    ws.on('error', (error: Error) => {
      logger.error('[STT] ElevenLabs WebSocket error', {
        error: error.message,
        stack: error.stack,
      });
    });

    ws.on('close', (code: number, reason: Buffer) => {
      isOpen = false;
      const reasonStr = reason ? reason.toString() : 'No reason provided';
      
      logger.info('[STT] ElevenLabs WebSocket closed', {
        code,
        reason: reasonStr,
        codeMeaning: getCloseCodeMeaning(code),
      });
      
      // Log warning if closed unexpectedly (not normal closure)
      if (code !== 1000 && code !== 1001) {
        logger.warn('[STT] ElevenLabs WebSocket closed unexpectedly', {
          code,
          reason: reasonStr,
          codeMeaning: getCloseCodeMeaning(code),
        });
      }
    });

    return {
      write: (audioChunk: Buffer) => {
        // Convert audio chunk to base64 and send as JSON message
        // Per ElevenLabs docs: https://elevenlabs.io/docs/developers/guides/cookbooks/speech-to-text/streaming
        // Audio must be sent as JSON with audio_base_64 field
        const audioBase64 = audioChunk.toString('base64');
        const message = {
          audio_base_64: audioBase64,
        };
        
        if (isOpen) {
          ws.send(JSON.stringify(message));
        } else {
          // Queue the raw buffer, we'll convert when connection opens
          messageQueue.push(audioChunk);
        }
      },
      end: () => {
        if (isOpen) {
          // Send end signal
          const endMessage = {
            type: 'end',
          };
          ws.send(JSON.stringify(endMessage));
          ws.close();
        }
      },
      onTranscript: (callback: (result: STTResult) => void) => {
        // Already set up in constructor
      },
      close: () => {
        if (isOpen) {
          ws.close();
        }
      },
    };
  } catch (error: any) {
    logger.error('[STT] Failed to create ElevenLabs stream', {
      error: error.message,
    });
    return null;
  }
}

/**
 * Create Deepgram streaming STT connection
 */
function createDeepgramStream(
  onTranscript: (result: STTResult) => void,
  language: string
): STTStream | null {
  if (!env.DEEPGRAM_API_KEY) {
    logger.error('[STT] DEEPGRAM_API_KEY not configured');
    return null;
  }

  try {
    // Use WebSocket library (already installed)
    const WebSocket = require('ws');
    
    // Deepgram WebSocket URL with proper parameters
    // Note: Twilio sends μ-law PCM at 8kHz, Deepgram supports this format
    const wsUrl = `wss://api.deepgram.com/v1/listen?model=nova-2&language=${language}&punctuate=true&interim_results=true&encoding=mulaw&sample_rate=8000&channels=1`;
    
    const ws = new WebSocket(wsUrl, {
      headers: {
        Authorization: `Token ${env.DEEPGRAM_API_KEY}`,
      },
    });

    let isOpen = false;
    const messageQueue: Buffer[] = [];

    ws.on('open', () => {
      isOpen = true;
      logger.info('[STT] Deepgram WebSocket connected');
      
      // Send queued messages
      while (messageQueue.length > 0) {
        const chunk = messageQueue.shift();
        if (chunk) {
          ws.send(chunk);
        }
      }
    });

    ws.on('message', (data: any) => {
      try {
        const message = JSON.parse(data.toString());
        
        if (message.channel?.alternatives?.[0]) {
          const transcript = message.channel.alternatives[0].transcript;
          const isFinal = message.is_final || false;
          const confidence = message.channel.alternatives[0].confidence;

          if (transcript) {
            onTranscript({
              text: transcript,
              isFinal,
              confidence,
            });
          }
        }
      } catch (error: any) {
        logger.error('[STT] Failed to parse Deepgram message', {
          error: error.message,
        });
      }
    });

    ws.on('error', (error: Error) => {
      logger.error('[STT] Deepgram WebSocket error', {
        error: error.message,
      });
    });

    ws.on('close', () => {
      isOpen = false;
      logger.info('[STT] Deepgram WebSocket closed');
    });

    return {
      write: (audioChunk: Buffer) => {
        // Convert μ-law to linear PCM (Deepgram expects linear PCM)
        // Twilio sends μ-law, but Deepgram can handle it if we specify the format
        // For now, we'll send raw audio and let Deepgram handle it
        // In production, you might need to convert μ-law to linear PCM
        
        if (isOpen) {
          ws.send(audioChunk);
        } else {
          messageQueue.push(audioChunk);
        }
      },
      end: () => {
        if (isOpen) {
          ws.close();
        }
      },
      onTranscript: (callback: (result: STTResult) => void) => {
        // Already set up in constructor
      },
      close: () => {
        if (isOpen) {
          ws.close();
        }
      },
    };
  } catch (error: any) {
    logger.error('[STT] Failed to create Deepgram stream', {
      error: error.message,
    });
    return null;
  }
}

/**
 * Create Google Cloud Speech-to-Text streaming connection
 */
function createGoogleStream(
  onTranscript: (result: STTResult) => void,
  language: string
): STTStream | null {
  if (!env.GOOGLE_CLOUD_PROJECT_ID) {
    logger.error('[STT] GOOGLE_CLOUD_PROJECT_ID not configured');
    return null;
  }

  // Google Cloud Speech-to-Text requires the @google-cloud/speech package
  // This is a placeholder implementation
  logger.warn('[STT] Google Cloud STT not yet fully implemented');
  return null;
}

/**
 * Convert μ-law audio to linear PCM (if needed)
 * Twilio Media Streams sends μ-law PCM, some STT services need linear PCM
 */
export function convertMulawToLinear(mulawBuffer: Buffer): Buffer {
  // Simple μ-law to linear PCM conversion
  // This is a basic implementation - for production, use a proper audio library
  const linearBuffer = Buffer.alloc(mulawBuffer.length * 2);
  
  for (let i = 0; i < mulawBuffer.length; i++) {
    const mulawByte = mulawBuffer[i];
    // μ-law decoding formula
    let sign = mulawByte & 0x80;
    let exponent = (mulawByte & 0x70) >> 4;
    let mantissa = mulawByte & 0x0F;
    
    let linear = mantissa << (exponent + 3);
    linear |= 0x84 << exponent;
    if (sign) linear = -linear;
    
    // Convert to 16-bit signed integer
    const sample = Math.max(-32768, Math.min(32767, linear));
    linearBuffer.writeInt16LE(sample, i * 2);
  }
  
  return linearBuffer;
}

/**
 * Get human-readable meaning of WebSocket close codes
 */
function getCloseCodeMeaning(code: number): string {
  const codes: Record<number, string> = {
    1000: 'Normal Closure',
    1001: 'Going Away',
    1002: 'Protocol Error',
    1003: 'Unsupported Data',
    1006: 'Abnormal Closure',
    1007: 'Invalid Data',
    1008: 'Policy Violation',
    1009: 'Message Too Big',
    1011: 'Internal Error',
  };
  return codes[code] || `Unknown (${code})`;
}

