import { requestJson, TransportError } from './http.js';
import { maskPhone } from './util.js';

/** Meta template body limit at send time, and the hard text-message limit. */
export const TEMPLATE_BODY_PARAM_MAX = 1024;
export const TEXT_BODY_MAX = 4096;

/** Meta Cloud API error codes worth explaining in plain language. */
const ERROR_HINTS = {
  4: 'The app has hit its WhatsApp messaging rate limit. Back off and retry, or raise the tier by improving quality rating and completing business verification.',
  100: 'Meta rejected a request parameter. Read error_data.details — it names the exact field that failed.',
  131026: 'The recipient cannot receive this message. Usually the number is not on WhatsApp, or it has not accepted the business or opted in.',
  131047: 'The 24-hour customer service window is closed. Only an approved template can be sent to this recipient now.',
  131056: 'Too many messages to this recipient in a short period (pair rate limit). Slow down.',
  131031: 'The business account is restricted or locked. Check Meta Business Support.',
  132000: 'The number of template parameters does not match the approved template. Compare WHATSAPP_TEMPLATE_NAME with the template in WhatsApp Manager.',
  132001: 'The template name or language code does not exist for this WhatsApp Business Account. Check the name, the language, and that it is approved.',
  132005: 'A template parameter is too long. Each body parameter is limited to 1024 characters.',
  132007: 'The template is paused or disabled for policy reasons. Review it in WhatsApp Manager.',
  132012: 'A template parameter contains a newline or tab, or has leading/trailing spaces. Template parameters must be a single line.',
  133010: 'The phone number is not registered with the Cloud API. Finish number setup in WhatsApp Manager.',
  190: 'The access token is invalid or expired. Generate a new token from the Meta System User and update META_ACCESS_TOKEN in Render.',
  368: 'The account is temporarily blocked for a policy violation. Review the WhatsApp Business Policy.',
  80007: 'The messaging limit for this phone number has been reached. Wait for the rolling 24-hour window to reset.',
  130429: 'The Cloud API throughput limit for this phone number was reached. Retry after the back-off period.',
};

export class WhatsAppError extends Error {
  constructor(message, { code, subcode, type, fbtraceId, status, retryable = false, details } = {}) {
    super(message);
    this.name = 'WhatsAppError';
    this.code = code;
    this.subcode = subcode;
    this.type = type;
    this.fbtraceId = fbtraceId;
    this.status = status;
    this.retryable = retryable;
    this.details = details;
    this.hint = code !== undefined ? ERROR_HINTS[code] : undefined;
  }
}

function assertBodyParam(value, position) {
  const text = String(value ?? '');
  if (!text.trim()) {
    throw new WhatsAppError(`Template body parameter ${position} is empty; Meta rejects empty parameters.`);
  }
  if (/[\n\r\t]/.test(text)) {
    throw new WhatsAppError(
      `Template body parameter ${position} contains a newline or tab. Meta rejects multi-line template parameters (error 132012). Flatten it to one line or use the link delivery mode.`,
    );
  }
  if (text !== text.trim()) {
    throw new WhatsAppError(`Template body parameter ${position} has leading or trailing whitespace; Meta rejects that.`);
  }
  if (text.length > TEMPLATE_BODY_PARAM_MAX) {
    throw new WhatsAppError(
      `Template body parameter ${position} is ${text.length} characters; Meta allows ${TEMPLATE_BODY_PARAM_MAX}.`,
    );
  }
  return text;
}

