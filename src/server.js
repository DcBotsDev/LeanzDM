import "dotenv/config";
import express from "express";
import nacl from "tweetnacl";

const {
  DISCORD_PUBLIC_KEY,
  DISCORD_BOT_TOKEN,
  PORT = "10000",
  DM_MESSAGE = "Hallo! Dies ist deine vorgefertigte Nachricht.",
  ALLOWED_ROLE_IDS = "",
  DM_TO_OPTED_IN_USERS = "false",
  OPT_IN_ROLE_ID = "",
  DM_DELAY_MS = "1200",
} = process.env;

const required = { DISCORD_PUBLIC_KEY, DISCORD_BOT_TOKEN };
const missing = Object.entries(required)
  .filter(([, value]) => !value)
  .map(([key]) => key);

if (missing.length) {
  console.error(`Fehlende Umgebungsvariablen: ${missing.join(", ")}`);
  process.exit(1);
}

const app = express();
const API_BASE = "https://discord.com/api/v10";
const EPHEMERAL = 1 << 6;
const ADMINISTRATOR = 1n << 3n;
const allowedRoleIds = new Set(
  ALLOWED_ROLE_IDS.split(",").map((id) => id.trim()).filter(Boolean),
);
const dmToOptedInUsers = DM_TO_OPTED_IN_USERS.toLowerCase() === "true";
const dmDelayMs = Math.max(1000, Number(DM_DELAY_MS) || 1200);

// Discord benötigt den unveränderten Request-Body für die Ed25519-Prüfung.
app.use("/interactions", express.raw({ type: "application/json", limit: "1mb" }));
app.use(express.json({ limit: "1mb" }));

function verifyDiscordRequest(req) {
  const signature = req.get("X-Signature-Ed25519");
  const timestamp = req.get("X-Signature-Timestamp");

  if (!signature || !timestamp || !Buffer.isBuffer(req.body)) {
    return false;
  }

  try {
    return nacl.sign.detached.verify(
      Buffer.from(timestamp + req.body.toString("utf8")),
      Buffer.from(signature, "hex"),
      Buffer.from(DISCORD_PUBLIC_KEY, "hex"),
    );
  } catch {
    return false;
  }
}

function mayUseCommand(interaction) {
  const member = interaction.member;
  if (!member) return false;

  const permissions = BigInt(member.permissions ?? "0");
  if ((permissions & ADMINISTRATOR) === ADMINISTRATOR) return true;

  if (allowedRoleIds.size === 0) return false;
  return (member.roles ?? []).some((roleId) => allowedRoleIds.has(roleId));
}

function getUserOption(interaction) {
  const option = interaction.data?.options?.find((item) => item.name === "user");
  if (!option?.value) return null;

  const resolvedUser = interaction.data?.resolved?.users?.[option.value];
  return resolvedUser ? { id: option.value, ...resolvedUser } : { id: option.value };
}

