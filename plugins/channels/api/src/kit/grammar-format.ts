// A channel's own markup (Telegram's /cmd@bot, Slack's <…> and entities, Discord's <@id>), gone
// before the grammar reads a message. Re-exported by grammar.ts.

/**
 * A channel's own markup, gone before the grammar reads it. Text stays as written: an agent should
 * see what you sent, and __init__.py isn't bold. kind: 'telegram', 'slack' (its <…> and &amp;; bot:
 * its user id) or 'discord'.
 */
export function stripFormatting(text: unknown, kind = '', { bot = '' }: { bot?: string } = {}): string {
  let t = String(text ?? '').replace(/\r\n/g, '\n').replace(/[​-‍⁠﻿]/g, '').replace(/ /g, ' ').trim();
  if (kind === 'telegram') {
    t = t.replace(/^\/(\w+)@\w+/, '/$1'); // /new@wispbot
    if (bot) t = t.replace(new RegExp(`^@${bot.replace(/\W/g, '')}\\b[\\s,:]*`, 'i'), '').trim(); // @wispbot in a group
  }
  if (kind === 'slack') {
    if (bot) t = t.replace(new RegExp(`<@${bot.replace(/\W/g, '')}(?:\\|[^>]*)?>[\\s,:]*`, 'g'), '').trim();
    t = t
      .replace(/<((?:https?:\/\/|mailto:)[^>|]+)(?:\|([^>]*))?>/g, (_, url: string, label: string | undefined) => slackLink(url, label))
      .replace(/<#(\w+)(?:\|([^>]*))?>/g, (_, id: string, name: string | undefined) => `#${name || id}`)
      .replace(/<!(\w+)(?:[^>|]*)(?:\|([^>]*))?>/g, (_, what: string, label: string | undefined) => label || `@${what}`)
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&');
  }
  if (kind === 'discord') {
    if (bot) t = t.replace(new RegExp(`<@!?${bot.replace(/\D/g, '')}>[\\s,:]*`, 'g'), '').trim();
    t = t.replace(/<(https?:\/\/[^>\s]+)>/g, '$1'); // the brackets only turn its preview off
  }
  return t;
}

// Slack writes a bare example.com as a link labelled example.com. A label that says something else
// keeps its URL, so nothing is hidden from the agent.
function slackLink(url: string, label: string | undefined): string {
  const bare = url.replace(/^mailto:/, '');
  if (!label || label === url || label === bare || label === url.replace(/^https?:\/\//, '')) return label || bare;
  return `${label} (${url})`;
}
