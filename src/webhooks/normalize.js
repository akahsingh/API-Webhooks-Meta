'use strict';

/**
 * Turns raw Meta webhook payloads into compact, uniform event records.
 *
 * Only identifiers and metadata are extracted by default. Message text,
 * usernames, profile names and media captions are captured only when
 * INCLUDE_MESSAGE_CONTENT=true because those fields contain personal data.
 */

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function pick(object, keys) {
  if (!isObject(object)) return null;
  const out = {};
  let found = false;
  for (const key of keys) {
    if (object[key] !== undefined && object[key] !== null) {
      out[key] = object[key];
      found = true;
    }
  }
  return found ? out : null;
}

function messageTypeOf(message) {
  if (!isObject(message)) return 'unknown';
  return message.type || (message.mid ? 'messenger' : 'unknown');
}

function attachmentTypesOf(message) {
  return asArray(message && message.attachments)
    .map((attachment) => attachment && attachment.type)
    .filter(Boolean);
}

function messagingEvent(product, entry, messaging, kind, includeContent) {
  const message = isObject(messaging) ? messaging.message : undefined;
  const sender = isObject(messaging) ? messaging.sender : undefined;
  const recipient = isObject(messaging) ? messaging.recipient : undefined;

  const event = {
    product,
    kind,
    field: 'messages',
    entryId: (entry && entry.id) || null,
    entryTime: (entry && entry.time) || null,
    messageId: (message && message.mid) || null,
    senderId: (sender && sender.id) || null,
    recipientId: (recipient && recipient.id) || null,
    messageType: messageTypeOf(message),
    attachmentTypes: attachmentTypesOf(message),
    isEcho: Boolean(message && message.is_echo),
    isSelf: Boolean(message && message.is_self),
    isDeleted: Boolean(message && message.is_deleted),
    delivery: pick(messaging && messaging.delivery, ['mids', 'watermark', 'seq']),
    read: pick(messaging && messaging.read, ['watermark']),
    postbackPayload: (messaging && messaging.postback && messaging.postback.payload) || null,
    content: includeContent && message ? message.text || null : null,
  };

  if (includeContent) {
    event.senderName = null;
    event.attachments = (message && message.attachments) || null;
  }

  return event;
}

function normalizePagesEntry(entry, includeContent) {
  const events = [];

  for (const change of asArray(entry.changes)) {
    const value = isObject(change) ? change.value || {} : {};
    const from = isObject(value.from) ? value.from : {};

    events.push({
      product: 'pages',
      kind: 'change',
      field: (change && change.field) || null,
      entryId: entry.id || null,
      entryTime: entry.time || null,
      item: value.item || null,
      verb: value.verb || null,
      postId: value.post_id || null,
      commentId: value.comment_id || null,
      parentId: value.parent_id || null,
      senderId: from.id || value.sender_id || null,
      isHidden: value.is_hidden === undefined ? null : value.is_hidden,
      createdTime: value.created_time || null,
      content: includeContent ? value.message || value.text || null : null,
    });
  }

  for (const messaging of asArray(entry.messaging)) {
    events.push(messagingEvent('pages', entry, messaging, 'messaging', includeContent));
  }

  return events;
}

function normalizeInstagramEntry(entry, includeContent) {
  const events = [];

  for (const change of asArray(entry.changes)) {
    const value = isObject(change) ? change.value || {} : {};
    const from = isObject(value.from) ? value.from : {};
    const media = isObject(value.media) ? value.media : {};
    const field = (change && change.field) || null;

    let kind = 'change';
    if (field === 'comments' || field === 'live_comments') kind = 'comment';
    else if (field === 'mentions') kind = 'mention';
    else if (field === 'story_insights') kind = 'insight';

    events.push({
      product: 'instagram',
      kind,
      field,
      entryId: entry.id || null,
      entryTime: entry.time || null,
      commentId: value.id || value.comment_id || null,
      mediaId: media.id || value.media_id || null,
      mediaProductType: media.media_product_type || null,
      parentId: value.parent_id || null,
      senderId: from.id || null,
      senderUsername: includeContent ? from.username || null : null,
      content: includeContent ? value.text || null : null,
      metrics: kind === 'insight' ? value : null,
    });
  }

  for (const messaging of asArray(entry.messaging)) {
    events.push(messagingEvent('instagram', entry, messaging, 'messaging', includeContent));
  }

  for (const standby of asArray(entry.standby)) {
    events.push(messagingEvent('instagram', entry, standby, 'standby', includeContent));
  }

  return events;
}

