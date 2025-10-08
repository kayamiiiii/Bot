// index.js — único arquivo
// Requer: node 18+ (recomendado) ou 16+
// Dependências: discord.js v14, express
// Variáveis de ambiente: TOKEN (recomendado), PORT (opcional)
// Substitua 'INSIRA_SEU_TOKEN_AQUI' por process.env.TOKEN em produção (ou configure no Render).

const express = require('express');
const {
  Client,
  GatewayIntentBits,
  Partials,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  PermissionsBitField,
  ChannelType
} = require('discord.js');

const TOKEN = process.env.TOKEN || 'INSIRA_SEU_TOKEN_AQUI';
const PREFIX = process.env.PREFIX || '-';
const PORT = process.env.PORT || 3000;
const EMBED_COLOR = '#8B4513'; // sua paleta
const MUTED_ROLE_NAME = 'Muted (Bot)';
const MAX_ROLES_PER_COMMAND = 7;

if (!TOKEN || TOKEN === 'INSIRA_SEU_TOKEN_AQUI') {
  console.warn('Atenção: TOKEN não definido (use process.env.TOKEN). Substitua localmente para testar.');
}

// --- Express (mantém processo vivo no Render) ---
const app = express();
app.get('/', (req, res) => res.send('Bot online'));
app.listen(PORT, () => console.log(`Express rodando na porta ${PORT}`));

// --- Client Discord ---
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages
  ],
  partials: [Partials.Channel, Partials.Message]
});

// --- In-memory DB (substitua por Firebase/DB se quiser persistência) ---
const memoryDB = {}; // estrutura: { [guildId]: { commands: { [cmd]: { roles: {roleId:true} } }, warns: { userId:{count,..} }, lockhour: {...}, lockdown_backup: {...} } }

// util helpers for memoryDB
function ensureGuild(guildId) {
  if (!memoryDB[guildId]) memoryDB[guildId] = { commands: {}, warns: {}, lockhour: null, lockdown_backup: {} };
  return memoryDB[guildId];
}
async function getCommandRoles(guildId, command) {
  const g = ensureGuild(guildId);
  if (!g.commands[command]) return [];
  return Object.keys(g.commands[command].roles || {});
}
async function addRoleToCommand(guildId, command, roleId, setterId) {
  const g = ensureGuild(guildId);
  if (!g.commands[command]) g.commands[command] = { roles: {} };
  g.commands[command].roles[roleId] = true;
  g.commands[command].configuredBy = setterId;
  g.commands[command].configuredAt = Date.now();
  return g.commands[command];
}
async function removeRoleFromCommand(guildId, command, roleId, setterId) {
  const g = ensureGuild(guildId);
  if (!g.commands[command]) return null;
  delete g.commands[command].roles[roleId];
  g.commands[command].configuredBy = setterId;
  g.commands[command].configuredAt = Date.now();
  return g.commands[command];
}

// warns
async function getWarns(guildId, userId) {
  const g = ensureGuild(guildId);
  return g.warns[userId] || null;
}
async function setWarns(guildId, userId, payload) {
  const g = ensureGuild(guildId);
  g.warns[userId] = payload;
  return payload;
}
async function deleteWarns(guildId, userId) {
  const g = ensureGuild(guildId);
  delete g.warns[userId];
  return true;
}

// lockhour
async function setLockHour(guildId, payload) {
  const g = ensureGuild(guildId);
  g.lockhour = payload;
  return payload;
}
async function getLockHour(guildId) {
  const g = ensureGuild(guildId);
  return g.lockhour || null;
}
async function deleteLockHour(guildId) {
  const g = ensureGuild(guildId);
  g.lockhour = null;
  return true;
}

// lockdown backup
async function setLockdownBackup(guildId, payload) {
  const g = ensureGuild(guildId);
  g.lockdown_backup = payload;
  return payload;
}
async function getLockdownBackup(guildId) {
  const g = ensureGuild(guildId);
  return g.lockdown_backup || {};
}
async function deleteLockdownBackup(guildId) {
  const g = ensureGuild(guildId);
  g.lockdown_backup = {};
  return true;
}

// --- Utilities ---
function parseDuration(text) {
  if (!text) return null;
  const s = text.trim().toLowerCase();
  // examples: 10m 2h 3d or "2 horas"
  const m = s.match(/^(\d+)\s*(m|minutos?|h|horas?|d|dias?)$/i);
  if (m) {
    const n = parseInt(m[1], 10);
    const u = m[2].toLowerCase();
    if (u.startsWith('m')) return n * 60 * 1000;
    if (u.startsWith('h')) return n * 60 * 60 * 1000;
    if (u.startsWith('d')) return n * 24 * 60 * 60 * 1000;
  }
  const m2 = s.match(/^(\d+)(m|h|d)$/i);
  if (m2) {
    const n = parseInt(m2[1], 10);
    const u = m2[2].toLowerCase();
    if (u === 'm') return n * 60 * 1000;
    if (u === 'h') return n * 60 * 60 * 1000;
    if (u === 'd') return n * 24 * 60 * 60 * 1000;
  }
  return null;
}

function formatDuration(ms) {
  if (!ms) return '0';
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days) return `${days} dia(s)`;
  if (hours) return `${hours} hora(s)`;
  if (minutes) return `${minutes} minuto(s)`;
  return `${seconds} segundo(s)`;
}

