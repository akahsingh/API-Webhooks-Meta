'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizePayload, summarizeEvents } = require('../src/webhooks/normalize');

const PAGES_PAYLOAD = {
  object: 'page',
  entry: [
    {
      id: 'PAGE_1',
      time: 1789000000,
      changes: [
        {
          field: 'feed',
          value: {
            item: 'comment',
            verb: 'add',
            post_id: 'PAGE_1_111',
            comment_id: 'COMMENT_1',
            parent_id: 'PAGE_1_111',
            from: { id: 'USER_1', name: 'Cinderella Hoover' },
            message: 'Where can I buy this?',
          },
        },
      ],
      messaging: [
        {
          sender: { id: 'USER_2' },
          recipient: { id: 'PAGE_1' },
          timestamp: 1789000001,
          message: {
            mid: 'm_MESSENGER_1',
            text: 'Do you deliver?',
            attachments: [{ type: 'image' }],
          },
        },
      ],
    },
  ],
};

const WHATSAPP_PAYLOAD = {
  object: 'whatsapp_business_account',
  entry: [
    {
      id: 'WABA_1',
      changes: [
        {
          field: 'messages',
          value: {
            messaging_product: 'whatsapp',
            metadata: { display_phone_number: '15550783881', phone_number_id: 'PN_1' },
            contacts: [{ profile: { name: 'Sheena Nelson' }, wa_id: '16505551234' }],
            messages: [
              {
                from: '16505551234',
                id: 'wamid.INBOUND_1',
                timestamp: '1749416383',
                type: 'text',
                text: { body: 'Does it come in another color?' },
              },
            ],
          },
        },
        {
          field: 'messages',
          value: {
            messaging_product: 'whatsapp',
            metadata: { display_phone_number: '15550783881', phone_number_id: 'PN_1' },
            statuses: [
              {
                id: 'wamid.OUTBOUND_1',
                status: 'delivered',
                timestamp: '1749416400',
                recipient_id: '16505551234',
                conversation: { id: 'CONV_1' },
                pricing: { category: 'service' },
              },
            ],
          },
        },
        {
          field: 'message_template_status_update',
          value: {
            event: 'APPROVED',
            message_template_id: '123',
            message_template_name: 'order_update',
          },
        },
      ],
    },
  ],
};

const INSTAGRAM_PAYLOAD = {
  object: 'instagram',
  entry: [
    {
      id: 'IG_USER_1',
      time: 1789000100,
      changes: [
        {
          field: 'comments',
          value: {
            id: 'IG_COMMENT_1',
            from: { id: 'IG_SENDER_1', username: 'sample_user' },
            media: { id: 'MEDIA_1', media_product_type: 'FEED' },
            text: 'Love this!',
            parent_id: 'IG_COMMENT_0',
          },
        },
        {
          field: 'mentions',
          value: { media_id: 'MEDIA_2', comment_id: 'IG_COMMENT_2' },
        },
      ],
      messaging: [
        {
          sender: { id: 'IG_SENDER_2' },
          recipient: { id: 'IG_USER_1' },
          message: { mid: 'IG_MID_1', text: 'How much is shipping?' },
        },
      ],
    },
  ],
};

test('pages payloads normalize change and Messenger events', () => {
  const events = normalizePayload('pages', PAGES_PAYLOAD, {}); 

  assert.equal(events.length, 2);

  const [comment, message] = events;
  assert.equal(comment.kind, 'change');
  assert.equal(comment.field, 'feed');
  assert.equal(comment.item, 'comment');
  assert.equal(comment.verb, 'add');
  assert.equal(comment.commentId, 'COMMENT_1');
  assert.equal(comment.postId, 'PAGE_1_111');
  assert.equal(comment.senderId, 'USER_1');
  assert.equal(comment.entryId, 'PAGE_1');
  // Message text is personal data and stays out of the default event.
  assert.equal(comment.content, null);

  assert.equal(message.kind, 'messaging');
  assert.equal(message.messageId, 'm_MESSENGER_1');
  assert.equal(message.senderId, 'USER_2');
  assert.equal(message.recipientId, 'PAGE_1');
  assert.equal(message.content, null);
  assert.deepEqual(message.attachmentTypes, ['image']);
});

