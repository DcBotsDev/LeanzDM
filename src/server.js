import "dotenv/config";
import express from "express";
import nacl from "tweetnacl";

const {
  DISCORD_PUBLIC_KEY,
  DISCORD_BOT_TOKEN,
  DM_MESSAGE = "📢 Das ist deine Announcement-Nachricht.",
  DM_DELAY_MS = "1200",
  DM_TO_OPTED_IN_USERS = "false",
  ALLOWED_USER_IDS = "",
  PORT = "10000"
} = process.env;

for (const [key, value] of Object.entries({ DISCORD_PUBLIC_KEY, DISCORD_BOT_TOKEN })) {
  if (!value) {
    console.error(`Fehlende Umgebungsvariable: ${key}`);
    process.exit(1);
  }
}

const parsedDelay = Number.parseInt(DM_DELAY_MS, 10);
const delayMs = Number.isFinite(parsedDelay)
  ? Math.min(Math.max(parsedDelay, 250), 30_000)
  : 1200;
const broadcastToGuild = String(DM_TO_OPTED_IN_USERS).toLowerCase() === "true";
const allowedUsers = new Set(
  ALLOWED_USER_IDS.split(",").map((id) => id.trim()).filter(Boolean)
);

const app = express();
const API_BASE = "https://discord.com/api/v10";
const EPHEMERAL = 1 << 6;

app.use("/interactions", express.raw({ type: "application/json", limit: "1mb" }));
app.use(express.json({ limit: "1mb" }));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function verifyDiscordRequest(req) {
  const signature = req.get("X-Signature-Ed25519");
  const timestamp = req.get("X-Signature-Timestamp");
  if (!signature || !timestamp || !Buffer.isBuffer(req.body)) return false;

  try {
    return nacl.sign.detached.verify(
      Buffer.from(timestamp + req.body.toString("utf8")),
      Buffer.from(signature, "hex"),
      Buffer.from(DISCORD_PUBLIC_KEY, "hex")
    );
  } catch {
    return false;
  }
}

function getInvokerId(interaction) {
  return interaction.member?.user?.id ?? interaction.user?.id ?? null;
}

function getTargetUser(interaction) {
  const option = interaction.data?.options?.find((item) => item.name === "user");
  if (!option?.value) return null;
  const resolved = interaction.data?.resolved?.users?.[option.value];
  return resolved ? { id: option.value, ...resolved } : { id: option.value };
}

