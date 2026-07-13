import { config } from "../src/config.js";
import { discordApi } from "../src/discord-api.js";

const commands = [
  {
    name: "dm",
    description: "Sendet einem ausgewählten Nutzer die Announcement-DM.",
    type: 1,
    integration_types: [1],
    contexts: [0],
    options: [
      {
        name: "user",
        description: "Empfänger der Announcement-DM",
        type: 6,
        required: true,
      },
    ],
  },
];

const result = await discordApi(
  `/applications/${config.applicationId}/commands`,
  {
    method: "PUT",
    body: JSON.stringify(commands),
  },
);

if (!Array.isArray(result) || result.length !== 1 || result[0]?.name !== "dm") {
  throw new Error("Discord hat den /dm-Command nicht korrekt registriert.");
}

console.log("✅ Nur /dm als globaler User-Install-Command registriert.");
