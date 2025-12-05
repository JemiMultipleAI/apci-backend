import { env } from '../config/env';
import twilio from 'twilio';

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

