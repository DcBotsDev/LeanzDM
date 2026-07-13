import "dotenv/config";

const { DISCORD_APPLICATION_ID, DISCORD_BOT_TOKEN } = process.env;
if (!DISCORD_APPLICATION_ID || !DISCORD_BOT_TOKEN) {
  console.error("DISCORD_APPLICATION_ID oder DISCORD_BOT_TOKEN fehlt.");
  process.exit(1);
}

const commands = [
  {
    name: "dm",
    description: "Sendet die konfigurierte Announcement-DM.",
    type: 1,
    integration_types: [0, 1],
    contexts: [0, 1, 2],
    options: [
      {
        name: "user",
        description: "Empfänger (nur nötig, wenn DM_TO_OPTED_IN_USERS=false)",
        type: 6,
        required: false
      }
    ]
  }
];

const response = await fetch(
  `https://discord.com/api/v10/applications/${DISCORD_APPLICATION_ID}/commands`,
  {
    method: "PUT",
    headers: {
      Authorization: `Bot ${DISCORD_BOT_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(commands)
  }
);

const body = await response.text();
if (!response.ok) {
  console.error(`Command-Registrierung fehlgeschlagen (${response.status}): ${body}`);
  process.exit(1);
}
console.log("Globaler /dm-Command registriert.");
