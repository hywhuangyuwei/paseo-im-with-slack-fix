/** Loosely-typed Slack wire shapes, parsed once at each transport boundary.
 * Protocol facts ported from xmanrui/dsh-im (MIT). */
import { z } from "zod";

export const slackFileSchema = z.looseObject({
  id: z.string().optional(),
  name: z.string().optional(),
  title: z.string().optional(),
  mimetype: z.string().optional(),
  size: z.number().optional(),
  url_private: z.string().optional(),
  url_private_download: z.string().optional(),
});
export type SlackFile = z.output<typeof slackFileSchema>;

export const slackEventSchema = z.looseObject({
  type: z.string().optional(),
  channel: z.string().optional(),
  channel_type: z.string().optional(),
  user: z.string().optional(),
  bot_id: z.string().optional(),
  app_id: z.string().optional(),
  subtype: z.string().optional(),
  text: z.string().optional(),
  ts: z.string().optional(),
  thread_ts: z.string().optional(),
  parent_user_id: z.string().optional(),
  files: z.array(slackFileSchema).optional(),
});
export type SlackEvent = z.output<typeof slackEventSchema>;

/** events_api envelope payload: { type: "event_callback", event, … } */
export const slackEventPayloadSchema = z.looseObject({
  type: z.string().optional(),
  event_id: z.string().optional(),
  event_time: z.number().optional(),
  api_app_id: z.string().optional(),
  event: slackEventSchema,
});
export type SlackEventPayload = z.output<typeof slackEventPayloadSchema>;

/** Socket Mode envelope: hello / events_api / interactive / disconnect. */
export const slackSocketEnvelopeSchema = z.looseObject({
  type: z.string().optional(),
  envelope_id: z.string().optional(),
  payload: z.unknown().optional(),
  connection_info: z.looseObject({ app_id: z.string().optional() }).optional(),
  reason: z.string().optional(),
});
export type SlackSocketEnvelope = z.output<typeof slackSocketEnvelopeSchema>;

/** conversations.history response (thread parent lookup). */
export const slackHistorySchema = z.looseObject({
  messages: z
    .array(
      z.looseObject({
        ts: z.string().optional(),
        user: z.string().optional(),
        bot_id: z.string().optional(),
        text: z.string().optional(),
      }),
    )
    .optional(),
});
export type SlackHistory = z.output<typeof slackHistorySchema>;

/** Every Web API call returns { ok: true, …result } once the transport layer
 * has rejected !ok payloads. */
export const slackRestResponseSchema = z.looseObject({ ok: z.literal(true) });
export type SlackRestResponse = z.output<typeof slackRestResponseSchema>;
