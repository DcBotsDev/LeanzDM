import "dotenv/config";

const {
  DISCORD_APPLICATION_ID,
  DISCORD_BOT_TOKEN,
  DISCORD_GUILD_ID,
} = process.env;

const missing = [
  ["DISCORD_APPLICATION_ID", DISCORD_APPLICATION_ID],
  ["DISCORD_BOT_TOKEN", DISCORD_BOT_TOKEN],
].filter(([, value]) => !value).map(([key]) => key);

if (missing.length) {
  console.error(`Fehlende Umgebungsvariablen: ${missing.join(", ")}`);
  process.exit(1);
}

// Administrator-Bit als String. Discord erwartet für default_member_permissions
// eine String-Darstellung des Permission-Bitfelds.
const commands = [
  {
    name: "dm",
    description: "Sendet eine vorgefertigte DM oder veröffentlicht eine Ankündigung.",
    type: 1,
    dm_permission: false,
    default_member_permissions: "8",
    options: [
      {
        name: "user",
        description: "Empfänger im DM-Modus; im Ankündigungsmodus optional",
        type: 6,
        required: false,
      },
    ],
  },
];

const scope = DISCORD_GUILD_ID
  ? `/applications/${DISCORD_APPLICATION_ID}/guilds/${DISCORD_GUILD_ID}/commands`
  : `/applications/${DISCORD_APPLICATION_ID}/commands`;

const response = await fetch(`https://discord.com/api/v10${scope}`, {
  method: "PUT",
  headers: {
    Authorization: `Bot ${DISCORD_BOT_TOKEN}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify(commands),
});

const body = await response.text();

if (!response.ok) {
  console.error(`Registrierung fehlgeschlagen (${response.status}): ${body}`);
  process.exit(1);
}

console.log(
  DISCORD_GUILD_ID
    ? "Guild-Command /dm wurde registriert."
    : "Globaler Command /dm wurde registriert. Die Verteilung kann etwas dauern.",
);
console.log(body);
