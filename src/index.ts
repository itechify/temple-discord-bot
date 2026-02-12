import { Client, Events, GatewayIntentBits, REST, Routes } from "discord.js";
import { handleLfgButtonInteraction, handleLfgCommand, lfgCommandData } from "./commands/lfg";
import { LfgQueue } from "./lfg/queue";
import { loadEnv } from "./util/env";
import { logger } from "./util/logger";

async function main(): Promise<void> {
  const env = loadEnv();
  const queue = new LfgQueue(env.QUEUE_TTL_MINUTES * 60 * 1000);

  const client = new Client({
    intents: [GatewayIntentBits.Guilds],
  });

  client.once(Events.ClientReady, async (readyClient) => {
    logger.info(`Logged in as ${readyClient.user.tag}`);

    try {
      await registerCommands(env.DISCORD_TOKEN, env.CLIENT_ID, env.GUILD_ID);
    } catch (error) {
      logger.error("Failed to register slash commands.", error);
    }

    const cleanupIntervalMs = 45_000;
    setInterval(async () => {
      const { expiredEntries } = queue.cleanup();
      if (expiredEntries.length === 0) {
        return;
      }

      for (const entry of expiredEntries) {
        try {
          const user = await client.users.fetch(entry.userId);
          await user.send(`Your LFG entry expired—run /lfg join ${entry.format} to re-enter.`);
        } catch (error) {
          logger.warn("Unable to DM expired queue user.", {
            userId: entry.userId,
            format: entry.format,
            error,
          });
        }
      }
    }, cleanupIntervalMs).unref();

    logger.info(
      `Cleanup loop running every ${Math.floor(cleanupIntervalMs / 1000)}s (TTL ${env.QUEUE_TTL_MINUTES}m).`,
    );
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    if (interaction.isButton() && interaction.customId.startsWith("lfg_panel_")) {
      try {
        await handleLfgButtonInteraction(interaction, {
          queue,
          lfgChannelName: env.LFG_CHANNEL_NAME,
          logger,
        });
      } catch (error) {
        logger.error("Error handling LFG panel button.", error);

        const content = "Something went wrong while processing this button.";
        if (interaction.deferred || interaction.replied) {
          await interaction.followUp({ content, ephemeral: true }).catch(() => undefined);
        } else {
          await interaction.reply({ content, ephemeral: true }).catch(() => undefined);
        }
      }
      return;
    }

    if (!interaction.isChatInputCommand()) {
      return;
    }

    if (interaction.commandName !== "lfg") {
      return;
    }

    try {
      await handleLfgCommand(interaction, {
        queue,
        lfgChannelName: env.LFG_CHANNEL_NAME,
        logger,
      });
    } catch (error) {
      logger.error("Error handling /lfg command.", error);

      const content = "Something went wrong while processing this command.";
      if (interaction.deferred || interaction.replied) {
        await interaction.followUp({ content, ephemeral: true }).catch(() => undefined);
      } else {
        await interaction.reply({ content, ephemeral: true }).catch(() => undefined);
      }
    }
  });

  await client.login(env.DISCORD_TOKEN);
}

async function registerCommands(token: string, clientId: string, guildId?: string): Promise<void> {
  const rest = new REST({ version: "10" }).setToken(token);
  const payload = [lfgCommandData.toJSON()];

  if (guildId) {
    await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: payload });
    logger.info(`Registered guild slash commands for guild ${guildId}.`);
    return;
  }

  await rest.put(Routes.applicationCommands(clientId), { body: payload });
  logger.warn("GUILD_ID not set. Registered global commands (can take up to 1 hour).", {});
}

main().catch((error) => {
  logger.error("Fatal startup error.", error);
  process.exit(1);
});
