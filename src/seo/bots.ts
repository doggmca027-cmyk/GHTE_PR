// The crawlers that are given the finished page (middleware.ts): search engines, link previews and the AI crawlers that read a page without running its
// JavaScript. The test is made in the code of the middleware (Vercel's `matcher` outside Next.js knows paths only, not the User-Agent).

export const BOT_AGENTS: readonly string[] = [
  // search engines
  'Googlebot', 'Google-InspectionTool', 'bingbot', 'BingPreview', 'Applebot', 'DuckDuckBot', 'YandexBot', 'Baiduspider',
  // link previews (Telegram, Facebook, X, LinkedIn, Slack, WhatsApp, Discord)
  'TelegramBot', 'facebookexternalhit', 'Twitterbot', 'LinkedInBot', 'Slackbot', 'WhatsApp', 'Discordbot',
  // AI crawlers and assistants
  'GPTBot', 'ChatGPT-User', 'OAI-SearchBot', 'PerplexityBot', 'ClaudeBot', 'Claude-User', 'Claude-SearchBot', 'anthropic-ai', 'Amazonbot', 'CCBot', 'cohere-ai', 'meta-externalagent',
]

const PATTERN = new RegExp(BOT_AGENTS.map((a) => a.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')).join('|'), 'i')

/** Is this User-Agent one of the crawlers above? */
export const isBot = (userAgent: string | null | undefined): boolean => Boolean(userAgent) && PATTERN.test(userAgent!)