test('whatsapp payloads normalize inbound messages, statuses and template updates', () => {
  const events = normalizePayload('whatsapp', WHATSAPP_PAYLOAD, {});

  assert.equal(events.length, 3);

  const [inbound, status, template] = events;
  assert.equal(inbound.kind, 'message');
  assert.equal(inbound.messageId, 'wamid.INBOUND_1');
  assert.equal(inbound.senderId, '16505551234');
  assert.equal(inbound.messageType, 'text');
  assert.equal(inbound.phoneNumberId, 'PN_1');
  assert.equal(inbound.wabaId, 'WABA_1');
  assert.equal(inbound.content, null);

  assert.equal(status.kind, 'status');
  assert.equal(status.status, 'delivered');
  assert.equal(status.messageId, 'wamid.OUTBOUND_1');
  assert.equal(status.recipientId, '16505551234');
  assert.equal(status.conversationId, 'CONV_1');
  assert.equal(status.pricingCategory, 'service');

  assert.equal(template.kind, 'change');
  assert.equal(template.field, 'message_template_status_update');
  assert.deepEqual(template.details, {
    event: 'APPROVED',
    message_template_id: '123',
    message_template_name: 'order_update',
  });
});

test('instagram payloads normalize comments, mentions and direct messages', () => {
  const events = normalizePayload('instagram', INSTAGRAM_PAYLOAD, {});

  assert.equal(events.length, 3);

  const [comment, mention, message] = events;
  assert.equal(comment.kind, 'comment');
  assert.equal(comment.commentId, 'IG_COMMENT_1');
  assert.equal(comment.mediaId, 'MEDIA_1');
  assert.equal(comment.mediaProductType, 'FEED');
  assert.equal(comment.senderId, 'IG_SENDER_1');
  assert.equal(comment.senderUsername, null);
  assert.equal(comment.entryId, 'IG_USER_1');

  assert.equal(mention.kind, 'mention');
  assert.equal(mention.mediaId, 'MEDIA_2');
  assert.equal(mention.commentId, 'IG_COMMENT_2');

  assert.equal(message.kind, 'messaging');
  assert.equal(message.messageId, 'IG_MID_1');
  assert.equal(message.senderId, 'IG_SENDER_2');
});

test('INCLUDE_MESSAGE_CONTENT=true adds message bodies and usernames', () => {
  const options = { includeContent: true };

  const pageComment = normalizePayload('pages', PAGES_PAYLOAD, options)[0];
  assert.equal(pageComment.content, 'Where can I buy this?');

  const whatsappMessage = normalizePayload('whatsapp', WHATSAPP_PAYLOAD, options)[0];
  assert.equal(whatsappMessage.content, 'Does it come in another color?');
  assert.equal(whatsappMessage.displayPhoneNumber, '15550783881');

  const instagramEvents = normalizePayload('instagram', INSTAGRAM_PAYLOAD, options);
  assert.equal(instagramEvents[0].content, 'Love this!');
  assert.equal(instagramEvents[0].senderUsername, 'sample_user');
  assert.equal(instagramEvents[2].content, 'How much is shipping?');
});

test('unknown products and empty payloads produce no events', () => {
  assert.deepEqual(normalizePayload('tiktok', PAGES_PAYLOAD, {}), []);
  assert.deepEqual(normalizePayload('pages', {}, {}), []);
  assert.deepEqual(normalizePayload('pages', { entry: 'not-an-array' }, {}), []);
  assert.deepEqual(normalizePayload('pages', null, {}), []);
});

test('summarizeEvents groups events by kind and field', () => {
  const events = normalizePayload('pages', PAGES_PAYLOAD, {});
  assert.deepEqual(summarizeEvents(events), {
    'change:feed': 1,
    'messaging:messages': 1,
  });
});