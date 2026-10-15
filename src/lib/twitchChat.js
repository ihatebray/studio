/* Reading a Twitch channel's chat, for Streamer Mode's song requests.
 *
 * Twitch chat is IRC over a WebSocket, and anyone may read a channel's chat
 * without signing in: the "justinfan" nicknames are Twitch's own anonymous
 * logins, the ones chat overlays use. So Studio needs no Twitch account to
 * hear !sr; it can't post, and sees only what's public in the chat.
 *
 * The tags capability adds each message's badges, which is how a request
 * from a mod, a sub or the broadcaster is told apart. Dropped connections
 * come back on their own, waiting a little longer each time.
 */

const CHAT_URL = 'wss://irc-ws.chat.twitch.tv:443';

function parseTags(raw) {
  const tags = {};
  for (const part of String(raw || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) tags[part.slice(0, i)] = part.slice(i + 1);
  }
  return tags;
}

/** A channel name from whatever was typed: "name", "#name" or a twitch.tv link. */
export function twitchChannelOf(text) {
  const s = String(text || '').trim().replace(/^https?:\/\/(www\.)?twitch\.tv\//i, '').replace(/^#/, '').split(/[/?#\s]/)[0];
  return /^[a-z0-9_]{3,25}$/i.test(s) ? s.toLowerCase() : '';
}

/**
 * Listen to a channel's chat.
 * @param {string} channel  the channel name, lowercase
 * @param {{ onMessage: (m: { text: string, user: object }) => void, onStatus?: (s: string) => void }} handlers
 *   onStatus gets 'connecting' | 'listening' | 'reconnecting'.
 * @returns {{ close: () => void }}
 */
export function connectTwitchChat(channel, { onMessage, onStatus }) {
  let ws = null;
  let closed = false;
  let tries = 0;
  let retryTimer = null;

  const handle = (line) => {
    if (!line) return;
    if (line.startsWith('PING')) { try { ws.send('PONG :tmi.twitch.tv'); } catch { /* reconnects */ } return; }
    let rest = line;
    let tags = {};
    if (rest.startsWith('@')) {
      const sp = rest.indexOf(' ');
      tags = parseTags(rest.slice(1, sp));
      rest = rest.slice(sp + 1);
    }
    // Joined: Twitch confirms with the end of the names list.
    if (/^:\S+ 366 /.test(rest)) { tries = 0; onStatus?.('listening'); return; }
    if (/^:\S+ RECONNECT/.test(rest)) { try { ws.close(); } catch { /* ignore */ } return; }
    const m = /^:([^!\s]+)!\S+ PRIVMSG #\S+ :(.*)$/.exec(rest);
    if (!m) return;
    const badges = String(tags.badges || '');
    const login = m[1].toLowerCase();
    onMessage?.({
      text: m[2],
      user: {
        login,
        name: tags['display-name'] || m[1],
        broadcaster: /(^|,)broadcaster\//.test(badges) || login === channel,
        mod: tags.mod === '1' || /(^|,)moderator\//.test(badges),
        vip: /(^|,)vip\//.test(badges),
        sub: tags.subscriber === '1' || /(^|,)(subscriber|founder)\//.test(badges),
      },
    });
  };

  const open = () => {
    if (closed) return;
    onStatus?.(tries ? 'reconnecting' : 'connecting');
    try {
      ws = new WebSocket(CHAT_URL);
    } catch {
      retry();
      return;
    }
    ws.onopen = () => {
      ws.send('CAP REQ :twitch.tv/tags twitch.tv/commands');
      ws.send(`NICK justinfan${10000 + Math.floor(Math.random() * 89999)}`);
      ws.send(`JOIN #${channel}`);
    };
    ws.onmessage = (e) => { for (const line of String(e.data).split('\r\n')) handle(line); };
    ws.onclose = () => { if (!closed) retry(); };
    ws.onerror = () => { /* onclose follows */ };
  };

  const retry = () => {
    if (closed) return;
    onStatus?.('reconnecting');
    const wait = Math.min(30000, 1000 * 2 ** tries);
    tries += 1;
    retryTimer = setTimeout(open, wait);
  };

  open();
  return {
    close() {
      closed = true;
      clearTimeout(retryTimer);
      try { ws?.close(); } catch { /* ignore */ }
    },
  };
}
