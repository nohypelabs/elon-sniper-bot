/**
 * Send a live preview of the settings menu to the Telegram chat (Stage 12B).
 *
 * Run on the server: node --import tsx scripts/send-menu-preview.ts
 * The running bot then handles the taps.
 *
 * Prints ONLY "sent message_id=<n>" or the Telegram error description.
 * Never prints the token, the chat id, or the request URL.
 */
import axios from 'axios';
import { CONFIG } from '../src/config';
import { renderMain } from '../src/telegram/config-menu';

async function main(): Promise<void> {
  const token = CONFIG.TELEGRAM_BOT_TOKEN;
  const chatId = CONFIG.TELEGRAM_CHAT_ID;
  if (!token || !chatId) {
    console.error('Telegram is not configured');
    process.exit(1);
  }
  try {
    const screen = renderMain(CONFIG as unknown as Record<string, unknown>);
    const resp = await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
      chat_id: chatId,
      text: screen.text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: { inline_keyboard: screen.keyboard },
    });
    console.log(`sent message_id=${resp.data?.result?.message_id}`);
  } catch (e) {
    // Print only the Telegram error description: axios messages embed the
    // request URL (which contains the bot token), so never print them.
    const data = axios.isAxiosError(e)
      ? (e.response?.data as { description?: unknown } | undefined)
      : undefined;
    const desc = typeof data?.description === 'string' && data.description.length > 0
      ? data.description
      : 'send failed';
    console.error(desc);
    process.exit(1);
  }
}

void main();
