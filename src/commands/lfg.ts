import {
  ActionRowBuilder,
  ButtonBuilder,
  type ButtonInteraction,
  ButtonStyle,
  ChannelType,
  type ChatInputCommandInteraction,
  EmbedBuilder,
  type Guild,
  SlashCommandBuilder,
  type TextChannel,
  userMention,
} from "discord.js";
import type { LfgQueue } from "../lfg/queue";
import { FORMATS, type LfgFormat } from "../lfg/types";
import type { Logger } from "../util/logger";

interface LfgCommandContext {
  queue: LfgQueue;
  lfgChannelName: string;
  queueTtlMinutes: number;
  logger: Logger;
}

const PANEL_JOIN_CONSTRUCTED = "lfg_panel_join_constructed";
const PANEL_JOIN_SEALED = "lfg_panel_join_sealed";
const PANEL_JOIN_MULTIPLAYER = "lfg_panel_join_multiplayer";
const PANEL_LEAVE = "lfg_panel_leave";

const panelMessages = new Map<string, { channelId: string; messageId: string }>();

export const lfgCommandData = new SlashCommandBuilder()
  .setName("lfg")
  .setDescription("Looking For Game queue commands")
  .addSubcommand((subcommand) =>
    subcommand
      .setName("join")
      .setDescription("Join the LFG queue")
      .addStringOption((option) =>
        option
          .setName("format")
          .setDescription("Sorcery format")
          .setRequired(true)
          .addChoices(
            { name: "constructed", value: "constructed" },
            { name: "sealed", value: "sealed" },
            { name: "multiplayer", value: "multiplayer" },
          ),
      ),
  )
  .addSubcommand((subcommand) => subcommand.setName("leave").setDescription("Leave the LFG queue"))
  .addSubcommand((subcommand) =>
    subcommand.setName("status").setDescription("View your queue status"),
  )
  .addSubcommand((subcommand) =>
    subcommand.setName("help").setDescription("Show LFG command help"),
  );

export async function handleLfgCommand(
  interaction: ChatInputCommandInteraction,
  context: LfgCommandContext,
): Promise<void> {
  if (!interaction.inGuild()) {
    await interaction.reply({
      content: "This command can only be used in a server.",
      ephemeral: true,
    });
    return;
  }

  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.reply({
      content: "This command can only be used in a server.",
      ephemeral: true,
    });
    return;
  }

  if (interaction.user.bot) {
    await interaction.reply({
      content: "Bots cannot use this queue.",
      ephemeral: true,
    });
    return;
  }

  const subcommand = interaction.options.getSubcommand(true);

  if (subcommand === "join") {
    const format = interaction.options.getString("format", true) as LfgFormat;
    await handleJoin(interaction, context, guildId, format);
    await refreshPanelIfTracked(interaction.guild, context);
    return;
  }

  if (subcommand === "leave") {
    const result = context.queue.leave(guildId, interaction.user.id);
    if (result.kind === "not_queued") {
      await interaction.reply({
        content: "You are not currently in any LFG queue.",
        ephemeral: true,
      });
      return;
    }

    await interaction.reply({
      content: `**Left queue:** ${formatDisplay(result.format)}`,
      ephemeral: true,
    });
    await refreshPanelIfTracked(interaction.guild, context);
    return;
  }

  if (subcommand === "status") {
    const status = context.queue.status(guildId, interaction.user.id);

    const lines = [];
    if (status.userStatus) {
      lines.push(`You are currently queued for **${formatDisplay(status.userStatus.format)}**.`);
      lines.push(`It will expire in \`${humanizeDuration(status.userStatus.remainingMs)}\``);
    } else {
      lines.push("Not currently queued.");
    }

    await interaction.reply({ content: lines.join("\n"), ephemeral: true });
    return;
  }

  const announcementChannel = getAnnouncementChannel(interaction.guild, context.lfgChannelName);
  const channelReference = announcementChannel
    ? `<#${announcementChannel.id}>`
    : `#${context.lfgChannelName}`;

  await interaction.reply({
    content: [
      `Bot announcements are posted in ${channelReference}.`,
      "",
      "**Commands**",
      "- `/lfg join constructed|sealed|multiplayer`",
      "- `/lfg leave`",
      "- `/lfg status`",
    ].join("\n"),
    ephemeral: true,
  });
}

