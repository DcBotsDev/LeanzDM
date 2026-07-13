import "dotenv/config";

const {
  DISCORD_APPLICATION_ID,
  DISCORD_BOT_TOKEN,
} = process.env;

if (!DISCORD_APPLICATION_ID || !DISCORD_BOT_TOKEN) {
  console.error("DISCORD_APPLICATION_ID oder DISCORD_BOT_TOKEN fehlt.");
  process.exit(1);
}

const commands = [
  {
    name: "dm",
    description: "Sendet einem Nutzer eine vorgefertigte Direktnachricht.",
    type: 1,
    dm_permission: false,
    default_member_permissions: "8",
    options: [
      {
        name: "user",
        description: "Nutzer, der die Nachricht erhalten soll",
        type: 6,
        required: true,
      },
    ],
  },
];

const response = await fetch(
  `https://discord.com/api/v10/applications/${DISCORD_APPLICATION_ID}/commands`,
  {
    method: "PUT",
    headers: {
      Authorization: `Bot ${DISCORD_BOT_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(commands),
  },
);

const body = await response.text();

if (!response.ok) {
  console.error(`Registrierung fehlgeschlagen (${response.status}): ${body}`);
  process.exit(1);
}

console.log("Globaler /dm-Command wurde registriert.");
console.log(body);
