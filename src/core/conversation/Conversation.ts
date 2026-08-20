/**
 * core/conversation/Conversation.ts
 */

import { randomUuid } from '@/core/util/encoding';

export interface Conversation {
  readonly conversation_id: string;
  readonly participants: string[]; // UniversalIdentityRef.id
  readonly created_at: number;
  readonly last_message_at?: number;
  readonly topic?: string;
}

export interface CreateConversationInput {
  conversation_id?: string;
  participants: string[];
  topic?: string;
}

export function createConversation(input: CreateConversationInput): Conversation {
  if (input.participants.length < 2) {
    throw new Error('Conversation requires at least 2 participants');
  }
  const now = Date.now();
  return {
    conversation_id: input.conversation_id ?? randomUuid(),
    participants: input.participants,
    created_at: now,
    last_message_at: now,
    topic: input.topic,
  };
}

export function touch(conversation: Conversation, ts: number = Date.now()): Conversation {
  return { ...conversation, last_message_at: ts };
}