function parseTimeInput(input) {
  if (!input) return null;
  const s = input.trim().toLowerCase();
  if (/^(meia[-\s]?noite|meianoite)$/i.test(s)) return { h: 0, m: 0 };
  if (/^(meio[-\s]?dia|meiodia)$/i.test(s)) return { h: 12, m: 0 };
  let m;
  m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (m) {
    const hh = parseInt(m[1], 10);
    const mm = parseInt(m[2], 10);
    if (hh >= 0 && hh < 24 && mm >= 0 && mm < 60) return { h: hh, m: mm };
  }
  m = s.match(/^(\d{1,2})h(\d{2})$/); // 22h30
  if (m) {
    const hh = parseInt(m[1], 10);
    const mm = parseInt(m[2], 10);
    if (hh >= 0 && hh < 24 && mm >= 0 && mm < 60) return { h: hh, m: mm };
  }
  m = s.match(/^(\d{1,2})\s*horas?$/i);
  if (m) {
    const hh = parseInt(m[1], 10);
    if (hh >= 0 && hh < 24) return { h: hh, m: 0 };
  }
  m = s.match(/^(\d{1,2})$/);
  if (m) {
    const hh = parseInt(m[1], 10);
    if (hh >= 0 && hh < 24) return { h: hh, m: 0 };
  }
  return null;
}
function msUntilNext(hour, minute) {
  const now = new Date();
  const next = new Date(now);
  next.setHours(hour, minute, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

// permission checks (basic)
const COMMAND_PERMISSIONS = {
  ban: PermissionsBitField.Flags.BanMembers,
  mute: PermissionsBitField.Flags.ManageRoles,
  unmute: PermissionsBitField.Flags.ManageRoles,
  lock: PermissionsBitField.Flags.ManageChannels,
  unlock: PermissionsBitField.Flags.ManageChannels,
  warn: PermissionsBitField.Flags.ManageMessages,
  warns: PermissionsBitField.Flags.ManageMessages,
  clearwarns: PermissionsBitField.Flags.ManageMessages,
  lockdown: PermissionsBitField.Flags.ManageChannels,
  unlockdown: PermissionsBitField.Flags.ManageChannels,
  lockhour: PermissionsBitField.Flags.Administrator
};
function hasDiscordPermission(member, command) {
  const req = COMMAND_PERMISSIONS[command];
  if (!req) return true;
  return member.permissions.has(req) || member.permissions.has(PermissionsBitField.Flags.Administrator);
}

// --- moderation utilities (mute role, ban, mute, unmute, lock/unlock channels, lockdown) ---
async function ensureMutedRole(guild) {
  let role = guild.roles.cache.find(r => r.name === MUTED_ROLE_NAME);
  if (role) return role;
  if (!guild.members.me.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
    throw new Error('Bot precisa da permissão Gerenciar Cargos para criar role de mute.');
  }
  role = await guild.roles.create({ name: MUTED_ROLE_NAME, permissions: [] });
  // apply basic denies to text/voice channels
  for (const [, ch] of guild.channels.cache) {
    try {
      if (ch.isText()) {
        await ch.permissionOverwrites.edit(role, { SendMessages: false, AddReactions: false }).catch(() => {});
      } else if (ch.type === ChannelType.GuildVoice) {
        await ch.permissionOverwrites.edit(role, { Speak: false, Connect: false }).catch(() => {});
      }
    } catch {}
  }
  return role;
}

async function banUser(guild, moderator, targetId, reason = 'Não informado') {
  if (!guild.members.me.permissions.has(PermissionsBitField.Flags.BanMembers)) throw new Error('Bot sem permissão de ban.');
  try {
    const u = await client.users.fetch(targetId).catch(() => null);
    if (u) {
      await u.send({
        embeds: [
          new EmbedBuilder()
            .setTitle('🔨 Você foi banido')
            .setDescription(`Você foi banido do servidor **${guild.name}**`)
            .addFields({ name: 'Motivo', value: reason }, { name: 'Moderador', value: moderator.user.tag })
            .setColor(EMBED_COLOR)
            .setTimestamp()
        ]
      }).catch(() => {});
    }
  } catch {}
  await guild.members.ban(targetId, { reason });
  return true;
}

const muteTimers = new Map(); // key: guildId-userId => { timeout }
async function muteUser(guild, moderator, targetId, durationMs, reason = 'Não informado') {
  const member = await guild.members.fetch(targetId).catch(() => null);
  if (!member) throw new Error('Usuário não encontrado.');
  if (member.roles.highest.position >= moderator.roles.highest.position) throw new Error('Não pode mutar alguém com cargo igual/maior que o seu.');
  const role = await ensureMutedRole(guild);
  await member.roles.add(role, `Muted by ${moderator.user.tag}: ${reason}`);
  const key = `${guild.id}-${member.id}`;
  if (muteTimers.has(key)) clearTimeout(muteTimers.get(key).timeout);
  const timeout = setTimeout(async () => {
    try {
      const fresh = await guild.members.fetch(member.id).catch(() => null);
      if (fresh && role && fresh.roles.cache.has(role.id)) {
        await fresh.roles.remove(role, 'Unmute automático (expirado)').catch(() => {});
      }
    } catch (e) { console.error('Erro unmute automático', e); }
    muteTimers.delete(key);
  }, durationMs);
  muteTimers.set(key, { timeout, expiresAt: Date.now() + durationMs });
  try {
    await member.send({
      embeds: [
        new EmbedBuilder()
          .setTitle('🔇 Você foi silenciado')
          .setDescription(`Você foi silenciado no servidor **${guild.name}**`)
          .addFields({ name: 'Motivo', value: reason }, { name: 'Duração', value: formatDuration(durationMs) }, { name: 'Moderador', value: moderator.user.tag })
          .setColor(EMBED_COLOR)
          .setTimestamp()
      ]
    }).catch(() => {});
  } catch {}
  return true;
}
async function unmuteUser(guild, moderator, targetId) {
  const member = await guild.members.fetch(targetId).catch(() => null);
  if (!member) throw new Error('Usuário não encontrado.');
  const role = guild.roles.cache.find(r => r.name === MUTED_ROLE_NAME);
  if (!role || !member.roles.cache.has(role.id)) throw new Error('Usuário não está mutado.');
  await member.roles.remove(role, `Unmuted by ${moderator.user.tag}`).catch(err => { throw err; });
  const key = `${guild.id}-${member.id}`;
  if (muteTimers.has(key)) { clearTimeout(muteTimers.get(key).timeout); muteTimers.delete(key); }
  try {
    await member.send({
      embeds: [
        new EmbedBuilder()
          .setTitle('🔊 Você foi desmutado')
          .setDescription(`Seu mute foi removido no servidor **${guild.name}** por ${moderator.user.tag}`)
          .setColor(EMBED_COLOR)
          .setTimestamp()
      ]
    }).catch(() => {});
  } catch {}
  return true;
}

async function lockChannel(guild, moderator, channelId, lock = true) {
  const ch = guild.channels.cache.get(channelId);
  if (!ch) throw new Error('Canal não encontrado.');
  if (!guild.members.me.permissions.has(PermissionsBitField.Flags.ManageChannels)) throw new Error('Bot precisa de ManageChannels.');
  await ch.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: lock ? false : true }).catch(err => { throw err; });
  return ch;
}

