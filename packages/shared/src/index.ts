import { z } from 'zod';

export const AGENT_NAME = 'OutOfOffice';
export const idSchema = z.uuid();
export const textSchema = z.string().trim().min(1).max(4000);
export const agentInputSchema = z.object({
  displayName: z.string().trim().min(2).max(60).default(AGENT_NAME),
  ownerName: z.string().trim().min(1).max(80),
  allowedTopics: z.array(z.string().trim().min(2).max(80)).min(1).max(20),
  prohibitedTopics: z.array(z.string().trim().min(2).max(80)).max(20).default([]),
}).strict();
export type AgentInput = z.infer<typeof agentInputSchema>;
export type Agent = AgentInput & { id: string; ownerId: string; createdAt: string };

export const factInputSchema = z.object({
  title: z.string().trim().min(2).max(120),
  topic: z.string().trim().min(2).max(80),
  text: textSchema,
  approved: z.boolean().default(false),
  sensitivity: z.enum(['PRIVATE', 'MEETING']).default('PRIVATE'),
  validUntil: z.iso.datetime().nullable().default(null),
}).strict();
export type FactInput = z.infer<typeof factInputSchema>;
export type Fact = FactInput & {
  id: string; ownerId: string; agentId: string; version: number; updatedAt: string;
};

export const meetingInputSchema = z.object({
  agentId: idSchema,
  title: z.string().trim().min(2).max(120),
  provider: z.enum(['local', 'attendee']).default('local'),
  meetingUrl: z.string().transform((value, context) => {
    try { return parseMeetUrl(value); } catch { context.addIssue({ code: 'custom', message: 'Expected an authorized Google Meet HTTPS URL.' }); return z.NEVER; }
  }).optional(),
  participantsConsented: z.literal(true).optional(),
  providerDataAccepted: z.literal(true).optional(),
  maxDurationSeconds: z.number().int().min(30).max(900).default(300),
  sourceIds: z.array(idSchema).min(1).max(30),
  ownerAuthorized: z.literal(true),
}).strict().superRefine((input, context) => {
  if (input.provider === 'attendee' && (!input.meetingUrl || !input.participantsConsented || !input.providerDataAccepted)) context.addIssue({ code: 'custom', message: 'Hosted dispatch requires a Meet URL, participant consent and acceptance of provider data handling.' });
  if (input.provider === 'local' && (input.meetingUrl || input.participantsConsented || input.providerDataAccepted)) context.addIssue({ code: 'custom', message: 'Provider fields require provider=attendee.' });
});
export type MeetingInput = z.infer<typeof meetingInputSchema>;
export type MeetingStatus = 'ACTIVE' | 'COMPLETED' | 'REVOKED' | 'EXPIRED' | 'DISCONNECTED';
export type SpeechState = 'READY' | 'MUTED' | 'BLOCKED';
export type Meeting = {
  id: string; ownerId: string; agentId: string; title: string; provider: 'local' | 'attendee';
  status: MeetingStatus; speechState: SpeechState; sourceIds: string[];
  maxDurationSeconds: number; startedAt: string; endedAt: string | null;
  grantVersion: number; epoch: number; idempotencyKey: string;
};
export const utteranceInputSchema = z.object({
  eventId: z.string().trim().min(1).max(100),
  speaker: z.string().trim().min(1).max(80),
  text: textSchema,
  origin: z.enum(['participant', 'delegate']).default('participant'),
}).strict();
export type UtteranceInput = z.infer<typeof utteranceInputSchema>;
export type DecisionKind = 'IGNORE' | 'ANSWER' | 'DEFER';
export type Evidence = { sourceId: string; version: number; title: string; excerpt: string; updatedAt: string };
export type Decision = {
  kind: DecisionKind; reason: string; text: string | null; evidence: Evidence[];
};
export type ResponseRecord = Decision & {
  id: string; meetingId: string; eventId: string; speaker: string; question: string;
  epoch: number; grantVersion: number; createdAt: string;
  playbackStatus: 'NOT_SPOKEN' | 'AUTHORIZED' | 'TRANSMITTED' | 'INTERRUPTED' | 'CANCELLED' | 'FAILED';
};
export type TranscriptEntry = UtteranceInput & { receivedAt: string };
export type SessionRecord = {
  meeting: Meeting; transcript: TranscriptEntry[]; responses: ResponseRecord[]; followUps: FollowUp[];
};
export type FollowUp = {
  id: string; meetingId: string; responseId: string; question: string; reason: string;
  status: 'pending' | 'resolved' | 'dismissed'; ownerResponse: string | null;
};
export type EventEnvelope = {
  eventId: string; meetingId: string; occurredAt: string; type: string; payload: unknown;
};
export type HostedAttempt = {
  meetingId: string; ownerId: string; meetingUrl: string; botName: string; botId: string | null;
  state: 'PREPARED' | 'CREATING' | 'UNCERTAIN' | 'TRACKING' | 'STOPPING' | 'ENDED';
  providerState: string; capabilityHash: string | null; consentAt: string; updatedAt: string;
  lastStateAt: string | null; speechCalls: number; lastError: string | null;
  deletion: 'not_requested' | 'pending' | 'confirmed';
};
export const isActive = (meeting: Meeting) => meeting.status === 'ACTIVE';

export function parseMeetUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.hostname !== 'meet.google.com' ||
      url.username || url.password || url.port || !/^\/[a-z]{3}-[a-z]{4}-[a-z]{3}\/?$/.test(url.pathname)) {
    throw new Error('Expected a Google Meet HTTPS meeting URL.');
  }
  url.search = '';
  url.hash = '';
  return url.toString();
}
