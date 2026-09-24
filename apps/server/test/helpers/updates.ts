import type { Chat, Update, User } from 'grammy/types';

let updateId = 1000;
let messageId = 500;

export const tgUser = (id: number, first_name: string, username?: string): User => ({
  id,
  is_bot: false,
  first_name,
  ...(username ? { username } : {}),
});

export const supergroup = (id: number, title = 'Chess Club'): Chat.SupergroupChat => ({
  id,
  type: 'supergroup',
  title,
});

export const privateChat = (user: User): Chat.PrivateChat => ({
  id: user.id,
  type: 'private',
  first_name: user.first_name,
});

type ReplyTarget = { from?: User; senderChat?: boolean };

export function commandUpdate(options: {
  chat: Chat.SupergroupChat | Chat.GroupChat | Chat.PrivateChat;
  from: User;
  text: string;
  replyTo?: ReplyTarget;
  threadId?: number;
}): Update {
  const command = options.text.split(' ')[0] ?? options.text;
  const base = { date: 1, chat: options.chat };
  return {
    update_id: (updateId += 1),
    message: {
      ...base,
      message_id: (messageId += 1),
      from: options.from,
      text: options.text,
      entities: [{ type: 'bot_command', offset: 0, length: command.length }],
      ...(options.threadId ? { message_thread_id: options.threadId, is_topic_message: true } : {}),
      ...(options.replyTo
        ? {
            reply_to_message: {
              ...base,
              message_id: (messageId += 1),
              ...(options.replyTo.from ? { from: options.replyTo.from } : {}),
              ...(options.replyTo.senderChat ? { sender_chat: options.chat } : {}),
              text: 'hi',
            },
          }
        : {}),
    },
  } as Update;
}

/** What Telegram sends as the user types after the bot's username in any chat's input field. */
export function inlineQueryUpdate(from: User, query = ''): Update {
  return {
    update_id: (updateId += 1),
    inline_query: { id: String(updateId), from, query, offset: '' },
  } as Update;
}

export function callbackUpdate(options: {
  from: User;
  chat: Chat.SupergroupChat;
  data: string;
  cardMessageId?: number;
}): Update {
  return {
    update_id: (updateId += 1),
    callback_query: {
      id: String(updateId),
      from: options.from,
      chat_instance: 'ci',
      data: options.data,
      message: {
        message_id: options.cardMessageId ?? 1,
        date: 1,
        chat: options.chat,
        text: 'card',
      },
    },
  } as Update;
}

export function myChatMemberUpdate(options: {
  chat: Chat.SupergroupChat | Chat.PrivateChat;
  from: User;
  oldStatus: 'left' | 'kicked' | 'member' | 'administrator';
  newStatus: 'left' | 'kicked' | 'member' | 'administrator';
  canPin?: boolean;
}): Update {
  const bot = { id: 424242, is_bot: true, first_name: 'Test Chess', username: 'TestChessBot' };
  const member = (status: string) =>
    status === 'administrator'
      ? {
          status,
          user: bot,
          can_be_edited: false,
          is_anonymous: false,
          can_manage_chat: true,
          can_delete_messages: false,
          can_manage_video_chats: false,
          can_restrict_members: false,
          can_promote_members: false,
          can_change_info: false,
          can_invite_users: false,
          can_post_stories: false,
          can_edit_stories: false,
          can_delete_stories: false,
          can_pin_messages: options.canPin ?? false,
        }
      : { status, user: bot };
  return {
    update_id: (updateId += 1),
    my_chat_member: {
      chat: options.chat,
      from: options.from,
      date: 1,
      old_chat_member: member(options.oldStatus),
      new_chat_member: member(options.newStatus),
    },
  } as Update;
}

export function chatMemberUpdate(options: {
  chat: Chat.SupergroupChat;
  from: User;
  user: User;
  newStatus: 'member' | 'left' | 'kicked' | 'administrator';
}): Update {
  return {
    update_id: (updateId += 1),
    chat_member: {
      chat: options.chat,
      from: options.from,
      date: 1,
      old_chat_member: { status: 'left', user: options.user },
      new_chat_member: { status: options.newStatus, user: options.user },
    },
  } as Update;
}

export function serviceUpdate(chat: Chat, from: User, fields: Record<string, unknown>): Update {
  return {
    update_id: (updateId += 1),
    message: { message_id: (messageId += 1), date: 1, chat, from, ...fields },
  } as Update;
}
