import type { User } from 'grammy/types';
import type { TelegramUserInfo } from '../domain/users';

export const userInfo = (user: User): TelegramUserInfo => ({
  telegramUserId: user.id,
  firstName: user.first_name,
  username: user.username ?? null,
  languageCode: user.language_code ?? null,
});