async function discordApi(path, options = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bot ${DISCORD_BOT_TOKEN}`,
      "Content-Type": "application/json",
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

  if (!response.ok) {
    const error = new Error(`Discord API ${response.status}`);
    error.status = response.status;
    error.body = body;
    throw error;
  }

  return body;
}

async function editOriginalResponse(applicationId, interactionToken, content) {
  const response = await fetch(
    `${API_BASE}/webhooks/${applicationId}/${interactionToken}/messages/@original`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    },
  );

  if (!response.ok) {
    console.error("Interaction-Antwort konnte nicht aktualisiert werden:", response.status);
  }
}

async function sendDirectMessage(userId) {
  const channel = await discordApi("/users/@me/channels", {
    method: "POST",
    body: JSON.stringify({ recipient_id: userId }),
  });

  await discordApi(`/channels/${channel.id}/messages`, {
    method: "POST",
    body: JSON.stringify({
      content: DM_MESSAGE,
      allowed_mentions: { parse: [] },
    }),
  });
}

async function listOptedInMembers(guildId) {
  if (!OPT_IN_ROLE_ID) {
    throw new Error(
      "OPT_IN_ROLE_ID fehlt, obwohl DM_TO_OPTED_IN_USERS=true gesetzt ist.",
    );
  }

  const members = [];
  let after = "0";

  while (true) {
    const page = await discordApi(
      `/guilds/${guildId}/members?limit=1000&after=${after}`,
      { method: "GET" },
    );

    if (!Array.isArray(page) || page.length === 0) break;

    for (const member of page) {
      const user = member.user;
      if (
        user &&
        !user.bot &&
        Array.isArray(member.roles) &&
        member.roles.includes(OPT_IN_ROLE_ID)
      ) {
        members.push(member);
      }
    }

    if (page.length < 1000) break;
    after = page[page.length - 1].user.id;
  }

  return members;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function sendOptInBroadcast(guildId) {
  const members = await listOptedInMembers(guildId);
  let sent = 0;
  let failed = 0;

  for (const member of members) {
    try {
      await sendDirectMessage(member.user.id);
      sent += 1;
    } catch (error) {
      failed += 1;
      console.error(
        "Opt-in-DM fehlgeschlagen:",
        member.user.id,
        error.status,
        error.body ?? error.message,
      );
    }

    await sleep(dmDelayMs);
  }

  return { total: members.length, sent, failed };
}

app.get("/", (_req, res) => {
  res.status(200).json({
    service: "discord-dm-authorized-app",
    status: "online",
    interactions: "/interactions",
  });
});

app.get("/health", (_req, res) => {
  res.status(200).json({ ok: true });
});

app.post("/interactions", async (req, res) => {
  if (!verifyDiscordRequest(req)) {
    return res.status(401).send("invalid request signature");
  }

  let interaction;
  try {
    interaction = JSON.parse(req.body.toString("utf8"));
  } catch {
    return res.status(400).send("invalid json");
  }

  // Discord PING
  if (interaction.type === 1) {
    return res.status(200).json({ type: 1 });
  }

  // Nur Application Commands verarbeiten.
  if (interaction.type !== 2) {
    return res.status(200).json({
      type: 4,
      data: { content: "Nicht unterstützte Interaction.", flags: EPHEMERAL },
    });
  }

  if (interaction.data?.name !== "dm") {
    return res.status(200).json({
      type: 4,
      data: { content: "Unbekannter Befehl.", flags: EPHEMERAL },
    });
  }

  if (!interaction.guild_id) {
    return res.status(200).json({
      type: 4,
      data: {
        content: "Dieser Befehl kann nur auf einem Server verwendet werden.",
        flags: EPHEMERAL,
      },
    });
  }

  if (!mayUseCommand(interaction)) {
    return res.status(200).json({
      type: 4,
      data: {
        content: "Du bist für diesen Befehl nicht autorisiert.",
        flags: EPHEMERAL,
      },
    });
  }

  const target = getUserOption(interaction);

  if (!dmToOptedInUsers && !target) {
    return res.status(200).json({
      type: 4,
      data: { content: "Der Empfänger fehlt.", flags: EPHEMERAL },
    });
  }

  if (!dmToOptedInUsers && target?.bot) {
    return res.status(200).json({
      type: 4,
      data: {
        content: "Die vorgefertigte Nachricht wird nicht an Bots gesendet.",
        flags: EPHEMERAL,
      },
    });
  }

  res.status(200).json({
    type: 5,
    data: { flags: EPHEMERAL },
  });

  try {
    if (dmToOptedInUsers) {
      const result = await sendOptInBroadcast(interaction.guild_id);

      await editOriginalResponse(
        interaction.application_id,
        interaction.token,
        `✅ Opt-in-Ankündigung abgeschlossen: ${result.sent}/${result.total} DMs gesendet, ${result.failed} fehlgeschlagen.`,
      );

      console.log(
        JSON.stringify({
          event: "opt_in_dm_broadcast_finished",
          guildId: interaction.guild_id,
          actorId: interaction.member?.user?.id,
          optInRoleId: OPT_IN_ROLE_ID,
          ...result,
          at: new Date().toISOString(),
        }),
      );
    } else {
      await sendDirectMessage(target.id);
      const label = target.username ? `@${target.username}` : `<@${target.id}>`;

      await editOriginalResponse(
        interaction.application_id,
        interaction.token,
        `✅ Die vorgefertigte Nachricht wurde an ${label} gesendet.`,
      );

      console.log(
        JSON.stringify({
          event: "dm_sent",
          guildId: interaction.guild_id,
          actorId: interaction.member?.user?.id,
          targetId: target.id,
          at: new Date().toISOString(),
        }),
      );
    }
  } catch (error) {
    console.error(
      "Nachrichtenversand fehlgeschlagen:",
      error.status,
      error.body ?? error.message,
    );

    let message = dmToOptedInUsers
      ? "❌ Die Opt-in-DM-Ankündigung konnte nicht abgeschlossen werden."
      : "❌ Die DM konnte nicht gesendet werden.";

    if (error.status === 403) {
      message += dmToOptedInUsers
        ? " Prüfe den Server Members Intent und den Zugriff des Bots."
        : " Der Nutzer blockiert möglicherweise DMs oder den Bot.";
    } else if (error.status === 429) {
      message += " Discord hat die Anfrage vorübergehend begrenzt.";
    } else if (error.message?.includes("OPT_IN_ROLE_ID")) {
      message += " OPT_IN_ROLE_ID fehlt in Render.";
    } else {
      message += " Prüfe die Render-Logs und die Bot-Konfiguration.";
    }

    await editOriginalResponse(
      interaction.application_id,
      interaction.token,
      message,
    );
  }
});

app.listen(Number(PORT), "0.0.0.0", () => {
  console.log(`Server läuft auf Port ${PORT}`);
});
