import "dotenv/config";
import express from "express";
import nacl from "tweetnacl";

const {
  DISCORD_PUBLIC_KEY,
  DISCORD_BOT_TOKEN,
  DM_MESSAGE = "Hallo! Dies ist deine vorgefertigte Nachricht.",
  PORT = "10000",
} = process.env;

for (const [key, value] of Object.entries({
  DISCORD_PUBLIC_KEY,
  DISCORD_BOT_TOKEN,
})) {
  if (!value) {
    console.error(`Fehlende Umgebungsvariable: ${key}`);
    process.exit(1);
  }
}

const app = express();
const API_BASE = "https://discord.com/api/v10";
const EPHEMERAL = 1 << 6;
const ADMINISTRATOR = 1n << 3n;

app.use("/interactions", express.raw({ type: "application/json", limit: "1mb" }));
app.use(express.json({ limit: "1mb" }));

function verifyDiscordRequest(req) {
  const signature = req.get("X-Signature-Ed25519");
  const timestamp = req.get("X-Signature-Timestamp");

  if (!signature || !timestamp || !Buffer.isBuffer(req.body)) return false;

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

function isAdministrator(interaction) {
  const permissions = BigInt(interaction.member?.permissions ?? "0");
  return (permissions & ADMINISTRATOR) === ADMINISTRATOR;
}

function getTargetUser(interaction) {
  const option = interaction.data?.options?.find((item) => item.name === "user");
  if (!option?.value) return null;

  const resolved = interaction.data?.resolved?.users?.[option.value];
  return resolved ? { id: option.value, ...resolved } : { id: option.value };
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

async function sendDm(userId) {
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

async function editReply(applicationId, token, content) {
  await fetch(
    `${API_BASE}/webhooks/${applicationId}/${token}/messages/@original`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content }),
    },
  );
}

app.get("/", (_req, res) => {
  res.json({ status: "online", interactions: "/interactions" });
});

app.get("/health", (_req, res) => {
  res.json({ ok: true });
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

  if (interaction.type === 1) {
    return res.json({ type: 1 });
  }

  if (interaction.type !== 2 || interaction.data?.name !== "dm") {
    return res.json({
      type: 4,
      data: { content: "Nicht unterstützte Interaction.", flags: EPHEMERAL },
    });
  }

  if (!interaction.guild_id) {
    return res.json({
      type: 4,
      data: {
        content: "Dieser Befehl funktioniert nur auf einem Server.",
        flags: EPHEMERAL,
      },
    });
  }

  if (!isAdministrator(interaction)) {
    return res.json({
      type: 4,
      data: {
        content: "Du bist für diesen Befehl nicht autorisiert.",
        flags: EPHEMERAL,
      },
    });
  }

  const target = getTargetUser(interaction);

  if (!target) {
    return res.json({
      type: 4,
      data: { content: "Der Empfänger fehlt.", flags: EPHEMERAL },
    });
  }

  if (target.bot) {
    return res.json({
      type: 4,
      data: { content: "Bots werden nicht angeschrieben.", flags: EPHEMERAL },
    });
  }

  res.json({
    type: 5,
    data: { flags: EPHEMERAL },
  });

  try {
    await sendDm(target.id);
    await editReply(
      interaction.application_id,
      interaction.token,
      `✅ Nachricht an <@${target.id}> gesendet.`,
    );
  } catch (error) {
    console.error(error.status, error.body ?? error.message);

    let message = "❌ Die DM konnte nicht gesendet werden.";

    if (error.status === 403) {
      message += " Der Nutzer hat DMs möglicherweise deaktiviert oder den Bot blockiert.";
    } else if (error.status === 429) {
      message += " Discord begrenzt die Anfrage gerade.";
    }

    await editReply(
      interaction.application_id,
      interaction.token,
      message,
    );
  }
});

app.listen(Number(PORT), "0.0.0.0", () => {
  console.log(`Server läuft auf Port ${PORT}`);
});
