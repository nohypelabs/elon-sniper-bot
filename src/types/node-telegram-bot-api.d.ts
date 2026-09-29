// The package ships no typings; the bot only uses it loosely.
declare module 'node-telegram-bot-api' {
  class TelegramBot {
    constructor(token: string, options?: Record<string, unknown>);
    [method: string]: any;
  }
  export default TelegramBot;
}
