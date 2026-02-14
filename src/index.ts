import { ChannelType, Client, Events, GatewayIntentBits, REST, Routes } from "discord.js";
import {
  handleLfgButtonInteraction,
  handleLfgCommand,
  lfgCommandData,
  refreshTrackedLfgPanelForGuild,
} from "./commands/lfg";
import { buildCardEmbed, extractCardQueries, loadCardLookup } from "./cards/lookup";
import { LfgQueue } from "./lfg/queue";
import { loadEnv } from "./util/env";
import { logger } from "./util/logger";

async function main(): Promise<void> {
  const env = loadEnv();
  const queue = new LfgQueue(env.QUEUE_TTL_MINUTES * 60 * 1000);
  const cardLookup = loadCardLookup();
  const elementEmojis = {
    air: env.EMOJI_AIR,
    earth: env.EMOJI_EARTH,
    fire: env.EMOJI_FIRE,
    water: env.EMOJI_WATER,
  };

  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
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

      const affectedGuildIds = new Set<string>();

      for (const entry of expiredEntries) {
        affectedGuildIds.add(entry.guildId);
        try {
          const user = await client.users.fetch(entry.userId);
          await user.send(
            buildExpiryDmMessage(client, entry.guildId, env.LFG_CHANNEL_NAME, entry.format),
          );
        } catch (error) {
          logger.warn("Unable to DM expired queue user.", {
            userId: entry.userId,
            format: entry.format,
            error,
          });
        }
      }

      for (const guildId of affectedGuildIds) {
        const guild = client.guilds.cache.get(guildId);
        if (!guild) {
          continue;
        }

        try {
          await refreshTrackedLfgPanelForGuild(guild, {
            queue,
            lfgChannelName: env.LFG_CHANNEL_NAME,
            queueTtlMinutes: env.QUEUE_TTL_MINUTES,
            logger,
          });
        } catch (error) {
          logger.warn("Failed to refresh LFG panel after queue expiry cleanup.", {
            guildId,
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
          queueTtlMinutes: env.QUEUE_TTL_MINUTES,
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
        queueTtlMinutes: env.QUEUE_TTL_MINUTES,
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

  client.on(Events.MessageCreate, async (message) => {
    if (message.author.bot || !message.inGuild()) {
      return;
    }

    const queries = extractCardQueries(message.content);
    if (queries.length === 0) {
      return;
    }

    try {
      const lookupResults = queries.map((query) => cardLookup.find(query));
      const embeds = lookupResults.flatMap((result) =>
        result.card ? [buildCardEmbed(result.card, elementEmojis)] : [],
      );

      for (let i = 0; i < embeds.length; i += 10) {
        await message.channel.send({
          embeds: embeds.slice(i, i + 10),
          allowedMentions: { repliedUser: false, parse: [] },
        });
      }
    } catch (error) {
      logger.error("Error handling card lookup message.", {
        content: message.content,
        channelId: message.channelId,
        guildId: message.guildId,
        error,
      });
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

function buildExpiryDmMessage(
  client: Client,
  guildId: string,
  lfgChannelName: string,
  format: string,
): string {
  const guild = client.guilds.cache.get(guildId);
  const channel = guild?.channels.cache.find(
    (item) => item.type === ChannelType.GuildText && item.name === lfgChannelName,
  );

  const lines = [`Your LFG entry for **${format}** expired.`];

  if (channel && channel.type === ChannelType.GuildText) {
    lines.push(`Go to <#${channel.id}> to rejoin.`);
  } else {
    lines.push(`Go to #${lfgChannelName} in the server to rejoin.`);
  }

  return lines.join("\n");
}

main().catch((error) => {
  logger.error("Fatal startup error.", error);
  process.exit(1);
});
