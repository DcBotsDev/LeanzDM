import express from "express";
import nacl from "tweetnacl";
import { config } from "./config.js";
import {
  DiscordApiError,
  editInteractionReply,
  sendDm,
} from "./discord-api.js";

const EPHEMERAL = 1 << 6;
const USER_INSTALL = "1";

const app = express();
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
      Buffer.from(config.publicKey, "hex"),
    );
  } catch {
    return false;
  }
}

function getInvoker(interaction) {
  return interaction.member?.user ?? interaction.user ?? null;
}

function getTarget(interaction) {
  const option = interaction.data?.options?.find((item) => item.name === "user");
  if (!option?.value) return null;

  const resolved = interaction.data?.resolved?.users?.[option.value];
  return resolved ? { id: option.value, ...resolved } : { id: option.value };
}

function mayUseCommand(interaction) {
  if (config.allowedUserIds.size === 0) return true;
  const invoker = getInvoker(interaction);
  return Boolean(invoker?.id && config.allowedUserIds.has(invoker.id));
}

function dmErrorText(error) {
  if (!(error instanceof DiscordApiError)) {
    return "Unbekannter Fehler";
  }

  if (error.status === 401) return "Bot-Token ungültig";
  if (error.status === 403) {
    return "Nutzer blockiert den Bot oder erlaubt keine DM";
  }
  if (error.status === 404) return "Nutzer oder DM-Kanal nicht gefunden";
  if (error.status === 429) return "Discord-Rate-Limit erreicht";
  return `Discord API Fehler ${error.status}`;
}

app.get("/", (_req, res) => {
  res.json({ status: "online", install: "user", command: "/dm" });
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

  if (interaction.type === 1) return res.json({ type: 1 });

  if (interaction.type !== 2 || interaction.data?.name !== "dm") {
    return res.json({
      type: 4,
      data: { content: "Nicht unterstützte Interaction.", flags: EPHEMERAL },
    });
  }

  if (!interaction.authorizing_integration_owners?.[USER_INSTALL]) {
    return res.json({
      type: 4,
      data: {
        content: "❌ Diese App unterstützt ausschließlich User Install.",
        flags: EPHEMERAL,
      },
    });
  }

  if (!interaction.guild_id) {
    return res.json({
      type: 4,
      data: {
        content: "❌ /dm kann nur innerhalb eines Servers benutzt werden.",
        flags: EPHEMERAL,
      },
    });
  }

  if (!mayUseCommand(interaction)) {
    return res.json({
      type: 4,
      data: { content: "❌ Du darfst diesen Command nicht nutzen.", flags: EPHEMERAL },
    });
  }

  const target = getTarget(interaction);
  if (!target) {
    return res.json({
      type: 4,
      data: { content: "❌ Empfänger fehlt.", flags: EPHEMERAL },
    });
  }

  if (target.bot) {
    return res.json({
      type: 4,
      data: { content: "❌ Bots werden nicht angeschrieben.", flags: EPHEMERAL },
    });
  }

  res.json({ type: 5, data: { flags: EPHEMERAL } });

  try {
    await sendDm(target.id);
    await editInteractionReply(
      interaction,
      `✅ Announcement-DM an <@${target.id}> gesendet.`,
    );
  } catch (error) {
    console.error("DM fehlgeschlagen:", error);
    try {
      await editInteractionReply(
        interaction,
        `❌ DM an <@${target.id}> fehlgeschlagen: ${dmErrorText(error)}.`,
      );
    } catch (replyError) {
      console.error("Fehlerantwort fehlgeschlagen:", replyError);
    }
  }
});

app.listen(config.port, "0.0.0.0", () => {
  console.log(`✅ Server läuft auf Port ${config.port}`);
  console.log("✅ Modus: ausschließlich User Install");
  console.log("✅ Registrierter Command: /dm");
});