export async function handleLfgButtonInteraction(
  interaction: ButtonInteraction,
  context: LfgCommandContext,
): Promise<void> {
  if (!interaction.inGuild() || interaction.user.bot) {
    return;
  }

  const guildId = interaction.guildId;
  if (!guildId) {
    await interaction.reply({
      content: "This interaction can only be used in a server.",
      ephemeral: true,
    });
    return;
  }

  if (interaction.customId === PANEL_LEAVE) {
    const result = context.queue.leave(guildId, interaction.user.id);
    if (result.kind === "not_queued") {
      await interaction.reply({
        content: "You are not currently in any LFG queue.",
        ephemeral: true,
      });
      return;
    }

    await interaction.reply({
      content: `**Left queue:** ${formatDisplay(result.format)}`,
      ephemeral: true,
    });
    await refreshPanelIfTracked(interaction.guild, context);
    return;
  }

  const format = buttonFormat(interaction.customId);
  if (!format) {
    return;
  }

  await handleJoin(interaction, context, guildId, format);
  await refreshPanelIfTracked(interaction.guild, context);
}

export async function ensureLfgPanelForGuild(
  guild: Guild,
  context: LfgCommandContext,
): Promise<void> {
  const channel = getAnnouncementChannel(guild, context.lfgChannelName);
  if (!channel) {
    return;
  }

  const tracked = panelMessages.get(guild.id);
  if (tracked && tracked.channelId === channel.id) {
    try {
      const message = await channel.messages.fetch(tracked.messageId);
      await deleteDuplicatePanelMessages(guild, channel, message.id, context.logger);
      await message.edit(buildPanelMessage(context.queue, guild.id, context.queueTtlMinutes));
      return;
    } catch {
      panelMessages.delete(guild.id);
    }
  }

  try {
    const recentMessages = await channel.messages.fetch({ limit: 50 });
    const existing = recentMessages.find(
      (message) =>
        message.author.id === guild.client.user?.id &&
        JSON.stringify(message.components).includes("lfg_panel_"),
    );

    if (existing) {
      await deleteDuplicatePanelMessages(guild, channel, existing.id, context.logger);
      panelMessages.set(guild.id, {
        channelId: channel.id,
        messageId: existing.id,
      });
      await existing.edit(buildPanelMessage(context.queue, guild.id, context.queueTtlMinutes));
      return;
    }
  } catch (error) {
    context.logger.warn("Failed searching for existing LFG panel.", {
      guildId: guild.id,
      error,
    });
  }

  const sent = await channel.send(buildPanelMessage(context.queue, guild.id, context.queueTtlMinutes));
  panelMessages.set(guild.id, { channelId: channel.id, messageId: sent.id });
}

export async function refreshTrackedLfgPanelForGuild(
  guild: Guild,
  context: LfgCommandContext,
): Promise<void> {
  await refreshPanelIfTracked(guild, context);
}

