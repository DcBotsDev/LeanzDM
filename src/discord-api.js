import { config } from "./config.js";

const API_BASE = "https://discord.com/api/v10";
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class DiscordApiError extends Error {
  constructor(status, body, path) {
    const code = body && typeof body === "object" ? body.code : undefined;
    const apiMessage =
      body && typeof body === "object" ? body.message : undefined;
    super(
      `Discord API ${status}${code ? ` / ${code}` : ""}${
        apiMessage ? `: ${apiMessage}` : ""
      }`,
    );
    this.name = "DiscordApiError";
    this.status = status;
    this.code = code;
    this.body = body;
    this.path = path;
  }
}

export async function discordApi(path, options = {}, retries = 5) {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bot ${config.botToken}`,
      "Content-Type": "application/json",
      "User-Agent": "DiscordBot (User Install DM App, 1.0.0)",
      ...(options.headers ?? {}),
    },
  });

  const text = await response.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }

  if (response.status === 429 && retries > 0) {
    const retryAfterMs = Math.max(
      1000,
      Math.ceil(Number(body?.retry_after ?? 1) * 1000),
    );
    await wait(retryAfterMs);
    return discordApi(path, options, retries - 1);
  }

  if (response.status >= 500 && retries > 0) {
    await wait(Math.min(1000 * 2 ** (5 - retries), 10_000));
    return discordApi(path, options, retries - 1);
  }

  if (!response.ok) throw new DiscordApiError(response.status, body, path);
  return body;
}

function splitMessage(content, maxLength = 2000) {
  if (content.length <= maxLength) return [content];

  const chunks = [];
  let rest = content;

  while (rest.length > maxLength) {
    let splitAt = rest.lastIndexOf("\n", maxLength);
    if (splitAt < maxLength / 2) splitAt = rest.lastIndexOf(" ", maxLength);
    if (splitAt < maxLength / 2) splitAt = maxLength;

    chunks.push(rest.slice(0, splitAt).trimEnd());
    rest = rest.slice(splitAt).trimStart();
  }

  if (rest) chunks.push(rest);
  return chunks;
}

export async function sendDm(userId) {
  const channel = await discordApi("/users/@me/channels", {
    method: "POST",
    body: JSON.stringify({ recipient_id: userId }),
  });

  for (const chunk of splitMessage(config.dmMessage)) {
    await discordApi(`/channels/${channel.id}/messages`, {
      method: "POST",
      body: JSON.stringify({
        content: chunk,
        allowed_mentions: { parse: [] },
      }),
    });
  }
}

export async function editInteractionReply(interaction, content) {
  const response = await fetch(
    `${API_BASE}/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`,
    {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "DiscordBot (User Install DM App, 1.0.0)",
      },
      body: JSON.stringify({
        content,
        allowed_mentions: { parse: [] },
      }),
    },
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(
      `Interaction-Antwort fehlgeschlagen (${response.status}): ${body}`,
    );
  }
}
