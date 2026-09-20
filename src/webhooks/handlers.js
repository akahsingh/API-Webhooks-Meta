'use strict';

/**
 * Default event handlers.
 *
 * Nothing is persisted and nothing is sent back to Meta. Because message text is
 * excluded unless INCLUDE_MESSAGE_CONTENT=true, only identifiers, statuses and
 * counts reach the logs. Replace or extend createEventLogger when the app needs
 * to store events, reply to customers or trigger automations.
 */

function createEventLogger(logger) {
  return async function logEvents(events, context) {
    const meta = context || {};

    for (const event of events) {
      logger.debug('Webhook event', {
        product: event.product || meta.product,
        kind: event.kind,
        field: event.field,
        entryId: event.entryId,
        messageId: event.messageId,
        commentId: event.commentId,
        postId: event.postId,
        mediaId: event.mediaId,
        status: event.status,
        messageType: event.messageType,
        senderId: event.senderId,
        timestamp: event.timestamp || event.entryTime,
      });
    }

    logger.info('Webhook events handled', {
      product: meta.product,
      deliveryHash: meta.deliveryHash,
      handled: events.length,
    });
  };
}

module.exports = { createEventLogger };