async function handleJoin(
  interaction: ChatInputCommandInteraction | ButtonInteraction,
  context: LfgCommandContext,
  guildId: string,
  format: LfgFormat,
): Promise<void> {
  const announcementChannel = getAnnouncementChannel(interaction.guild, context.lfgChannelName);
  const result = context.queue.join(guildId, interaction.user.id, format);

  if (result.kind === "already_queued") {
    await interaction.reply({
      content: `You are already queued for ${formatDisplay(format)}.\n**Remaining time:** \`${humanizeDuration(
        result.remainingMs,
      )}\``,
      ephemeral: true,
    });
    return;
  }

  if (result.kind === "queued") {
    const moveLine = result.movedFrom
      ? `**Moved:** ${formatDisplay(result.movedFrom)} -> ${formatDisplay(result.format)}`
      : `**Queued:** ${formatDisplay(result.format)}`;

    await interaction.reply({
      content: `${moveLine}\n**Expires in:** \`${humanizeDuration(
        Math.max(0, result.expiresAt - Date.now()),
      )}\``,
      ephemeral: true,
    });

    if (announcementChannel) {
      try {
        await announcementChannel.send(
          `${userMention(interaction.user.id)} has joined the queue looking for a **${formatLabel(
            result.format,
          )}** game!\nJoin with \`/lfg join format:${result.format}\` or by clicking the button below!`,
        );
        await bumpPanelToBottom(interaction.guild, context);
      } catch (error) {
        context.logger.warn("Failed to post queue join announcement.", {
          userId: interaction.user.id,
          format: result.format,
          error,
        });
      }
    }
    return;
  }

  const participantIds = [interaction.user.id, ...result.matchedUserIds];
  const message = `**Match found:** ${participantIds.map((id) => userMention(id)).join(", ")}\n**Format:** ${formatDisplay(result.format)}`;

  if (announcementChannel) {
    try {
      await announcementChannel.send(message);
      await bumpPanelToBottom(interaction.guild, context);
    } catch (error) {
      context.logger.warn("Failed to post match announcement.", {
        userId: interaction.user.id,
        participantUserIds: participantIds,
        format: result.format,
        error,
      });
    }
  }

  await acknowledgeMatchSilently(interaction);

  const channelReference = announcementChannel
    ? `<#${announcementChannel.id}>`
    : `#${context.lfgChannelName}`;

  await Promise.all(
    participantIds.map((userId) => {
      const otherPlayers = participantIds
        .filter((id) => id !== userId)
        .map((id) => userMention(id))
        .join(", ");
      const dm = [
        `Sorcery match found in ${channelReference}!`,
        `Other player(s): ${otherPlayers}`,
        `Format: ${formatLabel(result.format)}`,
      ].join("\n");
      return safeDm(interaction, userId, dm, context.logger);
    }),
  );
}

function buildPanelMessage(
  queue: LfgQueue,
  guildId: string,
  queueTtlMinutes: number,
): {
  embeds: EmbedBuilder[];
  components: ActionRowBuilder<ButtonBuilder>[];
} {
  const status = queue.status(guildId, "panel-user");
  const totalWaiting = status.formats.reduce((acc, item) => acc + item.count, 0);

  const c = status.formats.find((f) => f.format === "constructed")?.count ?? 0;
  const s = status.formats.find((f) => f.format === "sealed")?.count ?? 0;
  const m = status.formats.find((f) => f.format === "multiplayer")?.count ?? 0;

  const embed = new EmbedBuilder()
    .setTitle("🧙‍♂️ LFG Queue")
    .setColor(totalWaiting > 0 ? 0x57f287 : 0xed4245)
    .setDescription(
      [
        totalWaiting > 0
          ? `**${totalWaiting} sorcerer(s)** looking to test their skills!`
          : "No one in queue! ✅",
        "",
        "```",
        `🛠️ Constructed:  ${c}/2`,
        `📦 Sealed:       ${s}/2`,
        `👥 Multiplayer:  ${m}/4`,
        "```",
        `Pick a format to join. Auto-expires in **${queueTtlMinutes} min**.`,
      ].join("\n"),
    )
    .setTimestamp();

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(PANEL_JOIN_CONSTRUCTED)
      .setLabel("Join Constructed")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(PANEL_JOIN_SEALED)
      .setLabel("Join Sealed")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(PANEL_JOIN_MULTIPLAYER)
      .setLabel("Join Multiplayer")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(PANEL_LEAVE)
      .setLabel("Leave Queue")
      .setStyle(ButtonStyle.Danger),
  );

  return {
    embeds: [embed],
    components: [row],
  };
}