export function createWhatsAppClient({ config, logger, http = requestJson }) {
  const messagesUrl = () => `${config.graphBaseUrl}/${config.phoneNumberId}/messages`;
  const authHeaders = () => ({
    Authorization: `Bearer ${config.accessToken}`,
    'Content-Type': 'application/json',
  });

  function mapFailure(response, label) {
    const error = response?.data?.error ?? {};
    const code = typeof error.code === 'number' ? error.code : undefined;
    const message = error.message
      ? `WhatsApp API rejected ${label} (${response.status}, code ${code ?? 'unknown'}): ${error.message}`
      : `WhatsApp API rejected ${label} with HTTP ${response.status}.`;
    return new WhatsAppError(message, {
      code,
      subcode: error.error_subcode,
      type: error.type,
      fbtraceId: error.fbtrace_id,
      status: response?.status,
      retryable: response?.retryable === true,
      details: error.error_data?.details,
    });
  }

  async function post(payload, label) {
    let response;
    try {
      response = await http(messagesUrl(), {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify(payload),
        timeoutMs: config.metaTimeoutMs,
        maxRetries: config.metaMaxRetries,
        label,
      });
    } catch (error) {
      if (error instanceof TransportError) {
        throw new WhatsAppError(`WhatsApp API unreachable while ${label}: ${error.message}`, { retryable: true });
      }
      throw error;
    }

    if (!response.ok) throw mapFailure(response, label);

    const messageId = response.data?.messages?.[0]?.id;
    if (!messageId) {
      throw new WhatsAppError(
        `Meta returned HTTP ${response.status} while ${label} but no message id. Treating this as unconfirmed, not delivered.`,
        { status: response.status },
      );
    }
    return { messageId, wamid: messageId, accepted: true, raw: response.data };
  }

  return {
    /**
     * Send an approved template. `bodyParams` fills {{1}}..{{n}} in order and
     * must be single-line strings of at most 1024 characters.
     * `urlButtonSuffix` fills the dynamic URL button's variable.
     */
    async sendTemplate({ to = config.recipientNumber, name = config.templateName, language = config.templateLanguage, bodyParams = [], urlButtonSuffix, buttonIndex = config.templateUrlButtonIndex } = {}) {
      const params = bodyParams.map((value, index) => assertBodyParam(value, index + 1));
      const components = [];

      if (params.length > 0) {
        components.push({ type: 'body', parameters: params.map((text) => ({ type: 'text', text })) });
      }
      if (urlButtonSuffix !== undefined && urlButtonSuffix !== null && String(urlButtonSuffix) !== '') {
        const suffix = String(urlButtonSuffix);
        if (!/^[A-Za-z0-9_-]{1,200}$/.test(suffix)) {
          throw new WhatsAppError('The URL button suffix must be 1–200 URL-safe characters (A–Z, a–z, 0–9, "-", "_").');
        }
        components.push({
          type: 'button',
          sub_type: 'url',
          index: String(buttonIndex),
          parameters: [{ type: 'text', text: suffix }],
        });
      }

      const payload = {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'template',
        template: {
          name,
          language: { code: language },
          ...(components.length ? { components } : {}),
        },
      };

      logger.info('Sending WhatsApp template', {
        to: maskPhone(to),
        template: name,
        language,
        bodyParams: params.length,
        urlButton: Boolean(urlButtonSuffix),
      });
      return post(payload, 'template send');
    },

    /** Send a free-form text message. Only valid inside an open 24-hour window. */
    async sendText({ to = config.recipientNumber, body, previewUrl = false } = {}) {
      const text = String(body ?? '');
      if (!text.trim()) throw new WhatsAppError('Refusing to send an empty text message.');
      if (text.length > TEXT_BODY_MAX) {
        throw new WhatsAppError(
          `Text body is ${text.length} characters; WhatsApp allows ${TEXT_BODY_MAX} per message. Split it with chunkText().`,
        );
      }
      const payload = {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'text',
        text: { body: text, preview_url: Boolean(previewUrl) },
      };
      logger.info('Sending WhatsApp text message', { to: maskPhone(to), length: text.length });
      return post(payload, 'text send');
    },

    /** Mark an inbound message as read. Best effort; never throws. */
    async markRead(messageId) {
      try {
        await http(messagesUrl(), {
          method: 'POST',
          headers: authHeaders(),
          body: JSON.stringify({ messaging_product: 'whatsapp', status: 'read', message_id: messageId }),
          timeoutMs: config.metaTimeoutMs,
          maxRetries: 0,
          label: 'mark read',
        });
        return true;
      } catch (error) {
        logger.warn('Could not mark message as read', { reason: error.message });
        return false;
      }
    },

    /** The business number behind WHATSAPP_PHONE_NUMBER_ID, used for the self-send guard. */
    async getDisplayPhoneNumber() {
      const url = `${config.graphBaseUrl}/${config.phoneNumberId}?fields=display_phone_number,verified_name`;
      const response = await http(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${config.accessToken}` },
        timeoutMs: config.metaTimeoutMs,
        maxRetries: config.metaMaxRetries,
        label: 'phone number lookup',
      });
      if (!response.ok) throw mapFailure(response, 'phone number lookup');
      return {
        displayPhoneNumber: response.data?.display_phone_number ?? null,
        verifiedName: response.data?.verified_name ?? null,
      };
    },
  };
}