async function discordApi(path, options = {}, retries = 4) {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bot ${DISCORD_BOT_TOKEN}`,
      "Content-Type": "application/json",
      ...(options.headers ?? {})
    }
  });

  const text = await response.text();
  let body = null;
  if (text) {
    try { body = JSON.parse(text); } catch { body = text; }
  }

  if (response.status === 429 && retries > 0) {
    const retrySeconds = Number(body?.retry_after ?? 1);
    await sleep(Math.max(250, Math.ceil(retrySeconds * 1000)));
    return discordApi(path, options, retries - 1);
  }

  if (!response.ok) {
    const error = new Error(`Discord API ${response.status}`);
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
}

async function sendDm(userId) {
  const channel = await discordApi("/users/@me/channels", {
    method: "POST",
    body: JSON.stringify({ recipient_id: userId })
  });

  await discordApi(`/channels/${channel.id}/messages`, {
    method: "POST",
    body: JSON.stringify({
      content: DM_MESSAGE,
      allowed_mentions: { parse: [] }
    })
  });
}

async function getAllGuildMembers(guildId) {
  const members = [];
  let after = "0";

  while (true) {
    const page = await discordApi(`/guilds/${guildId}/members?limit=1000&after=${after}`);
    members.push(...page);
    if (page.length < 1000) break;
    after = page.at(-1).user.id;
  }

  return members.filter((member) => member.user && !member.user.bot);
}

async function editReply(applicationId, token, content) {
  const response = await fetch(
    `${API_BASE}/webhooks/${applicationId}/${token}/messages/@original`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content, allowed_mentions: { parse: [] } })
    }
  );
  if (!response.ok) console.error(`Antwort konnte nicht editiert werden: ${response.status}`);
}

app.get("/", (_req, res) => {
  res.json({
    status: "online",
    interactions: "/interactions",
    command: "/dm",
    guildBroadcast: broadcastToGuild
  });
});

app.get("/health", (_req, res) => res.json({ ok: true }));

app.post("/interactions", async (req, res) => {
  if (!verifyDiscordRequest(req)) return res.status(401).send("invalid request signature");

  let interaction;
  try { interaction = JSON.parse(req.body.toString("utf8")); }
  catch { return res.status(400).send("invalid json"); }

  if (interaction.type === 1) return res.json({ type: 1 });
  if (interaction.type !== 2 || interaction.data?.name !== "dm") {
    return res.json({ type: 4, data: { content: "Nicht unterstützte Interaction.", flags: EPHEMERAL } });
  }

  const invokerId = getInvokerId(interaction);
  if (allowedUsers.size > 0 && (!invokerId || !allowedUsers.has(invokerId))) {
    return res.json({ type: 4, data: { content: "❌ Du darfst diesen Command nicht benutzen.", flags: EPHEMERAL } });
  }

  if (broadcastToGuild && !interaction.guild_id) {
    return res.json({
      type: 4,
      data: { content: "❌ Der Rundversand funktioniert nur in einem Server, auf dem der Bot installiert ist.", flags: EPHEMERAL }
    });
  }

  const target = getTargetUser(interaction);
  if (!broadcastToGuild && !target) {
    return res.json({ type: 4, data: { content: "❌ Bitte wähle einen Empfänger aus.", flags: EPHEMERAL } });
  }
  if (!broadcastToGuild && target.bot) {
    return res.json({ type: 4, data: { content: "Bots werden nicht angeschrieben.", flags: EPHEMERAL } });
  }

  res.json({ type: 5, data: { flags: EPHEMERAL } });

  if (!broadcastToGuild) {
    try {
      await sendDm(target.id);
      await editReply(interaction.application_id, interaction.token, `✅ Announcement-DM an <@${target.id}> gesendet.`);
    } catch (error) {
      console.error(error.status, error.body ?? error.message);
      await editReply(interaction.application_id, interaction.token, "❌ Die DM konnte nicht gesendet werden. Der Nutzer hat DMs möglicherweise deaktiviert oder den Bot blockiert.");
    }
    return;
  }

  try {
    const members = await getAllGuildMembers(interaction.guild_id);
    let sent = 0;
    let failed = 0;

    await editReply(interaction.application_id, interaction.token, `⏳ Rundversand gestartet: ${members.length} Nicht-Bot-Mitglieder gefunden.`);

    for (const member of members) {
      try {
        await sendDm(member.user.id);
        sent += 1;
      } catch (error) {
        failed += 1;
        console.error(`DM an ${member.user.id} fehlgeschlagen:`, error.status, error.body ?? error.message);
      }
      if (delayMs > 0) await sleep(delayMs);
    }

    await editReply(
      interaction.application_id,
      interaction.token,
      `✅ Rundversand beendet. Erfolgreich: ${sent} · Fehlgeschlagen/DMs geschlossen: ${failed} · Gesamt: ${members.length}`
    );
  } catch (error) {
    console.error(error.status, error.body ?? error.message);
    let message = "❌ Server-Mitglieder konnten nicht geladen werden.";
    if (error.status === 403) message += " Aktiviere im Developer Portal den privilegierten Server Members Intent und installiere den Bot mit ausreichenden Rechten auf dem Server.";
    await editReply(interaction.application_id, interaction.token, message);
  }
});

app.listen(Number(PORT), "0.0.0.0", () => {
  console.log(`Server läuft auf Port ${PORT}`);
  console.log(`DM-Verzögerung: ${delayMs} ms`);
  console.log(`Server-Rundversand: ${broadcastToGuild ? "aktiv" : "aus"}`);
  console.log(`Nutzerbeschränkung: ${allowedUsers.size > 0 ? "aktiv" : "aus"}`);
});