async function refreshPanelIfTracked(
  guild: Guild | null,
  context: LfgCommandContext,
): Promise<void> {
  if (!guild) {
    return;
  }

  const tracked = panelMessages.get(guild.id);
  if (!tracked) {
    return;
  }

  const channel = guild.channels.cache.get(tracked.channelId);
  if (!channel || channel.type !== ChannelType.GuildText) {
    panelMessages.delete(guild.id);
    return;
  }

  try {
    const message = await (channel as TextChannel).messages.fetch(tracked.messageId);
    await message.edit(buildPanelMessage(context.queue, guild.id, context.queueTtlMinutes));
  } catch (error) {
    context.logger.warn("Failed to refresh LFG panel message.", {
      guildId: guild.id,
      error,
    });
    panelMessages.delete(guild.id);
  }
}

async function bumpPanelToBottom(guild: Guild | null, context: LfgCommandContext): Promise<void> {
  if (!guild) {
    return;
  }

  const channel = getAnnouncementChannel(guild, context.lfgChannelName);
  if (!channel) {
    return;
  }

  await deleteDuplicatePanelMessages(guild, channel, null, context.logger);

  const sent = await channel.send(buildPanelMessage(context.queue, guild.id, context.queueTtlMinutes));
  panelMessages.set(guild.id, { channelId: channel.id, messageId: sent.id });
}

async function deleteDuplicatePanelMessages(
  guild: Guild,
  channel: TextChannel,
  keepMessageId: string | null,
  logger: Logger,
): Promise<void> {
  try {
    const recentMessages = await channel.messages.fetch({ limit: 100 });
    const panels = recentMessages.filter(
      (message) =>
        message.author.id === guild.client.user?.id &&
        JSON.stringify(message.components).includes("lfg_panel_"),
    );

    for (const message of panels.values()) {
      if (keepMessageId && message.id === keepMessageId) {
        continue;
      }

      try {
        await message.delete();
      } catch (error) {
        logger.warn("Failed deleting duplicate LFG panel message.", {
          guildId: guild.id,
          messageId: message.id,
          error,
        });
      }
    }
  } catch (error) {
    logger.warn("Failed scanning for duplicate LFG panel messages.", {
      guildId: guild.id,
      error,
    });
  }
}

function buttonFormat(customId: string): LfgFormat | null {
  if (customId === PANEL_JOIN_CONSTRUCTED) {
    return "constructed";
  }

  if (customId === PANEL_JOIN_SEALED) {
    return "sealed";
  }

  if (customId === PANEL_JOIN_MULTIPLAYER) {
    return "multiplayer";
  }

  return null;
}

function getAnnouncementChannel(guild: Guild | null, lfgChannelName: string): TextChannel | null {
  if (!guild) {
    return null;
  }

  const channel = guild.channels.cache.find(
    (item) => item.type === ChannelType.GuildText && item.name === lfgChannelName,
  );

  return (channel as TextChannel | undefined) ?? null;
}

async function safeDm(
  interaction: ChatInputCommandInteraction | ButtonInteraction,
  userId: string,
  message: string,
  logger: Logger,
): Promise<void> {
  try {
    const user = await interaction.client.users.fetch(userId);
    await user.send(message);
  } catch (error) {
    logger.warn("Failed to DM user.", { userId, error });
  }
}

async function acknowledgeMatchSilently(
  interaction: ChatInputCommandInteraction | ButtonInteraction,
): Promise<void> {
  if (interaction.isButton()) {
    await interaction.deferUpdate();
    return;
  }

  await interaction.deferReply({ ephemeral: true });
  await interaction.deleteReply().catch(() => undefined);
}

function formatLabel(format: LfgFormat): string {
  const map: Record<LfgFormat, string> = {
    constructed: "Constructed",
    sealed: "Sealed",
    multiplayer: "Multiplayer",
  };

  return map[format];
}

function formatDisplay(format: LfgFormat): string {
  return `${formatLabel(format)}`;
}

function humanizeDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  if (minutes <= 0) {
    return `${Math.max(0, seconds)}s`;
  }

  if (seconds === 0) {
    return `${minutes}m`;
  }

  return `${minutes}m ${seconds}s`;
}

export { FORMATS };
