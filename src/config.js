import "dotenv/config";

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Fehlende Umgebungsvariable: ${name}`);
  return value;
}

function parseIds(value) {
  return new Set(
    String(value ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  );
}

function parsePort(value) {
  const parsed = Number.parseInt(String(value ?? "10000"), 10);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535
    ? parsed
    : 10000;
}

export const config = Object.freeze({
  applicationId: required("DISCORD_APPLICATION_ID"),
  publicKey: required("DISCORD_PUBLIC_KEY"),
  botToken: required("DISCORD_BOT_TOKEN"),
  dmMessage:
    process.env.DM_MESSAGE?.trim() ||
    "📢 Das ist deine Announcement-Nachricht.",
  allowedUserIds: parseIds(process.env.ALLOWED_USER_IDS),
  port: parsePort(process.env.PORT),
});

if (!/^\d{17,20}$/u.test(config.applicationId)) {
  throw new Error("DISCORD_APPLICATION_ID ist keine gültige Discord-ID.");
}

if (!/^[0-9a-f]{64}$/iu.test(config.publicKey)) {
  throw new Error("DISCORD_PUBLIC_KEY muss aus genau 64 Hex-Zeichen bestehen.");
}

if (config.dmMessage.length > 20_000) {
  throw new Error("DM_MESSAGE ist zu lang. Maximum: 20.000 Zeichen.");
}