async function lockdownAll(guild, moderator) {
  if (!guild.members.me.permissions.has(PermissionsBitField.Flags.ManageChannels)) throw new Error('Bot precisa de ManageChannels.');
  const backup = {};
  for (const [, ch] of guild.channels.cache) {
    try {
      // only text channels
      if (ch.type === ChannelType.GuildText || ch.type === ChannelType.GuildAnnouncement) {
        const overwrite = ch.permissionOverwrites.cache.get(guild.id);
        const hadAllow = overwrite && overwrite.allow && overwrite.allow.has(PermissionsBitField.Flags.SendMessages);
        const hadDeny = overwrite && overwrite.deny && overwrite.deny.has(PermissionsBitField.Flags.SendMessages);
        let sendAllowed = null;
        if (hadAllow) sendAllowed = true;
        else if (hadDeny) sendAllowed = false;
        else sendAllowed = null;
        backup[ch.id] = sendAllowed;
        await ch.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: false }).catch(() => {});
      }
    } catch (e) { console.warn('Erro lockdown canal', ch.id, e); }
  }
  await setLockdownBackup(guild.id, backup).catch(() => {});
  return true;
}

async function unlockdownAll(guild, moderator) {
  if (!guild.members.me.permissions.has(PermissionsBitField.Flags.ManageChannels)) throw new Error('Bot precisa de ManageChannels.');
  const backup = await getLockdownBackup(guild.id) || {};
  for (const channelId of Object.keys(backup)) {
    const ch = guild.channels.cache.get(channelId);
    if (!ch) continue;
    const prev = backup[channelId];
    try {
      if (prev === true) {
        await ch.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: true }).catch(() => {});
      } else if (prev === false) {
        await ch.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: false }).catch(() => {});
      } else {
        await ch.permissionOverwrites.delete(guild.roles.everyone).catch(() => {});
      }
    } catch (e) { console.warn('Erro restore lockdown', channelId, e); }
  }
  await deleteLockdownBackup(guild.id).catch(() => {});
  return true;
}

// --- LockHour scheduler ---
const lockHourTimers = new Map(); // guildId => { startTimeout, endTimeout, startInterval, endInterval }

function clearLockHourTimers(guildId) {
  const t = lockHourTimers.get(guildId);
  if (!t) return;
  if (t.startTimeout) clearTimeout(t.startTimeout);
  if (t.endTimeout) clearTimeout(t.endTimeout);
  if (t.startInterval) clearInterval(t.startInterval);
  if (t.endInterval) clearInterval(t.endInterval);
  lockHourTimers.delete(guildId);
}
async function scheduleLockHourForGuild(guild, config) {
  // config: { enabled, start: {h,m}, end: {h,m}, configuredBy, configuredAt }
  if (!config || !config.enabled) return;
  clearLockHourTimers(guild.id);
  const startMs = msUntilNext(config.start.h, config.start.m);
  const endMs = msUntilNext(config.end.h, config.end.m);

  // Start
  const startTimeout = setTimeout(async () => {
    try { await lockdownAll(guild, guild.members.me); } catch (e) { console.error('LockHour start erro', e); }
    // set recurring every 24h
  }, startMs);

  // End
  const endTimeout = setTimeout(async () => {
    try { await unlockdownAll(guild, guild.members.me); } catch (e) { console.error('LockHour end erro', e); }
  }, endMs);

  // After first run, set intervals to repeat every 24h
  const startIntervalHandle = setTimeout(() => {
    const iv = setInterval(async () => {
      try { await lockdownAll(guild, guild.members.me); } catch (e) { console.error('LockHour recurring start erro', e); }
    }, 24 * 60 * 60 * 1000);
    const cur = lockHourTimers.get(guild.id) || {};
    cur.startInterval = iv;
    lockHourTimers.set(guild.id, cur);
  }, startMs + 1000);

  const endIntervalHandle = setTimeout(() => {
    const iv = setInterval(async () => {
      try { await unlockdownAll(guild, guild.members.me); } catch (e) { console.error('LockHour recurring end erro', e); }
    }, 24 * 60 * 60 * 1000);
    const cur = lockHourTimers.get(guild.id) || {};
    cur.endInterval = iv;
    lockHourTimers.set(guild.id, cur);
  }, endMs + 1000);

  lockHourTimers.set(guild.id, { startTimeout, endTimeout, startInterval: null, endInterval: null });
}

// load existing configs when bot starts
async function loadAllLockHourConfigs() {
  for (const [guildId, guild] of client.guilds.cache) {
    try {
      const cfg = await getLockHour(guildId);
      if (cfg && cfg.enabled) await scheduleLockHourForGuild(guild, cfg);
    } catch (e) { console.warn('Erro ao carregar lockhour', guildId, e); }
  }
}

// --- Carter reply storage ---
const replyMap = new Map(); // nonce -> { fromId, preview }

