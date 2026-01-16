import { PassThrough } from 'stream';
import ffmpeg from 'fluent-ffmpeg';
import { logger } from './logger';

// Set FFmpeg path from installer package (if available)
try {
  const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
  ffmpeg.setFfmpegPath(ffmpegInstaller.path);
  logger.info('[AUDIO_CONVERTER] Using bundled FFmpeg from @ffmpeg-installer/ffmpeg', {
    ffmpegPath: ffmpegInstaller.path,
  });
} catch (error: any) {
  // FFmpeg installer not available, will try system FFmpeg
  logger.warn('[AUDIO_CONVERTER] @ffmpeg-installer/ffmpeg not found, using system FFmpeg', {
    error: error.message,
  });
}

/**
 * Detect if audio buffer is MP3 format (starts with ID3 tag or MP3 sync word)
 * IMPORTANT: Must avoid false positives with μ-law audio, which can also start with 0xFF
 */
export function isMp3Format(buffer: Buffer): boolean {
  if (buffer.length < 4) return false;
  
  // Check for ID3 tag (starts with "ID3")
  const id3Header = buffer.toString('ascii', 0, 3);
  if (id3Header === 'ID3') {
    logger.debug('[AUDIO_CONVERTER] Detected ID3 tag - confirmed MP3 format', {
      bufferSize: buffer.length,
      id3Header,
    });
    return true;
  }
  
  // IMPROVED: More specific MP3 sync word check to avoid false positives with μ-law
  // MP3 sync word is 0xFF followed by 0xE0-0xFF (first 11 bits must be set)
  // Also check for proper MP3 frame structure to distinguish from μ-law
  const firstByte = buffer[0];
  const secondByte = buffer[1];
  
  // MP3 sync word: 0xFF followed by 0xE0-0xFF (first 11 bits set)
  if (firstByte === 0xFF && (secondByte & 0xE0) === 0xE0) {
    // Additional check: MP3 header has version, layer, bitrate, etc.
    // This helps distinguish MP3 from μ-law which can also start with 0xFF
    if (buffer.length >= 4) {
      const thirdByte = buffer[2];
      const fourthByte = buffer[3];
      
      // MP3 frame header structure check:
      // Bits 11-13 (in third byte): MPEG version (should be 11 for MPEG-1 or 10 for MPEG-2)
      // Bits 14-15 (in third byte): Layer (should be 01 for Layer III - MP3)
      const mpegVersionBits = (thirdByte >> 3) & 0x03;
      const layerBits = (thirdByte >> 1) & 0x03;
      
      // Valid MP3: MPEG version bits should be 01 (MPEG-1) or 00 (MPEG-2), Layer should be 01 (Layer III)
      const isValidMpegVersion = mpegVersionBits === 0x01 || mpegVersionBits === 0x00;
      const isValidLayer = layerBits === 0x01; // Layer III (MP3)
      
      if (isValidMpegVersion && isValidLayer) {
        // Additional check: bitrate index should be valid (not 0000 or 1111)
        const bitrateIndex = (fourthByte >> 4) & 0x0F;
        if (bitrateIndex !== 0 && bitrateIndex !== 15) {
          logger.debug('[AUDIO_CONVERTER] Detected valid MP3 sync word and frame structure', {
            bufferSize: buffer.length,
            mpegVersion: mpegVersionBits === 0x01 ? 'MPEG-1' : 'MPEG-2',
            layer: 'Layer III (MP3)',
            bitrateIndex,
            note: 'This is likely a valid MP3 file',
          });
          return true; // Likely valid MP3
        }
      }
    }
  }
  
  // Additional heuristic: Check if buffer has too little variation (likely μ-law silence, not MP3)
  // MP3 has more variation even in compressed format
  if (buffer.length >= 100) {
    const sampleBytes = buffer.slice(0, 100);
    const uniqueBytes = new Set(sampleBytes);
    const uniqueByteCount = uniqueBytes.size;
    
    // If most bytes are the same (especially 0xFF or 0x00), it's likely μ-law silence, not MP3
    if (uniqueByteCount < 10 && (sampleBytes[0] === 0xFF || sampleBytes[0] === 0x00)) {
      logger.debug('[AUDIO_CONVERTER] Buffer too uniform to be MP3 - likely μ-law or invalid', {
        bufferSize: buffer.length,
        uniqueByteCount,
        firstByte: '0x' + buffer[0].toString(16).padStart(2, '0').toUpperCase(),
        note: 'MP3 would have more variation - this is likely μ-law audio or silence',
      });
      return false; // Too uniform to be MP3
    }
  }
  
  return false;
}

/**
 * Convert MP3 audio buffer to μ-law 8kHz format
 * Uses FFmpeg to decode MP3 and convert to μ-law
 */
