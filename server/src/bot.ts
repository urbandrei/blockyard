// Discord bot: posts each pending level to a private review channel,
// handles Approve / Deny(reason) / Copy Code buttons. Runs in the same
// Bun process as the HTTP server — only outbound WebSocket to Discord,
// no inbound traffic, so the cloudflared tunnel does not need to expose it.

import {
  Client, GatewayIntentBits, Events, ActionRowBuilder, ButtonBuilder,
  ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle,
  MessageFlags,
  type Interaction, type ButtonInteraction, type ModalSubmitInteraction,
  type TextChannel,
} from 'discord.js';
import type { Store } from './store.ts';
import type { LevelRecord } from './types.ts';
import { buildSubmissionEmbed, chunkShareString, encodeShareString } from './embed.ts';

export interface BotDeps {
  token: string;
  reviewChannelId: string;
  store: Store;
}

export class ReviewBot {
  private client: Client;
  private reviewChannelId: string;
  private store: Store;
  private ready = false;
  private readyResolvers: Array<() => void> = [];

  constructor(private deps: BotDeps) {
    this.reviewChannelId = deps.reviewChannelId;
    this.store = deps.store;
    this.client = new Client({ intents: [GatewayIntentBits.Guilds] });

    this.client.once(Events.ClientReady, (c) => {
      console.log(`[bot] ready as ${c.user.tag}`);
      this.ready = true;
      this.readyResolvers.splice(0).forEach(r => r());
    });

    this.client.on(Events.InteractionCreate, (i) => this.onInteraction(i).catch((e) => {
      console.error('[bot] interaction error', e);
    }));
  }

  async start(): Promise<void> {
    await this.client.login(this.deps.token);
    await new Promise<void>((resolve) => {
      if (this.ready) resolve(); else this.readyResolvers.push(resolve);
    });
  }

  async postSubmission(rec: LevelRecord): Promise<void> {
    const channel = await this.client.channels.fetch(this.reviewChannelId);
    if (!channel || !channel.isTextBased() || !('send' in channel)) {
      throw new Error('review channel not text-based or not accessible');
    }
    const msg = await (channel as TextChannel).send({
      embeds: [buildSubmissionEmbed(rec)],
      components: [buildButtons(rec.id)],
    });
    await this.store.setDiscordMessageId(rec.id, msg.id);
  }

  async refreshMessage(rec: LevelRecord): Promise<void> {
    if (!rec.discordMessageId) return;
    const channel = await this.client.channels.fetch(this.reviewChannelId).catch(() => null);
    if (!channel || !channel.isTextBased()) return;
    const msg = await (channel as TextChannel).messages.fetch(rec.discordMessageId).catch(() => null);
    if (!msg) return;
    await msg.edit({
      embeds: [buildSubmissionEmbed(rec)],
      components: rec.status === 'pending' ? [buildButtons(rec.id)] : [buildCopyOnlyRow(rec.id)],
    });
  }

  private async onInteraction(i: Interaction): Promise<void> {
    if (i.isButton()) return this.onButton(i);
    if (i.isModalSubmit()) return this.onModal(i);
  }

  private async onButton(i: ButtonInteraction): Promise<void> {
    const [ns, action, id] = i.customId.split(':');
    if (ns !== 'by' || !id) return;

    if (action === 'copy') return this.handleCopy(i, id);
    if (action === 'approve') return this.handleApprove(i, id);
    if (action === 'deny') return this.handleDenyOpen(i, id);
  }

  private async handleCopy(i: ButtonInteraction, id: string): Promise<void> {
    const rec = await this.store.readLevel(id);
    if (!rec) return void i.reply({ content: 'level not found', flags: MessageFlags.Ephemeral });
    const share = encodeShareString(rec.level);
    const chunks = chunkShareString(share);
    await i.reply({
      content: `**Share code for ${rec.name}** (paste into Import Level):\n\`\`\`\n${chunks[0]}\n\`\`\``,
      flags: MessageFlags.Ephemeral,
    });
    for (let k = 1; k < chunks.length; k++) {
      await i.followUp({ content: `\`\`\`\n${chunks[k]}\n\`\`\``, flags: MessageFlags.Ephemeral });
    }
  }

  private async handleApprove(i: ButtonInteraction, id: string): Promise<void> {
    const rec = await this.store.setStatus(id, 'public', { approvedBy: i.user.username });
    if (!rec) return void i.reply({ content: 'level not found', flags: MessageFlags.Ephemeral });
    await i.update({
      embeds: [buildSubmissionEmbed(rec)],
      components: [buildCopyOnlyRow(rec.id)],
    });
  }

  private async handleDenyOpen(i: ButtonInteraction, id: string): Promise<void> {
    const modal = new ModalBuilder()
      .setCustomId(`by:denyReason:${id}`)
      .setTitle('Deny level');
    const input = new TextInputBuilder()
      .setCustomId('reason')
      .setLabel('Reason (shown to moderators, not player)')
      .setStyle(TextInputStyle.Paragraph)
      .setRequired(true)
      .setMaxLength(300);
    modal.addComponents(new ActionRowBuilder<TextInputBuilder>().addComponents(input));
    await i.showModal(modal);
  }

  private async onModal(i: ModalSubmitInteraction): Promise<void> {
    const [ns, action, id] = i.customId.split(':');
    if (ns !== 'by' || action !== 'denyReason' || !id) return;
    const reason = i.fields.getTextInputValue('reason').trim();
    const rec = await this.store.setStatus(id, 'rejected', {
      rejectedBy: i.user.username,
      rejectedReason: reason,
    });
    if (!rec) return void i.reply({ content: 'level not found', flags: MessageFlags.Ephemeral });
    await i.update({
      embeds: [buildSubmissionEmbed(rec)],
      components: [buildCopyOnlyRow(rec.id)],
    });
  }
}

function buildButtons(id: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`by:approve:${id}`).setLabel('Approve').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`by:deny:${id}`).setLabel('Deny…').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`by:copy:${id}`).setLabel('Copy Code').setStyle(ButtonStyle.Secondary),
  );
}

function buildCopyOnlyRow(id: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`by:copy:${id}`).setLabel('Copy Code').setStyle(ButtonStyle.Secondary),
  );
}