// --- Interactions (buttons) ---
client.on('interactionCreate', async interaction => {
  try {
    if (!interaction.isButton()) return;
    const id = interaction.customId;

    // Carter: reply button in recipient DM
    if (id.startsWith('reply_')) {
      await interaction.deferReply({ ephemeral: true });
      const nonce = id.slice('reply_'.length);
      const info = replyMap.get(nonce);
      if (!info) return interaction.editReply({ content: 'Link expirado.' });
      await interaction.editReply({ content: '✍️ Escreva a resposta (120s):' });
      const dm = interaction.channel;
      const filter = m => m.author.id === interaction.user.id;
      dm.awaitMessages({ filter, max: 1, time: 120000 }).then(async coll => {
        if (!coll || coll.size === 0) return interaction.followUp({ content: '⌛ Tempo esgotado.', ephemeral: true });
        const text = coll.first().content;
        const original = await client.users.fetch(info.fromId).catch(() => null);
        if (!original) return interaction.followUp({ content: 'Remetente não encontrado.', ephemeral: true });
        const embed = new EmbedBuilder().setTitle('💬 Resposta via Carter').setDescription(text).addFields({ name: 'Respondente', value: `${interaction.user.tag}` }).setColor(EMBED_COLOR).setTimestamp();
        try { await original.send({ embeds: [embed] }); await interaction.followUp({ content: '✅ Resposta enviada.', ephemeral: true }); } catch (e) { await interaction.followUp({ content: '❌ Falha ao enviar DM.', ephemeral: true }); }
        replyMap.delete(nonce);
      }).catch(async () => { await interaction.followUp({ content: '⌛ Tempo esgotado.', ephemeral: true }); });
      return;
    }

    // Setup flow buttons
    if (id.startsWith('setup_cmd_')) {
      // format: setup_cmd_{command}_{adminId}
      const parts = id.split('_');
      const commandName = parts[2];
      const adminId = parts[3];
      if (interaction.user.id !== adminId) return interaction.reply({ content: 'Só o autor pode usar estes botões.', ephemeral: true });
      const guild = interaction.guild;
      const roles = guild.roles.cache.filter(r => r.id !== guild.id).map(r => ({ id: r.id, name: r.name }));
      if (!roles.length) return interaction.update({ content: 'Nenhum cargo disponível.', embeds: [], components: [] });
      const rows = [];
      for (let i = 0; i < roles.length && i < 20; i += 5) {
        const chunk = roles.slice(i, i + 5);
        const row = new ActionRowBuilder();
        for (const r of chunk) row.addComponents(new ButtonBuilder().setCustomId(`setup_role_${commandName}_${r.id}_${adminId}`).setLabel(r.name.length > 80 ? r.name.slice(0, 77) + '...' : r.name).setStyle(ButtonStyle.Primary));
        rows.push(row);
      }
      rows.push(new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`setup_done_${commandName}_${adminId}`).setLabel('Concluir').setStyle(ButtonStyle.Success), new ButtonBuilder().setCustomId(`setup_cancel_${commandName}_${adminId}`).setLabel('Cancelar').setStyle(ButtonStyle.Secondary)));
      const embed = new EmbedBuilder().setTitle(`Configurar: ${commandName.toUpperCase()}`).setDescription('Clique em um cargo para adicionar/remover (máx 7).').setColor(EMBED_COLOR);
      return interaction.update({ embeds: [embed], components: rows });
    }

    if (id.startsWith('setup_role_')) {
      // setup_role_{command}_{roleId}_{adminId}
      const parts = id.split('_');
      const commandName = parts[2];
      const roleId = parts[3];
      const adminId = parts[4];
      if (interaction.user.id !== adminId) return interaction.reply({ content: 'Só o autor pode usar.', ephemeral: true });
      const guild = interaction.guild;
      const role = guild.roles.cache.get(roleId);
      if (!role) return interaction.reply({ content: 'Cargo não encontrado.', ephemeral: true });
      const rolesNow = await getCommandRoles(guild.id, commandName);
      const present = rolesNow.includes(roleId);
      if (!present) {
        if (rolesNow.length >= MAX_ROLES_PER_COMMAND) return interaction.reply({ content: `Máximo de ${MAX_ROLES_PER_COMMAND} cargos atingido.`, ephemeral: true });
        await addRoleToCommand(guild.id, commandName, roleId, interaction.user.id);
        return interaction.reply({ content: `✅ Cargo **${role.name}** ADICIONADO ao comando **${commandName}**.`, ephemeral: true });
      } else {
        const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`setup_remove_${commandName}_${roleId}_${adminId}`).setLabel('Remover').setStyle(ButtonStyle.Danger), new ButtonBuilder().setCustomId(`setup_keep_${commandName}_${roleId}_${adminId}`).setLabel('Manter').setStyle(ButtonStyle.Secondary));
        return interaction.reply({ content: `Cargo **${role.name}** já configurado para **${commandName}**. Deseja remover?`, components: [row], ephemeral: true });
      }
    }

    if (id.startsWith('setup_remove_')) {
      const parts = id.split('_');
      const commandName = parts[2];
      const roleId = parts[3];
      const adminId = parts[4];
      if (interaction.user.id !== adminId) return interaction.reply({ content: 'Só o autor pode usar.', ephemeral: true });
      const guild = interaction.guild;
      const role = guild.roles.cache.get(roleId);
      await removeRoleFromCommand(guild.id, commandName, roleId, interaction.user.id);
      return interaction.update({ content: `✅ Cargo **${role ? role.name : roleId}** removido do comando **${commandName}**.`, embeds: [], components: [] });
    }

    if (id.startsWith('setup_done_')) {
      const parts = id.split('_');
      const commandName = parts[2];
      const adminId = parts[3];
      if (interaction.user.id !== adminId) return interaction.reply({ content: 'Só o autor pode concluir.', ephemeral: true });
      const rolesNow = await getCommandRoles(interaction.guild.id, commandName);
      const desc = rolesNow && rolesNow.length ? `Cargos autorizados: ${rolesNow.map(r => `<@&${r}>`).join(', ')}` : 'Nenhum cargo configurado.';
      const embed = new EmbedBuilder().setTitle(`Configuração finalizada: ${commandName.toUpperCase()}`).setDescription(desc).setColor(EMBED_COLOR).setTimestamp();
      return interaction.update({ embeds: [embed], components: [] });
    }
    if (id.startsWith('setup_cancel_')) return interaction.update({ content: 'Operação cancelada.', embeds: [], components: [] });

    // SetupHour buttons (disable)
    if (id.startsWith('setuphour_disable_')) {
      const adminId = id.split('_')[2];
      if (interaction.user.id !== adminId) return interaction.reply({ content: 'Só o autor pode usar.', ephemeral: true });
      const guildId = interaction.guild.id;
      await deleteLockHour(guildId);
      clearLockHourTimers(guildId);
      return interaction.update({ content: '✅ LockHour desativado.', embeds: [], components: [] });
    }

    // confirmations (ban/mute/warn) handled via collectors in message flow — respond minimally
    if (id.startsWith('confirm_') || id.startsWith('cancel_')) {
      return interaction.reply({ content: 'Confirmação tratada no fluxo original.', ephemeral: true });
    }

  } catch (e) {
    console.error('Erro interactionCreate:', e);
    try { if (!interaction.replied) await interaction.reply({ content: 'Erro interno.', ephemeral: true }); } catch {}
  }
});

