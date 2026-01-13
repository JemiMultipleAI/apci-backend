import { env } from '../config/env';
import twilio from 'twilio';
import { logger } from '../utils/logger';
import { sendMessageToAgent } from './agentService';
import { upsertConversation, addMessageToConversation } from './conversationService';

export interface SMSOptions {
  to: string;
  message: string;
  from?: string;
  statusCallback?: string; // Webhook URL for status updates and inbound replies
}

export interface SMSResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

/**
 * Replace template variables in SMS content
 */
export const replaceTemplateVariables = (
  content: string,
  variables: Record<string, string>
): string => {
  let result = content;
  Object.entries(variables).forEach(([key, value]) => {
    const regex = new RegExp(`{{\\s*${key}\\s*}}`, 'g');
    result = result.replace(regex, value || '');
  });
  return result;
};

/**
 * Send SMS using configured provider
 */
export const sendSMS = async (options: SMSOptions): Promise<SMSResult> => {
  const provider = env.SMS_PROVIDER || 'twilio';
  const fromNumber = options.from || env.TWILIO_PHONE_NUMBER;

  try {
    if (provider === 'twilio') {
      if (!env.TWILIO_ACCOUNT_SID || !env.TWILIO_AUTH_TOKEN) {
        throw new Error('Twilio credentials are not configured');
      }

      if (!fromNumber) {
        throw new Error('Twilio phone number is not configured');
      }

      const client = twilio(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN);

      const messageOptions: any = {
        body: options.message,
        from: fromNumber,
        to: options.to,
      };

      // Note: statusCallback is for delivery status updates only, not inbound messages
      // Inbound SMS messages are handled via the webhook URL configured in Twilio dashboard
      // If you want delivery status updates, uncomment and configure:
      // if (options.statusCallback && !options.statusCallback.includes('localhost')) {
      //   messageOptions.statusCallback = options.statusCallback;
      // }

      const message = await client.messages.create(messageOptions);

      return {
        success: true,
        messageId: message.sid,
      };
    } else {
      throw new Error(`Unsupported SMS provider: ${provider}`);
    }
  } catch (error: any) {
    console.error('SMS sending error:', error);
    return {
      success: false,
      error: error.message || 'Failed to send SMS',
    };
  }
};

/**
 * Send SMS from template with variables
 */
export const sendSMSFromTemplate = async (
  to: string,
  message: string,
  variables: Record<string, string> = {},
  from?: string,
  statusCallback?: string
): Promise<SMSResult> => {
  const processedMessage = replaceTemplateVariables(message, variables);

  return sendSMS({
    to,
    message: processedMessage,
    from,
    statusCallback,
  });
};

/**
 * Send AI-generated personalized SMS
 * Uses OpenAI to generate personalized content based on campaign instructions
 */
export const sendSMSWithAI = async (
  to: string,
  instructions: string,
  contactId: string,
  accountId?: string,
  campaignId?: string,
  customIntroduction?: string
): Promise<SMSResult> => {
  try {
    logger.info('[SMS_AI] Generating personalized SMS', {
      to,
      contactId,
      accountId,
      campaignId,
      instructionsLength: instructions.length,
    });

    // Create prompt for the agent based on campaign instructions
    const agentPrompt = `Generate a personalized SMS message based on these campaign instructions:

${instructions}

Please create a friendly, professional SMS that:
- Personalizes the message based on the customer's context
- Follows the campaign instructions provided above
- Is concise (under 160 characters is ideal, but can be up to 320 characters)
- Uses appropriate tone for the campaign purpose
- Is engaging and clear

Generate only the SMS message text.`;

    // Use a placeholder agent ID for campaigns (OpenAI doesn't need a real agent ID)
    const agentId = `openai-campaign-${campaignId?.substring(0, 8) || 'default'}`;

    // Generate personalized content using the agent
    const agentResponse = await sendMessageToAgent(
      agentId,
      agentPrompt,
      undefined, // agentConfigId - not needed for campaigns
      contactId,
      accountId
    );

    if (!agentResponse.success || !agentResponse.response) {
      const error = agentResponse.error || 'Failed to generate SMS content';
      logger.error('[SMS_AI] Failed to generate SMS content', {
        contactId,
        accountId,
        error,
      });
      return {
        success: false,
        error,
      };
    }

    const smsMessage = agentResponse.response.trim();
    const messageWithIntro = customIntroduction ? `${customIntroduction}\n\n${smsMessage}` : smsMessage;

    // Truncate to SMS limits if needed (320 characters for concatenated messages)
    const finalMessage = messageWithIntro.length > 320 ? messageWithIntro.substring(0, 317) + '...' : messageWithIntro;

    // Send the generated SMS
    const result = await sendSMS({
      to,
      message: finalMessage,
    });

    // Store conversation in MongoDB if accountId and contactId are available
    if (result.success && accountId && contactId) {
      try {
        const conversation = await upsertConversation(
          contactId,
          accountId,
          'sms',
          campaignId
        );

        await addMessageToConversation(
          conversation._id.toString(),
          'assistant',
          finalMessage,
          {
            message_id: result.messageId,
            tokens_used: undefined, // Could extract from agentResponse if available
          }
        );

        logger.debug('[SMS_AI] Conversation stored in MongoDB', {
          conversationId: conversation._id,
          contactId,
        });
      } catch (error: any) {
        // Log error but don't fail the SMS send
        logger.warn('[SMS_AI] Failed to store conversation', {
          error: error.message,
          contactId,
          accountId,
        });
      }
    }

    logger.info('[SMS_AI] SMS sent successfully', {
      to,
      contactId,
      messageId: result.messageId,
    });

    return result;
  } catch (error: any) {
    logger.error('[SMS_AI] Error sending AI-generated SMS', {
      error: error.message,
      to,
      contactId,
    });
    return {
      success: false,
      error: error.message || 'Failed to send AI-generated SMS',
    };
  }
};