export async function convertMp3ToUlaw(mp3Buffer: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const inputStream = new PassThrough();
    inputStream.end(mp3Buffer);

    const outputStream = new PassThrough();
    const chunks: Buffer[] = [];

    outputStream.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });

    outputStream.on('end', () => {
      const ulawBuffer = Buffer.concat(chunks);
      logger.info('[AUDIO_CONVERTER] MP3 to μ-law conversion completed', {
        inputSize: mp3Buffer.length,
        outputSize: ulawBuffer.length,
      });
      resolve(ulawBuffer);
    });

    outputStream.on('error', (error) => {
      logger.error('[AUDIO_CONVERTER] Output stream error during MP3 conversion', {
        error: error.message,
        stack: error.stack,
      });
      reject(error);
    });

    // Use FFmpeg to convert MP3 to μ-law 8kHz
    // Input: MP3 format
    // Output: Raw μ-law (pcm_mulaw) at 8kHz, mono
    // Note: Using 'mulaw' format outputs raw μ-law bytes (no container)
    // This is the format Twilio Media Streams expects
    ffmpeg(inputStream)
      .inputFormat('mp3')
      .audioCodec('pcm_mulaw') // μ-law codec
      .audioFrequency(8000) // 8kHz sample rate
      .audioChannels(1) // Mono
      .outputFormat('mulaw') // Raw μ-law format (no container)
      .on('start', (commandLine) => {
        logger.debug('[AUDIO_CONVERTER] FFmpeg conversion started', {
          command: commandLine,
        });
      })
      .on('error', (error) => {
        logger.error('[AUDIO_CONVERTER] FFmpeg conversion error', {
          error: error.message,
          stack: error.stack,
        });
        reject(error);
      })
      .on('end', () => {
        logger.debug('[AUDIO_CONVERTER] FFmpeg conversion ended');
      })
      .pipe(outputStream, { end: true });
  });
}

/**
 * Convert audio buffer to μ-law 8kHz format
 * Automatically detects MP3 format and converts if needed
 */
export async function ensureUlawFormat(audioBuffer: Buffer): Promise<Buffer> {
  // Check if already in μ-law format (not MP3)
  const detectedAsMp3 = isMp3Format(audioBuffer);
  
  if (!detectedAsMp3) {
    // Analyze the audio buffer to provide better diagnostics
    const sampleBytes = audioBuffer.slice(0, Math.min(20, audioBuffer.length));
    const sampleHex = Array.from(sampleBytes)
      .map(b => '0x' + b.toString(16).padStart(2, '0').toUpperCase())
      .join(' ');
    const uniqueByteCount = new Set(Array.from(audioBuffer.slice(0, Math.min(100, audioBuffer.length)))).size;
    
    logger.debug('[AUDIO_CONVERTER] Audio appears to be in correct format (not MP3)', {
      bufferSize: audioBuffer.length,
      firstBytes: sampleHex,
      uniqueByteCount,
      note: 'Assuming this is already μ-law format - will pass through without conversion',
    });
    return audioBuffer;
  }

  // Convert MP3 to μ-law
  logger.info('[AUDIO_CONVERTER] Detected MP3 format, converting to μ-law 8kHz', {
    inputSize: audioBuffer.length,
    firstBytes: Array.from(audioBuffer.slice(0, Math.min(10, audioBuffer.length)))
      .map(b => '0x' + b.toString(16).padStart(2, '0').toUpperCase())
      .join(' '),
    note: 'This should only happen if ElevenLabs returns MP3 despite requesting ulaw_8000',
  });

  try {
    const ulawBuffer = await convertMp3ToUlaw(audioBuffer);
    
    // Validate conversion result
    const outputSample = ulawBuffer.slice(0, Math.min(20, ulawBuffer.length));
    const allMax = outputSample.every(b => b === 255);
    const allZeros = outputSample.every(b => b === 0);
    
    if (allMax || allZeros || ulawBuffer.length === 0) {
      logger.error('[AUDIO_CONVERTER] ⚠️ Conversion produced invalid output', {
        inputSize: audioBuffer.length,
        outputSize: ulawBuffer.length,
        allMax,
        allZeros,
        outputSample: Array.from(outputSample.slice(0, 10))
          .map(b => '0x' + b.toString(16).padStart(2, '0').toUpperCase())
          .join(' '),
        note: 'FFmpeg conversion may have failed - output is all 0xFF or 0x00. This suggests the input was not actually MP3.',
      });
      // Don't throw - let it try anyway, but log the issue
    }
    
    return ulawBuffer;
  } catch (error: any) {
    logger.error('[AUDIO_CONVERTER] Failed to convert MP3 to μ-law', {
      error: error.message,
      stack: error.stack,
      inputSize: audioBuffer.length,
      firstBytes: Array.from(audioBuffer.slice(0, Math.min(10, audioBuffer.length)))
        .map(b => '0x' + b.toString(16).padStart(2, '0').toUpperCase())
        .join(' '),
      note: 'Conversion failed - input may not be valid MP3, or FFmpeg issue',
    });
    throw new Error(`Failed to convert MP3 to μ-law: ${error.message}`);
  }
}