// --- Message commands ---
client.on('messageCreate', async message => {
  try {
    if (message.author.bot) return;
    if (!message.content.startsWith(PREFIX)) return;
    const raw = message.content.slice(PREFIX.length).trim();
    const argv = raw.split(/\s+/).filter(Boolean);
    const command = (argv[0] || '').toLowerCase();
    const args = argv.slice(1);

    // HELP
    if (command === 'help') {
      const embed = new EmbedBuilder().setTitle('📚 Ajuda — Comandos').setColor(EMBED_COLOR)
        .setDescription('Lista de comandos principais')
        .addFields(
          { name: `${PREFIX}setup`, value: 'Painel para configurar cargos autorizados.' },
          { name: `${PREFIX}setuphourlock`, value: 'Configurar lock diário por hora (apenas admins).' },
          { name: `${PREFIX}ban <@user|id> [motivo]`, value: 'Confirmação por botão, aplica ban.' },
          { name: `${PREFIX}mute <@user|id> <duração> [motivo]`, value: 'Confirmação e mute temporário.' },
          { name: `${PREFIX}unmute <@user|id>`, value: 'Remove mute.' },
          { name: `${PREFIX}warn <@user|id>`, value: 'Pede motivo (obrigatório) + confirmação.' },
          { name: `${PREFIX}warns <@user|id?>`, value: 'Mostra warns.' },
          { name: `${PREFIX}clearwarns <@user|id>`, value: 'Limpa warns.' },
          { name: `${PREFIX}lock <canalId?> / ${PREFIX}unlock <canalId?>`, value: 'Tranca/destranca canal (ID ou canal atual).' },
          { name: `${PREFIX}lockdown / ${PREFIX}unlockdown`, value: 'Lock/Unlock todos canais (backup).' },
          { name: `${PREFIX}lockhour`, value: 'Mostra configuração atual de LockHour.' },
          { name: `${PREFIX}carter`, value: 'Fluxo em DM para enviar mensagem com confirmação (usar em DM).' }
        );
      return message.channel.send({ embeds: [embed] });
    }

    // SETUP (panel)
    if (command === 'setup') {
      if (!message.guild) return message.reply('⚠️ -setup deve ser executado no servidor.');
      if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) return message.reply('🚫 Apenas administradores podem usar -setup.');
      const commands = ['ban','mute','warn','lock','unlock','clearwarns','warns','lockdown','lockhour'];
      const rows = [];
      for (let i = 0; i < commands.length; i += 5) {
        const chunk = commands.slice(i, i + 5);
        const row = new ActionRowBuilder();
        for (const cmd of chunk) row.addComponents(new ButtonBuilder().setCustomId(`setup_cmd_${cmd}_${message.author.id}`).setLabel(cmd.toUpperCase()).setStyle(ButtonStyle.Primary));
        rows.push(row);
      }
      const embed = new EmbedBuilder().setTitle('🛠 Painel de Setup').setDescription('Clique em um comando para configurar cargos autorizados (máx 7 por comando). Apenas você pode interagir com este painel.').setColor(EMBED_COLOR);
      return message.reply({ embeds: [embed], components: rows });
    }

    // SETUPHOURLOCK guided flow
    if (command === 'setuphourlock') {
      if (!message.guild) return message.reply('⚠️ Use no servidor.');
      if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) return message.reply('🚫 Apenas admins podem usar.');
      await message.reply('🕒 Informe o horário inicial (ex: 22:00, 22h00, 22 horas, meia-noite). Você tem 90s:');
      let startInput;
      try {
        const coll = await message.channel.awaitMessages({ filter: m => m.author.id === message.author.id, max: 1, time: 90000, errors: ['time'] });
        startInput = coll.first().content.trim();
      } catch {
        return message.reply('⌛ Tempo esgotado. Reexecute -setuphourlock.');
      }
      const startParsed = parseTimeInput(startInput);
      if (!startParsed) return message.reply('Horário inicial inválido.');

      await message.reply('🕒 Informe o horário final (quando o bloqueio termina). Você tem 90s:');
      let endInput;
      try {
        const coll2 = await message.channel.awaitMessages({ filter: m => m.author.id === message.author.id, max: 1, time: 90000, errors: ['time'] });
        endInput = coll2.first().content.trim();
      } catch {
        return message.reply('⌛ Tempo esgotado. Reexecute -setuphourlock.');
      }
      const endParsed = parseTimeInput(endInput);
      if (!endParsed) return message.reply('Horário final inválido.');

      const preview = new EmbedBuilder().setTitle('🛡 Confirmação LockHour').setColor(EMBED_COLOR)
        .setDescription('Deseja ativar o Lock diário com os horários abaixo?')
        .addFields(
          { name: 'Início', value: `${String(startParsed.h).padStart(2,'0')}:${String(startParsed.m).padStart(2,'0')}`, inline: true },
          { name: 'Término', value: `${String(endParsed.h).padStart(2,'0')}:${String(endParsed.m).padStart(2,'0')}`, inline: true },
          { name: 'Configurado por', value: `${message.author.tag}`, inline: false }
        );
      const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`lockhour_confirm_${message.id}`).setLabel('Ativar').setStyle(ButtonStyle.Success), new ButtonBuilder().setCustomId(`lockhour_cancel_${message.id}`).setLabel('Cancelar').setStyle(ButtonStyle.Secondary));
      const confMsg = await message.channel.send({ embeds: [preview], components: [row] });
      const filter = i => i.user.id === message.author.id && (i.customId === `lockhour_confirm_${message.id}` || i.customId === `lockhour_cancel_${message.id}`);
      const collector = confMsg.createMessageComponentCollector({ filter, max: 1, time: 30000 });
      collector.on('collect', async i => {
        if (i.customId === `lockhour_cancel_${message.id}`) return i.update({ content: '❌ Cancelado.', embeds: [], components: [] });
        const payload = { enabled: true, start: startParsed, end: endParsed, configuredBy: message.author.id, configuredAt: Date.now() };
        await setLockHour(message.guild.id, payload);
        try { await scheduleLockHourForGuild(message.guild, payload); } catch (e) { console.error('Erro scheduleLockHour', e); }
        await i.update({ content: `✅ LockHour ativado: ${String(startParsed.h).padStart(2,'0')}:${String(startParsed.m).padStart(2,'0')} → ${String(endParsed.h).padStart(2,'0')}:${String(endParsed.m).padStart(2,'0')}`, embeds: [], components: [] });
      });
      collector.on('end', collected => {
        if (collected.size === 0) confMsg.edit({ content: '⌛ Tempo esgotado — não confirmado.', embeds: [], components: [] }).catch(() => {});
      });
      return;
    }

    // CARTER (DM flow)
    if (command === 'carter') {
      if (message.channel.type !== ChannelType.DM) return message.reply('Carter só funciona em DM com o bot.');
      let targetArg = args[0];
      if (!targetArg) {
        await message.channel.send('Para quem deseja enviar? Responda com menção ou ID (60s).');
        try {
          const coll = await message.channel.awaitMessages({ filter: m => m.author.id === message.author.id, max: 1, time: 60000, errors: ['time'] });
          targetArg = coll.first().content.trim();
        } catch {
          return message.channel.send('⌛ Cancelado por timeout.');
        }
      }
      const mention = targetArg.match(/^<@!?(\d+)>$/);
      const targetId = mention ? mention[1] : targetArg.replace(/\D/g,'');
      const targetUser = await client.users.fetch(targetId).catch(() => null);
      if (!targetUser) return message.channel.send('Usuário não encontrado.');

      await message.channel.send(`✍️ Digite a mensagem para ${targetUser.tag} (60s):`);
      let messageText;
      try {
        const coll = await message.channel.awaitMessages({ filter: m => m.author.id === message.author.id, max: 1, time: 60000, errors: ['time'] });
        messageText = coll.first().content.trim();
      } catch {
        return message.channel.send('⌛ Cancelado por timeout.');
      }
      if (!messageText) return message.channel.send('Mensagem vazia.');

      const preview = new EmbedBuilder().setTitle('📨 Confirmação - Carter').setColor(EMBED_COLOR)
        .addFields(
          { name: 'Destinatário', value: `${targetUser.tag} (<@${targetUser.id}>)` },
          { name: 'Remetente', value: `${message.author.tag}` },
          { name: 'Mensagem', value: messageText.length > 1024 ? messageText.slice(0, 1020) + '...' : messageText },
          { name: 'Aviso', value: 'Se a mensagem for ofensiva/ameaçadora/ilegal, você pode ser responsabilizado.' }
        ).setTimestamp();

      const nonce = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`carter_send_${nonce}`).setLabel('Enviar').setStyle(ButtonStyle.Success), new ButtonBuilder().setCustomId(`carter_cancel_${nonce}`).setLabel('Cancelar').setStyle(ButtonStyle.Secondary));
      const confirmMsg = await message.channel.send({ embeds: [preview], components: [row] });
      const filter = i => i.user.id === message.author.id && (i.customId === `carter_send_${nonce}` || i.customId === `carter_cancel_${nonce}`);
      const collector = confirmMsg.createMessageComponentCollector({ filter, max: 1, time: 30000 });
      collector.on('collect', async i => {
        if (i.customId === `carter_cancel_${nonce}`) return i.update({ content: '❌ Envio cancelado.', embeds: [], components: [] });
        await i.update({ content: '⏳ Enviando...', embeds: [], components: [] }).catch(() => {});
        const dmEmbed = new EmbedBuilder().setTitle('📩 Você recebeu uma mensagem').setDescription(messageText).addFields({ name: 'Enviada por', value: `${message.author.tag}` }, { name: 'ID do remetente', value: `${message.author.id}` }).setColor(EMBED_COLOR).setTimestamp();
        replyMap.set(nonce, { fromId: message.author.id, preview: messageText });
        const replyRow = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`reply_${nonce}`).setLabel('Responder').setStyle(ButtonStyle.Primary));
        let dmSuccess = false;
        try { await targetUser.send({ embeds: [dmEmbed], components: [replyRow] }); dmSuccess = true; } catch (e) { dmSuccess = false; }
        const resultEmbed = new EmbedBuilder().setTitle(dmSuccess ? '✅ Mensagem enviada' : '⚠️ Falha ao enviar DM').setColor(dmSuccess ? '#22c55e' : '#e45656').addFields({ name: 'Destinatário', value: `${targetUser.tag}` }, { name: 'Observação', value: dmSuccess ? 'Mensagem entregue.' : 'Não foi possível entregar — DMs bloqueadas?' }).setTimestamp();
        await message.channel.send({ embeds: [resultEmbed] }).catch(() => {});
      });
      collector.on('end', collected => {
        if (collected.size === 0) confirmMsg.edit({ content: '⌛ Tempo esgotado — envio não confirmado.', embeds: [], components: [] }).catch(() => {});
      });
      return;
    }

    // Moderation commands list
    const modCommands = ['ban','mute','unmute','lock','unlock','warn','warns','clearwarns','lockdown','unlockdown','lockhour'];
    if (modCommands.includes(command)) {
      if (!message.guild) return message.reply('Comando só no servidor.');
      if (!hasDiscordPermission(message.member, command)) return message.reply('🚫 Permissão Discord necessária.');
      const rolesConfigured = await getCommandRoles(message.guild.id, command);
      if (!rolesConfigured || rolesConfigured.length === 0) {
        return message.reply(`❌ Comando não configurado. Peça a um admin executar \`${PREFIX}setup\` e configurar este comando.`);
      }
      // role check (admin bypass)
      if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
        const allowed = rolesConfigured;
        const hasRole = allowed.some(rid => message.member.roles.cache.has(rid));
        if (!hasRole) return message.reply('🚫 Você não tem um dos cargos autorizados.');
      }

      // BAN
      if (command === 'ban') {
        const target = args[0];
        const reason = args.slice(1).join(' ') || 'Não informado';
        if (!target) return message.reply(`Uso: ${PREFIX}ban <@user|id> [motivo]`);
        const mention = target.match(/^<@!?(\d+)>$/);
        const targetId = mention ? mention[1] : target.replace(/\D/g,'');
        const targetUser = await client.users.fetch(targetId).catch(() => null);
        if (!targetUser) return message.reply('Usuário não encontrado.');
        const embed = new EmbedBuilder().setTitle('⚠️ Confirmação de Ban').setColor(EMBED_COLOR).setDescription(`Deseja banir ${targetUser.tag}?`).addFields({ name: 'Motivo', value: reason }, { name: 'Moderador', value: message.author.tag }).setTimestamp();
        const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`confirm_ban_${message.id}_${targetId}`).setLabel('Confirmar').setStyle(ButtonStyle.Danger), new ButtonBuilder().setCustomId(`cancel_ban_${message.id}_${targetId}`).setLabel('Cancelar').setStyle(ButtonStyle.Secondary));
        const confMsg = await message.channel.send({ embeds: [embed], components: [row] });
        const filter = i => i.user.id === message.author.id && (i.customId === `confirm_ban_${message.id}_${targetId}` || i.customId === `cancel_ban_${message.id}_${targetId}`);
        const collector = confMsg.createMessageComponentCollector({ filter, max: 1, time: 30000 });
        collector.on('collect', async i => {
          if (i.customId === `cancel_ban_${message.id}_${targetId}`) return i.update({ content: '❌ Ban cancelado.', embeds: [], components: [] });
          await i.update({ content: '⏳ Aplicando ban...', embeds: [], components: [] }).catch(() => {});
          try {
            await banUser(message.guild, message.member, targetId, reason);
            await message.channel.send({ embeds: [ new EmbedBuilder().setTitle('✅ Ban aplicado').setDescription(`${targetUser.tag} banido por ${message.author.tag}`).addFields({ name:'Motivo', value: reason }).setColor(EMBED_COLOR).setTimestamp() ] });
          } catch (e) {
            await message.channel.send(`❌ Erro ao banir: ${e.message || e}`);
          }
        });
        collector.on('end', collected => { if (collected.size === 0) confMsg.edit({ content: '⌛ Tempo esgotado — não confirmado.', embeds: [], components: [] }).catch(() => {}); });
        return;
      }

      // MUTE
      if (command === 'mute') {
        const target = args[0];
        const dur = args[1];
        const reason = args.slice(2).join(' ') || 'Não informado';
        if (!target || !dur) return message.reply(`Uso: ${PREFIX}mute <@user|id> <duração ex: 10m 2h 3d> [motivo]`);
        const durationMs = parseDuration(dur);
        if (!durationMs) return message.reply('Duração inválida (ex: 10m 2h 3d).');
        const targetId = (target.match(/^<@!?(\d+)>$/) ? target.match(/^<@!?(\d+)>$/)[1] : target.replace(/\D/g,''));
        const targetUser = await client.users.fetch(targetId).catch(() => null);
        if (!targetUser) return message.reply('Usuário não encontrado.');
        const embed = new EmbedBuilder().setTitle('⚠️ Confirmação de Mute').setColor(EMBED_COLOR).setDescription(`Deseja mutar ${targetUser.tag}?`).addFields({ name: 'Duração', value: formatDuration(durationMs) }, { name: 'Motivo', value: reason }).setTimestamp();
        const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`confirm_mute_${message.id}_${targetId}_${durationMs}`).setLabel('Confirmar').setStyle(ButtonStyle.Danger), new ButtonBuilder().setCustomId(`cancel_mute_${message.id}_${targetId}`).setLabel('Cancelar').setStyle(ButtonStyle.Secondary));
        const confMsg = await message.channel.send({ embeds: [embed], components: [row] });
        const filter = i => i.user.id === message.author.id && (i.customId === `confirm_mute_${message.id}_${targetId}_${durationMs}` || i.customId === `cancel_mute_${message.id}_${targetId}`);
        const collector = confMsg.createMessageComponentCollector({ filter, max: 1, time: 30000 });
        collector.on('collect', async i => {
          if (i.customId === `cancel_mute_${message.id}_${targetId}`) return i.update({ content: '❌ Mute cancelado.', embeds: [], components: [] });
          await i.update({ content: '⏳ Aplicando mute...', embeds: [], components: [] }).catch(() => {});
          try {
            await muteUser(message.guild, message.member, targetId, durationMs, reason);
            await message.channel.send({ embeds: [ new EmbedBuilder().setTitle('🔇 Mutado').setDescription(`${targetUser.tag} mutado por ${formatDuration(durationMs)}`).addFields({ name:'Motivo', value:reason }).setColor(EMBED_COLOR).setTimestamp() ] });
          } catch (e) {
            await message.channel.send(`❌ Erro ao mutar: ${e.message || e}`);
          }
        });
        collector.on('end', collected => { if (collected.size === 0) confMsg.edit({ content: '⌛ Tempo esgotado — não confirmado.', embeds: [], components: [] }).catch(() => {}); });
        return;
      }

      // UNMUTE
      if (command === 'unmute') {
        const target = args[0];
        if (!target) return message.reply(`Uso: ${PREFIX}unmute <@user|id>`);
        const targetId = (target.match(/^<@!?(\d+)>$/) ? target.match(/^<@!?(\d+)>$/)[1] : target.replace(/\D/g,''));
        try {
          await unmuteUser(message.guild, message.member, targetId);
          return message.reply('✅ Usuário desmutado.');
        } catch (e) {
          return message.reply(`❌ Erro: ${e.message || e}`);
        }
      }

      // LOCK / UNLOCK
      if (command === 'lock' || command === 'unlock') {
        const channelId = args[0] || message.channel.id;
        try {
          const ch = await lockChannel(message.guild, message.member, channelId, command === 'lock');
          return message.reply(`${command === 'lock' ? '🔒 Canal trancado' : '🔓 Canal destrancado'}: <#${ch.id}>`);
        } catch (e) {
          return message.reply(`❌ Erro: ${e.message || e}`);
        }
      }

      // WARN (requires reason and confirmation)
      if (command === 'warn') {
        const target = args[0];
        if (!target) return message.reply(`Uso: ${PREFIX}warn <@user|id>`);
        const id = (target.match(/^<@!?(\d+)>$/) ? target.match(/^<@!?(\d+)>$/)[1] : target.replace(/\D/g,''));
        const member = await message.guild.members.fetch(id).catch(() => null);
        if (!member) return message.reply('Usuário não encontrado.');
        if (member.roles.highest.position >= message.member.roles.highest.position) return message.reply('🚫 Não pode advertir usuário com cargo igual/maior que o seu.');
        // ask for reason
        await message.reply(`✍️ Informe o **motivo** da advertência para ${member.user.tag} (obrigatório). Você tem 90s:`);
        let reasonText;
        try {
          const coll = await message.channel.awaitMessages({ filter: m => m.author.id === message.author.id, max: 1, time: 90000, errors: ['time'] });
          reasonText = coll.first().content.trim();
        } catch {
          return message.reply('⌛ Tempo esgotado. Reexecute -warn.');
        }
        if (!reasonText) return message.reply('❌ Motivo obrigatório. Abortando.');
        // confirm
        const preview = new EmbedBuilder().setTitle('⚠️ Confirmação de Advertência').setColor(EMBED_COLOR).setDescription(`Deseja advertir **${member.user.tag}** pelo motivo abaixo?`).addFields({ name:'Motivo', value: reasonText }, { name:'Moderador', value: message.author.tag }).setTimestamp();
        const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`confirm_warn_${message.id}_${member.id}`).setLabel('Enviar').setStyle(ButtonStyle.Success), new ButtonBuilder().setCustomId(`cancel_warn_${message.id}_${member.id}`).setLabel('Cancelar').setStyle(ButtonStyle.Secondary));
        const confMsg = await message.channel.send({ embeds: [preview], components: [row] });
        const filter = i => i.user.id === message.author.id && (i.customId === `confirm_warn_${message.id}_${member.id}` || i.customId === `cancel_warn_${message.id}_${member.id}`);
        const collector = confMsg.createMessageComponentCollector({ filter, max: 1, time: 30000 });
        collector.on('collect', async i => {
          if (i.customId === `cancel_warn_${message.id}_${member.id}`) return i.update({ content: '❌ Advertência cancelada.', embeds: [], components: [] });
          await i.update({ content: '⏳ Aplicando advertência...', embeds: [], components: [] }).catch(() => {});
          try {
            const cur = await getWarns(message.guild.id, member.id);
            const next = (cur && cur.count) ? cur.count + 1 : 1;
            await setWarns(message.guild.id, member.id, { count: next, lastReason: reasonText, lastBy: message.author.id, lastAt: Date.now() });
            try { await member.send({ embeds: [ new EmbedBuilder().setTitle('⚠️ Você recebeu uma advertência').setDescription(`Você recebeu uma advertência em **${message.guild.name}**`).addFields({name:'Motivo',value:reasonText},{name:'Advertência Nº',value:String(next)},{name:'Moderador',value:message.author.tag}).setColor(EMBED_COLOR).setTimestamp() ] }).catch(()=>{}); } catch {}
            await message.channel.send({ embeds: [ new EmbedBuilder().setTitle('✅ Advertência aplicada').setDescription(`${member.user.tag} advertido por ${message.author.tag}`).addFields({ name:'Motivo', value: reasonText }, { name:'Total warns', value: String(next) }).setColor(EMBED_COLOR).setTimestamp() ] });
          } catch (e) {
            await message.channel.send(`❌ Erro: ${e.message || e}`);
          }
        });
        collector.on('end', collected => { if (collected.size === 0) confMsg.edit({ content: '⌛ Tempo esgotado — não confirmado.', embeds: [], components: [] }).catch(() => {}); });
        return;
      }

      // WARNS
      if (command === 'warns') {
        const target = args[0] || message.author.id;
        const id = (target.match(/^<@!?(\d+)>$/) ? target.match(/^<@!?(\d+)>$/)[1] : target.replace(/\D/g,''));
        const cur = await getWarns(message.guild.id, id);
        const c = (cur && cur.count) ? cur.count : 0;
        return message.reply({ embeds: [ new EmbedBuilder().setTitle('📋 Warns').setDescription(`<@${id}> tem ${c} warn(s)`).setColor(EMBED_COLOR) ] });
      }

      // CLEARWARNS
      if (command === 'clearwarns') {
        const target = args[0];
        if (!target) return message.reply(`Uso: ${PREFIX}clearwarns <@user|id>`);
        const id = (target.match(/^<@!?(\d+)>$/) ? target.match(/^<@!?(\d+)>$/)[1] : target.replace(/\D/g,''));
        await deleteWarns(message.guild.id, id);
        return message.reply(`✅ Warns de <@${id}> limpos.`);
      }

      // LOCKDOWN / UNLOCKDOWN
      if (command === 'lockdown') {
        try {
          await lockdownAll(message.guild, message.member);
          return message.reply('🔐 Lockdown ativado em todos os canais (backup salvo).');
        } catch (e) {
          return message.reply(`❌ Erro: ${e.message || e}`);
        }
      }
      if (command === 'unlockdown') {
        try {
          await unlockdownAll(message.guild, message.member);
          return message.reply('🔓 Lockdown revertido (tentativa de restauração).');
        } catch (e) {
          return message.reply(`❌ Erro: ${e.message || e}`);
        }
      }

      // LOCKHOUR show
      if (command === 'lockhour') {
        const cfg = await getLockHour(message.guild.id);
        if (!cfg || !cfg.enabled) return message.reply('🔕 LockHour não configurado.');
        return message.reply({ embeds: [ new EmbedBuilder().setTitle('⏰ LockHour').setColor(EMBED_COLOR).addFields({ name:'Início', value:`${String(cfg.start.h).padStart(2,'0')}:${String(cfg.start.m).padStart(2,'0')}`, inline:true }, { name:'Término', value:`${String(cfg.end.h).padStart(2,'0')}:${String(cfg.end.m).padStart(2,'0')}`, inline:true }, { name:'Configurado por', value:`<@${cfg.configuredBy}>` }).setTimestamp() ] });
      }

    } // end mod commands

  } catch (err) {
    console.error('Erro messageCreate:', err);
    try { if (message && message.channel) await message.channel.send('❌ Erro interno. Veja logs.'); } catch {}
  }
});

// --- Ready: schedule saved lockhours ---
client.once('ready', async () => {
  console.log(`Bot online: ${client.user.tag}`);
  await loadAllLockHourConfigs();
});

// --- Login ---
client.login(TOKEN).catch(err => {
  console.error('Erro ao logar. Verifique TOKEN:', err);
});