function whatsAppContentOf(message) {
  if (!isObject(message)) return null;
  const type = message.type;

  if (type === 'text' && isObject(message.text)) return message.text.body || null;
  if (type === 'button' && isObject(message.button)) return message.button.text || null;
  if (type === 'reaction' && isObject(message.reaction)) {
    return message.reaction.emoji || null;
  }
  if (type === 'interactive' && isObject(message.interactive)) {
    const buttonReply = message.interactive.button_reply;
    const listReply = message.interactive.list_reply;
    if (isObject(buttonReply)) return buttonReply.title || null;
    if (isObject(listReply)) return listReply.title || null;
    return null;
  }
  if (isObject(message[type])) {
    return message[type].caption || message[type].filename || null;
  }
  return null;
}

function normalizeWhatsAppEntry(entry, includeContent) {
  const events = [];

  for (const change of asArray(entry.changes)) {
    const value = isObject(change) ? change.value || {} : {};
    const metadata = isObject(value.metadata) ? value.metadata : {};
    const field = (change && change.field) || null;

    const base = {
      product: 'whatsapp',
      field,
      wabaId: entry.id || null,
      entryTime: entry.time || null,
      phoneNumberId: metadata.phone_number_id || null,
      displayPhoneNumber: includeContent ? metadata.display_phone_number || null : null,
    };

    for (const message of asArray(value.messages)) {
      events.push({
        ...base,
        kind: 'message',
        messageId: message.id || null,
        senderId: message.from || null,
        messageType: message.type || 'unknown',
        timestamp: message.timestamp || null,
        content: includeContent ? whatsAppContentOf(message) : null,
      });
    }

    for (const status of asArray(value.statuses)) {
      events.push({
        ...base,
        kind: 'status',
        messageId: status.id || null,
        senderId: null,
        recipientId: status.recipient_id || null,
        status: status.status || null,
        timestamp: status.timestamp || null,
        conversationId: (status.conversation && status.conversation.id) || null,
        pricingCategory: (status.pricing && status.pricing.category) || null,
        errors: asArray(status.errors).map((error) => pick(error, ['code', 'title', 'error_data'])),
      });
    }

    for (const error of asArray(value.errors)) {
      events.push({
        ...base,
        kind: 'error',
        errors: [pick(error, ['code', 'title', 'error_data', 'href'])],
      });
    }

    const hasMessages = asArray(value.messages).length > 0;
    const hasStatuses = asArray(value.statuses).length > 0;
    const hasErrors = asArray(value.errors).length > 0;

    // Account, template and quality notifications such as
    // message_template_status_update, phone_number_quality_update, account_update,
    // account_alerts and security alerts.
    if (!hasMessages && !hasStatuses && !hasErrors) {
      events.push({
        ...base,
        kind: 'change',
        timestamp: entry.time || null,
        details: pick(value, [
          'event',
          'message_template_id',
          'message_template_name',
          'message_template_language',
          'reason',
          'current_limit',
          'old_limit',
          'restriction_info',
          'ban_info',
          'alert_type',
          'alert_severity',
          'description',
          'entity_type',
          'violation_type',
        ]),
      });
    }

    if (includeContent && asArray(value.contacts).length > 0) {
      const contact = value.contacts[0] || {};
      events.push({
        ...base,
        kind: 'contact',
        senderId: contact.wa_id || null,
        senderName: (contact.profile && contact.profile.name) || null,
      });
    }
  }

  return events;
}

const NORMALIZERS = {
  pages: normalizePagesEntry,
  whatsapp: normalizeWhatsAppEntry,
  instagram: normalizeInstagramEntry,
};

function normalizePayload(product, payload, options) {
  const includeContent = Boolean(options && options.includeContent);
  const normalizeEntry = NORMALIZERS[product];
  if (!normalizeEntry) return [];

  const events = [];
  for (const entry of asArray(payload && payload.entry)) {
    if (!isObject(entry)) continue;
    for (const event of normalizeEntry(entry, includeContent)) {
      events.push(event);
    }
  }
  return events;
}

// Counts events per kind/field so each delivery can be logged as one line.
function summarizeEvents(events) {
  const summary = {};
  for (const event of events) {
    const key = event.field ? `${event.kind}:${event.field}` : event.kind;
    summary[key] = (summary[key] || 0) + 1;
  }
  return summary;
}

module.exports = { normalizePayload, summarizeEvents };