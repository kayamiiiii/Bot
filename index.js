/**
 * index.js — Bot completo (único arquivo)
 *
 * Funcionalidades incluídas (conforme solicitado):
 * - prefixo (default "-")
 * - painel de setup via botão: selecionar comando -> selecionar cargos (botões)
 *   * até 7 cargos por comando (toggle add/remove)
 *   * se cargo já configurado, pergunta remoção por confirmação (botões)
 *   * apenas administrador pode iniciar -setup
 * - persistência de configurações via Firebase Realtime Database (REST)
 *   * usa FIREBASE_DATABASE_URL (env) — pode ser o URL que você forneceu
 * - verificação dupla para executar comandos:
 *   * o usuário precisa ter permissão do Discord (BanMembers, ManageRoles, ManageChannels, etc)
 *   * e precisa ter um dos cargos configurados no setup (ou Administrador)
 *   * se comando não configurado, o bot avisa para executar `-setup <comando>`
 * - comandos de moderação:
 *   * -ban <@user|id> [motivo]             (request: BanMembers)
 *   * -mute <@user|id> <duração> [motivo]  (requires ManageRoles)
 *   * -unmute <@user|id>                   (requires ManageRoles)
 *   * -lock <channelId?>                   (requires ManageChannels) (lock channel)
 *   * -unlock <channelId?>                 (requires ManageChannels)
 *   * -warn <@user|id> [motivo]            (requires ManageMessages)
 *   * -warns <@user|id?>                   (show warns stored in DB)
 *   * -clearwarns <@user|id>               (clear warns)
 *   * -lockdown                             (locks all text channels) / -unlockdown to revert
 * - sistema de Carter (DM-only) com preview, confirmação por botões, envio por DM
 *   * destinatário recebe botão "Responder" que abre um fluxo de resposta (DM)
 * - comando -help que exibe todos os comandos (embed)
 * - uptime HTTP server (PORT env)
 *
 * Dependências: discord.js v14, express, (node-fetch se Node < 18)
 * Instalar: npm install discord.js express node-fetch
 *
 * Variáveis de ambiente esperadas:
 * - TOKEN (obrigatório)
 * - FIREBASE_DATABASE_URL (opcional — se não setada usa a URL padrão fornecida)
 * - PREFIX (opcional, default '-')
 * - PORT (opcional, default 3000)
 *
 * Observações:
 * - Realtime DB via REST exige que suas regras permitam leitura/escrita nos caminhos usados
 *   (para testes, config temporariamente aberta). Para produção, proteja as regras.
 * - Mute timers e backups de permissões do lockdown são mantidos em memória; reiniciar o bot
 *   perde timers pendentes (pode ser melhorado com persistência).
 */

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

// fetch compat (Node 18+ tem global fetch)
let fetcher = global.fetch;
if (!fetcher) {
  try { fetcher = require('node-fetch'); } catch (e) { console.error('Instale node-fetch para suporte a fetch em Node < 18'); process.exit(1); }
}

// ---- Config / env ----
const TOKEN = process.env.TOKEN || 'INSIRA_SEU_TOKEN_AQUI';
const FIREBASE_DATABASE_URL = (process.env.FIREBASE_DATABASE_URL || 'https://docucraft-cn9pi-default-rtdb.firebaseio.com').replace(/\/$/, '');
const PREFIX = process.env.PREFIX || '-';
const PORT = process.env.PORT || 3000;
const EMBED_COLOR = '#8B4513';
const MUTED_ROLE_NAME = process.env.MUTED_ROLE_NAME || 'Muted (Bot)';
const MAX_ROLES_PER_COMMAND = 7;

// ---- express para uptime ----
const app = express();
app.get('/', (req, res) => res.send('Bot rodando'));
app.listen(PORT, () => console.log(`HTTP server ouvindo na porta ${PORT}`));

// ---- discord client ----
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

// ---- in-memory state ----
const muteTimers = new Map(); // key `${guildId}-${userId}` => { timeout, expiresAt }
const lockdownBackups = new Map(); // key guildId => { channelId: { sendMessagesAllowed: bool or null } }
const replyMap = new Map(); // nonce -> { fromId, toId, preview } for Carter replies

// ---- helper Firebase REST paths ----
function pathCommandConfig(guildId, command) {
  return `${FIREBASE_DATABASE_URL}/guilds/${encodeURIComponent(guildId)}/commands/${encodeURIComponent(command)}.json`;
}
function pathWarns(guildId, userId) {
  return `${FIREBASE_DATABASE_URL}/guilds/${encodeURIComponent(guildId)}/warns/${encodeURIComponent(userId)}.json`;
}
function pathLockdownBackup(guildId) {
  return `${FIREBASE_DATABASE_URL}/guilds/${encodeURIComponent(guildId)}/lockdown_backup.json`;
}

// ---- Firebase REST helpers ----
async function dbSet(pathUrl, payload) {
  const res = await fetcher(pathUrl, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!res.ok) throw new Error(`Firebase PUT error ${res.status}`);
  return res.json();
}
async function dbGet(pathUrl) {
  const res = await fetcher(pathUrl);
  if (!res.ok) throw new Error(`Firebase GET error ${res.status}`);
  return res.json(); // null if not present
}
async function dbDelete(pathUrl) {
  const res = await fetcher(pathUrl, { method: 'DELETE' });
  if (!res.ok) throw new Error(`Firebase DELETE error ${res.status}`);
  return res.json();
}

// ---- util ----
function formatDuration(ms) {
  if (!ms || ms <= 0) return '0';
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d) return `${d} dia(s)`;
  if (h) return `${h} hora(s)`;
  if (m) return `${m} minuto(s)`;
  return `${s} segundo(s)`;
}
function parseDurationPT(input) {
  if (!input) return null;
  const s = input.trim().toLowerCase();
  const m = s.match(/^(\d+)\s*(m|min(uto)?s?|h|hr|hora(s)?|d|dia(s)?|ano(s)?)$/i);
  if (!m) {
    const parts = s.split(/\s+/);
    if (parts.length >= 2) {
      const n = parseInt(parts[0].replace(/\D/g, ''), 10);
      const unit = parts[1];
      if (!isNaN(n)) {
        if (/^m(in)/i.test(unit)) return n * 60 * 1000;
        if (/^h(or)/i.test(unit)) return n * 60 * 60 * 1000;
        if (/^d(i)/i.test(unit)) return n * 24 * 60 * 60 * 1000;
        if (/^ano/i.test(unit)) return n * 365 * 24 * 60 * 60 * 1000;
      }
    }
    return null;
  }
  const n = parseInt(m[1], 10);
  const unit = m[2].toLowerCase();
  if (/^m/i.test(unit)) return n * 60 * 1000;
  if (/^h/i.test(unit)) return n * 60 * 60 * 1000;
  if (/^d/i.test(unit)) return n * 24 * 60 * 60 * 1000;
  if (/^ano/i.test(unit)) return n * 365 * 24 * 60 * 60 * 1000;
  return null;
}

// ---- permissions required map for each command ----
const COMMAND_PERMISSIONS = {
  ban: PermissionsBitField.Flags.BanMembers,
  mute: PermissionsBitField.Flags.ManageRoles,
  unmute: PermissionsBitField.Flags.ManageRoles,
  lock: PermissionsBitField.Flags.ManageChannels,
  unlock: PermissionsBitField.Flags.ManageChannels,
  warn: PermissionsBitField.Flags.ManageMessages,
  warns: PermissionsBitField.Flags.ManageMessages,
  clearwarns: PermissionsBitField.Flags.ManageMessages,
  lockdown: PermissionsBitField.Flags.ManageChannels
};

// ---- check if member has server permission required ----
function hasRequiredPermission(member, commandName) {
  const perm = COMMAND_PERMISSIONS[commandName];
  if (!perm) return false;
  return member.permissions.has(perm) || member.permissions.has(PermissionsBitField.Flags.Administrator);
}

// ---- can execute command: checks DB config and member roles/permissions ----
async function canExecuteCommand(member, commandName) {
  if (!member || !member.guild) return false;
  // first check server permission
  if (!hasRequiredPermission(member, commandName)) return false;
  // admin bypass
  if (member.permissions.has(PermissionsBitField.Flags.Administrator)) return true;
  // read config from DB
  try {
    const cfg = await dbGet(pathCommandConfig(member.guild.id, commandName)).catch(() => null);
    if (!cfg || !cfg.roles) return false; // not configured -> cannot execute (per your rule)
    const allowedRoleIds = Object.keys(cfg.roles || {});
    for (const roleId of allowedRoleIds) {
      if (member.roles.cache.has(roleId)) return true;
    }
    return false;
  } catch (e) {
    console.error('Erro lendo config do Firebase', e);
    return false;
  }
}

// ---- set/toggle role in command config ----
async function addRoleToCommand(guildId, commandName, roleId, setterId) {
  const url = pathCommandConfig(guildId, commandName);
  const current = await dbGet(url).catch(() => null);
  const rolesObj = (current && current.roles) ? current.roles : {};
  rolesObj[roleId] = true;
  const payload = { roles: rolesObj, configuredBy: setterId, configuredAt: Date.now() };
  await dbSet(url, payload);
  return payload;
}
async function removeRoleFromCommand(guildId, commandName, roleId, setterId) {
  const url = pathCommandConfig(guildId, commandName);
  const current = await dbGet(url).catch(() => null);
  const rolesObj = (current && current.roles) ? current.roles : {};
  delete rolesObj[roleId];
  const payload = { roles: rolesObj, configuredBy: setterId, configuredAt: Date.now() };
  await dbSet(url, payload);
  return payload;
}
async function getCommandRoles(guildId, commandName) {
  const url = pathCommandConfig(guildId, commandName);
  const cfg = await dbGet(url).catch(() => null);
  return (cfg && cfg.roles) ? Object.keys(cfg.roles) : [];
}

// ---- moderation actions ----
async function ensureMutedRole(guild) {
  let role = guild.roles.cache.find(r => r.name === MUTED_ROLE_NAME);
  if (role) return role;
  if (!guild.members.me.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
    throw new Error("Bot precisa de permissão Gerenciar Cargos para criar Muted role.");
  }
  role = await guild.roles.create({ name: MUTED_ROLE_NAME, permissions: [] });
  for (const [, ch] of guild.channels.cache) {
    try {
      if (ch.permissionOverwrites) {
        await ch.permissionOverwrites.edit(role, { SendMessages: false, AddReactions: false, Speak: false, Connect: false }).catch(()=>{});
      }
    } catch (e){}
  }
  return role;
}

async function actionBan(guild, moderator, targetIdentifier, reason='Não informado') {
  const id = String(targetIdentifier).replace(/\D/g, '');
  if (!id) throw new Error('ID inválido.');
  if (!guild.members.me.permissions.has(PermissionsBitField.Flags.BanMembers)) throw new Error('Bot sem permissão de ban.');
  try {
    const user = await client.users.fetch(id).catch(()=>null);
    if (user) {
      await user.send({ embeds: [ new EmbedBuilder().setTitle('🔨 Você foi banido').setDescription(`Você foi banido do servidor **${guild.name}**`).addFields({name:'Motivo',value:reason},{name:'Moderador',value:moderator.user.tag}).setColor(EMBED_COLOR).setTimestamp() ] }).catch(()=>{});
    }
  } catch (e){}
  await guild.members.ban(id, { reason }).catch(err => { throw new Error('Erro ao banir: ' + (err.message || err)); });
  return true;
}

async function actionMute(guild, moderator, targetIdentifier, durationMs, reason='Não informado') {
  const id = String(targetIdentifier).replace(/\D/g, '');
  const member = await guild.members.fetch(id).catch(()=>null);
  if (!member) throw new Error('Usuário não encontrado no servidor.');
  if (member.roles.highest.position >= moderator.roles.highest.position) throw new Error('Não pode mutar alguém com cargo igual/maior que o seu.');
  const role = await ensureMutedRole(guild);
  await member.roles.add(role, `Muted by ${moderator.user.tag}: ${reason}`).catch(err => { throw new Error('Erro ao aplicar Muted: ' + (err.message || err)); });
  const expiresAt = Date.now() + durationMs;
  const key = `${guild.id}-${member.id}`;
  if (muteTimers.has(key)) { clearTimeout(muteTimers.get(key).timeout); }
  const timeout = setTimeout(async () => {
    try {
      const fresh = await guild.members.fetch(member.id).catch(()=>null);
      const roleNow = guild.roles.cache.find(r => r.name === MUTED_ROLE_NAME);
      if (fresh && roleNow && fresh.roles.cache.has(roleNow.id)) {
        await fresh.roles.remove(roleNow, 'Unmute automático (expirado)').catch(()=>{});
      }
    } catch (e) { console.error('Erro unmute automático', e); }
    muteTimers.delete(key);
  }, durationMs);
  muteTimers.set(key, { timeout, expiresAt });
  try { await member.send({ embeds: [ new EmbedBuilder().setTitle('🔇 Você foi silenciado').setDescription(`Você foi silenciado no servidor **${guild.name}**`).addFields({name:'Motivo',value:reason},{name:'Duração',value:formatDuration(durationMs)},{name:'Moderador',value:moderator.user.tag}).setColor(EMBED_COLOR).setTimestamp() ] }).catch(()=>{}); } catch(e){}
  return true;
}

async function actionUnmute(guild, moderator, targetIdentifier) {
  const id = String(targetIdentifier).replace(/\D/g, '');
  const member = await guild.members.fetch(id).catch(()=>null);
  if (!member) throw new Error('Usuário não encontrado.');
  const role = guild.roles.cache.find(r => r.name === MUTED_ROLE_NAME);
  if (!role || !member.roles.cache.has(role.id)) throw new Error('Usuário não está mutado.');
  await member.roles.remove(role, `Unmuted by ${moderator.user.tag}`).catch(err => { throw new Error('Erro ao remover Muted: ' + (err.message || err)); });
  const key = `${guild.id}-${member.id}`;
  if (muteTimers.has(key)) { clearTimeout(muteTimers.get(key).timeout); muteTimers.delete(key); }
  try { await member.send({ embeds: [ new EmbedBuilder().setTitle('🔊 Você foi desmutado').setDescription(`Seu mute foi removido no servidor **${guild.name}** por ${moderator.user.tag}`).setColor(EMBED_COLOR).setTimestamp() ] }).catch(()=>{}); } catch(e){}
  return true;
}

async function actionLockChannel(guild, moderator, channelId, lock=true) {
  const channel = guild.channels.cache.get(channelId);
  if (!channel) throw new Error('Canal não encontrado.');
  if (!guild.members.me.permissions.has(PermissionsBitField.Flags.ManageChannels)) throw new Error('Bot precisa de ManageChannels.');
  await channel.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: lock ? false : true }).catch(err => { throw new Error('Erro alterando permissões: ' + (err.message || err)); });
  return channel;
}

// ---- Lockdown: lock all text channels, backup previous sendMessages state in DB ----
async function doLockdown(guild, moderator) {
  if (!guild.members.me.permissions.has(PermissionsBitField.Flags.ManageChannels)) throw new Error('Bot precisa de ManageChannels.');
  const backup = {};
  for (const [, ch] of guild.channels.cache) {
    if (ch.type === ChannelType.GuildText || ch.type === ChannelType.GuildAnnouncement || ch.type === ChannelType.GuildVoice) {
      try {
        const overwrite = ch.permissionOverwrites.cache.get(guild.id);
        const hadAllow = overwrite && overwrite.allow && overwrite.allow.has(PermissionsBitField.Flags.SendMessages);
        const hadDeny = overwrite && overwrite.deny && overwrite.deny.has(PermissionsBitField.Flags.SendMessages);
        // store boolean: true if sendMessages allowed (explicitly), false if denied, null if not set
        let sendAllowed = null;
        if (hadAllow) sendAllowed = true;
        else if (hadDeny) sendAllowed = false;
        else sendAllowed = null;
        backup[ch.id] = sendAllowed;
        // set deny SendMessages
        await ch.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: false }).catch(()=>{});
      } catch (e) {
        console.warn('Erro lockdown em canal', ch.id, e);
      }
    }
  }
  // save backup to DB
  await dbSet(pathLockdownBackup(guild.id), backup).catch(()=>{});
  lockdownBackups.set(guild.id, backup);
  return true;
}

async function undoLockdown(guild, moderator) {
  if (!guild.members.me.permissions.has(PermissionsBitField.Flags.ManageChannels)) throw new Error('Bot precisa de ManageChannels.');
  // load backup from DB
  let backup = lockdownBackups.get(guild.id);
  if (!backup) {
    backup = await dbGet(pathLockdownBackup(guild.id)).catch(()=>null) || {};
  }
  for (const channelId of Object.keys(backup)) {
    const ch = guild.channels.cache.get(channelId);
    if (!ch) continue;
    const prev = backup[channelId];
    try {
      if (prev === true) {
        await ch.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: true }).catch(()=>{});
      } else if (prev === false) {
        await ch.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: false }).catch(()=>{});
      } else {
        // no explicit previous setting: remove overwrite for @everyone
        await ch.permissionOverwrites.delete(guild.roles.everyone).catch(()=>{});
      }
    } catch (e) { console.warn('Erro restaurando canal', ch.id, e); }
  }
  // remove backup
  await dbDelete(pathLockdownBackup(guild.id)).catch(()=>{});
  lockdownBackups.delete(guild.id);
  return true;
}

// ---- Carter reply handling (button interactions) ----
client.on('interactionCreate', async interaction => {
  try {
    if (!interaction.isButton()) return;

    const cid = interaction.customId;

    // Carter reply button: reply_{nonce}
    if (cid.startsWith('reply_')) {
      await interaction.deferReply({ ephemeral: true }).catch(()=>{});
      const nonce = cid.slice('reply_'.length);
      const info = replyMap.get(nonce);
      if (!info) return interaction.editReply({ content: '⚠️ Link expirado ou inválido.' });
      // prompt in DM for response
      try {
        await interaction.editReply({ content: '✍️ Digite sua resposta nesta DM. Você tem 120s.' });
      } catch {}
      const dm = interaction.channel;
      const filter = m => m.author.id === interaction.user.id;
      dm.awaitMessages({ filter, max: 1, time: 120000 }).then(async coll => {
        if (!coll || coll.size === 0) {
          try { await interaction.followUp({ content: '⌛ Tempo esgotado — resposta não enviada.', ephemeral: true }); } catch {}
          return;
        }
        const replyText = coll.first().content.trim();
        const originalId = info.fromId;
        const originalUser = await client.users.fetch(originalId).catch(()=>null);
        if (!originalUser) {
          try { await interaction.followUp({ content: '❌ Não foi possível localizar o remetente.', ephemeral: true }); } catch {}
          return;
        }
        const embed = new EmbedBuilder()
          .setTitle('💬 Resposta via Carter')
          .setDescription(replyText)
          .addFields({ name: 'Respondente', value: `${interaction.user.tag} (<@${interaction.user.id}>)` })
          .setColor('#2b9e4a')
          .setTimestamp();
        try {
          await originalUser.send({ embeds: [embed] });
          try { await interaction.followUp({ content: '✅ Resposta enviada ao remetente (DM).', ephemeral: true }); } catch {}
        } catch (e) {
          try { await interaction.followUp({ content: '❌ Falha ao enviar DM ao remetente (talvez bloqueado).', ephemeral: true }); } catch {}
        }
        replyMap.delete(nonce);
      }).catch(async () => {
        try { await interaction.followUp({ content: '⌛ Tempo esgotado — resposta não enviada.', ephemeral: true }); } catch {}
      });
    }

    // Setup related buttons:
    // - command select: setup_cmd_{command}_{adminId}
    // - role toggle: setup_role_{command}_{roleId}_{adminId}
    // - remove confirm: setup_remove_{command}_{roleId}_{adminId}
    // - pagination: setup_page_{page}_{adminId}
    if (cid.startsWith('setup_cmd_')) {
      // parse
      // format: setup_cmd_{command}_{adminId}
      const parts = cid.split('_');
      const commandName = parts[2];
      const adminId = parts[3];
      if (interaction.user.id !== adminId) return interaction.reply({ content: 'Apenas o usuário que iniciou o setup pode interagir aqui.', ephemeral: true });
      // present roles as buttons (paginated if many)
      const guild = interaction.guild;
      const roles = guild.roles.cache.filter(r => r.id !== guild.id).map(r => ({ id: r.id, name: r.name }));
      if (roles.length === 0) return interaction.update({ content: 'Nenhum cargo disponível neste servidor.', embeds: [], components: [] });
      // create rows of up to 5 buttons per row, but include only first page (we'll support simple pagination)
      const page = 0;
      const perPage = 10; // show 10 roles per page (2 rows)
      const pageRoles = roles.slice(page * perPage, (page + 1) * perPage);
      const rows = [];
      for (let i = 0; i < pageRoles.length; i += 5) {
        const chunk = pageRoles.slice(i, i + 5);
        const row = new ActionRowBuilder();
        for (const r of chunk) {
          row.addComponents(
            new ButtonBuilder()
              .setCustomId(`setup_role_${commandName}_${r.id}_${adminId}`)
              .setLabel(r.name.length > 80 ? r.name.slice(0,77)+'...' : r.name)
              .setStyle(ButtonStyle.Primary)
          );
        }
        rows.push(row);
      }
      // add pagination / back / done buttons
      const navRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`setup_done_${commandName}_${adminId}`).setLabel('Concluir').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`setup_cancel_${commandName}_${adminId}`).setLabel('Cancelar').setStyle(ButtonStyle.Secondary)
      );
      rows.push(navRow);
      const embed = new EmbedBuilder()
        .setTitle(`Configurar comando: ${commandName}`)
        .setDescription('Clique em um cargo para adicionar/remover para este comando (até 7 cargos).')
        .setColor(EMBED_COLOR);
      await interaction.update({ embeds: [embed], components: rows });
      return;
    }

    if (cid.startsWith('setup_role_')) {
      // format: setup_role_{command}_{roleId}_{adminId}
      const [, , commandName, roleId, adminId] = cid.split('_');
      if (interaction.user.id !== adminId) return interaction.reply({ content: 'Apenas o usuário que iniciou o setup pode interagir aqui.', ephemeral: true });
      const guild = interaction.guild;
      const role = guild.roles.cache.get(roleId);
      if (!role) return interaction.reply({ content: 'Cargo não encontrado.', ephemeral: true });
      // check if already present
      const rolesNow = await getCommandRoles(guild.id, commandName).catch(()=>[]);
      const isPresent = rolesNow.includes(roleId);
      if (!isPresent) {
        // add, but ensure limit
        if (rolesNow.length >= MAX_ROLES_PER_COMMAND) {
          return interaction.reply({ content: `❌ Já existem ${rolesNow.length} cargos configurados para ${commandName} (limite ${MAX_ROLES_PER_COMMAND}). Remova um antes de adicionar.`, ephemeral: true });
        }
        await addRoleToCommand(guild.id, commandName, roleId, interaction.user.id).catch(err => { console.error(err); });
        return interaction.reply({ content: `✅ Cargo **${role.name}** ADICIONADO ao comando **${commandName}**.`, ephemeral: true });
      } else {
        // already present: ask confirm remove
        const confirmRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`setup_remove_${commandName}_${roleId}_${adminId}`).setLabel('Remover este cargo').setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId(`setup_keep_${commandName}_${roleId}_${adminId}`).setLabel('Manter').setStyle(ButtonStyle.Secondary)
        );
        return interaction.reply({ content: `O cargo **${role.name}** já está configurado para o comando **${commandName}**. Deseja remover?`, components: [confirmRow], ephemeral: true });
      }
    }

    if (cid.startsWith('setup_remove_')) {
      // format: setup_remove_{command}_{roleId}_{adminId}
      const [, , commandName, roleId, adminId] = cid.split('_');
      if (interaction.user.id !== adminId) return interaction.reply({ content: 'Apenas o usuário que iniciou o setup pode interagir aqui.', ephemeral: true });
      const guild = interaction.guild;
      const role = guild.roles.cache.get(roleId);
      await removeRoleFromCommand(guild.id, commandName, roleId, interaction.user.id).catch(err => { console.error(err); });
      return interaction.update({ content: `✅ Cargo **${role ? role.name : roleId}** removido da configuração do comando **${commandName}**.`, components: [], embeds: [] });
    }

    if (cid.startsWith('setup_keep_')) {
      // user chose to keep
      return interaction.update({ content: '✅ Configuração mantida.', components: [], embeds: [] });
    }

    if (cid.startsWith('setup_done_')) {
      const parts = cid.split('_');
      const commandName = parts[2];
      const adminId = parts[3];
      if (interaction.user.id !== adminId) return interaction.reply({ content: 'Apenas o usuário que iniciou o setup pode concluir.', ephemeral: true });
      const rolesNow = await getCommandRoles(interaction.guild.id, commandName).catch(()=>[]);
      const embed = new EmbedBuilder()
        .setTitle(`Configuração finalizada: ${commandName}`)
        .setDescription(rolesNow.length ? `Cargos autorizados: ${rolesNow.map(r => `<@&${r}>`).join(', ')}` : 'Nenhum cargo configurado.')
        .setColor(EMBED_COLOR)
        .setTimestamp();
      return interaction.update({ embeds: [embed], components: [] });
    }

    if (cid.startsWith('setup_cancel_')) {
      const parts = cid.split('_');
      const commandName = parts[2];
      const adminId = parts[3];
      if (interaction.user.id !== adminId) return interaction.reply({ content: 'Apenas o usuário que iniciou o setup pode cancelar.', ephemeral: true });
      return interaction.update({ content: `Operação de configuração de **${commandName}** cancelada.`, embeds: [], components: [] });
    }

  } catch (err) {
    console.error('Erro interactionCreate:', err);
    try { if (interaction.deferred || interaction.replied) await interaction.editReply({ content: '❌ Ocorreu um erro interno.' }); else await interaction.reply({ content: '❌ Ocorreu um erro interno.', ephemeral: true }); } catch {}
  }
});

// ---- messageCreate: commands handling ----
client.on('messageCreate', async message => {
  try {
    if (message.author.bot) return;
    if (!message.content.startsWith(PREFIX)) return;

    const raw = message.content.slice(PREFIX.length).trim();
    const args = raw.split(/\s+/).filter(Boolean);
    const command = args.shift() ? raw.split(/\s+/)[0].toLowerCase() : '';

    // ---- HELP ----
    if (command === 'help') {
      const embed = new EmbedBuilder()
        .setTitle('📚 Ajuda — Comandos do Bot')
        .setColor(EMBED_COLOR)
        .setDescription('Lista dos comandos disponíveis e pré-requisitos.')
        .addFields(
          { name: '-help', value: 'Exibe essa mensagem.' },
          { name: '-setup', value: 'Painel de configuração (apenas administradores). Configura quais cargos podem usar cada comando.' },
          { name: '-ban <@user|id> [motivo]', value: 'Banir usuário (precisa permissão Expulsar Membros e cargo configurado).' },
          { name: '-mute <@user|id> <duração> [motivo]', value: 'Mutar usuário (precisa ManageRoles + cargo configurado).' },
          { name: '-unmute <@user|id>', value: 'Remover mute.' },
          { name: '-warn <@user|id> [motivo]', value: 'Dar advertência (precisa ManageMessages + cargo configurado).' },
          { name: '-warns <@user|id?>', value: 'Ver warns do usuário.' },
          { name: '-clearwarns <@user|id>', value: 'Limpar warns.' },
          { name: '-lock <canal?> / -unlock <canal?>', value: 'Trancar/destrancar canal (ManageChannels + cargo config).' },
          { name: '-lockdown / -unlockdown', value: 'Tranca todos os canais / reverte (ManageChannels + cargo config).' },
          { name: '-Carter (DM only)', value: 'Fluxo para enviar DM com confirmação e botão de resposta.' }
        )
        .setFooter({ text: 'Os comandos de moderação também exigem cargos configurados via -setup e as permissões Discord adequadas.' });
      return message.channel.send({ embeds: [embed] });
    }

    // ---- SETUP (no args accepted) ----
    if (command === 'setup') {
      // must be in guild and be admin
      if (!message.guild) return message.reply('❌ O comando `-setup` deve ser usado dentro de um servidor.');
      if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator) && !message.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
        return message.reply('🚫 Apenas administradores/gestores podem iniciar o setup.');
      }
      // if there are arguments after -setup, reject (per your request)
      if (args.length > 0) {
        return message.reply('⚠️ O comando `-setup` não aceita argumentos. Clique nos botões do painel para configurar.');
      }

      // show commands as buttons for selection
      const commands = ['ban','mute','warn','lock','unlock','clearwarns','warns','lockdown'];
      const rows = [];
      // create rows of up to 5 buttons
      for (let i = 0; i < commands.length; i += 5) {
        const chunk = commands.slice(i, i + 5);
        const row = new ActionRowBuilder();
        for (const cmd of chunk) {
          row.addComponents(
            new ButtonBuilder()
              .setCustomId(`setup_cmd_${cmd}_${message.author.id}`)
              .setLabel(cmd.toUpperCase())
              .setStyle(ButtonStyle.Primary)
          );
        }
        rows.push(row);
      }
      const embed = new EmbedBuilder()
        .setTitle('🛠 Painel de Setup — Configuração de Comandos')
        .setDescription('Clique no comando que deseja configurar. (Somente você pode interagir com este painel.)')
        .setColor(EMBED_COLOR)
        .setFooter({ text: `Máx ${MAX_ROLES_PER_COMMAND} cargos por comando.` });
      return message.reply({ embeds: [embed], components: rows });
    }

    // ---- Carter (DM only) ----
    if (command === 'carter') {
      if (message.channel.type !== ChannelType.DM) return message.reply('❌ O comando `-Carter` só funciona em DM com o bot.');
      // warn if user not mod anywhere
      let isModAnywhere = false;
      for (const g of client.guilds.cache.values()) {
        const mem = await g.members.fetch(message.author.id).catch(()=>null);
        if (mem && (mem.permissions.has(PermissionsBitField.Flags.ManageGuild) || mem.roles.cache.some(r => true))) { isModAnywhere = true; break; }
      }
      if (!isModAnywhere) await message.channel.send('⚠️ Nota: você não foi identificado como moderador em nenhum servidor em comum. Use com responsabilidade.');

      // Stage 0: ask for target
      let targetArg = args[0];
      if (!targetArg) {
        await message.channel.send('Para quem deseja enviar a mensagem? Responda com menção (@user) ou ID (60s).');
        try {
          const collected = await message.channel.awaitMessages({ filter: m => m.author.id === message.author.id, max: 1, time: 60000, errors: ['time'] });
          targetArg = collected.first().content.trim();
          try { await collected.first().delete().catch(()=>{}); } catch {}
        } catch {
          return message.channel.send('⌛ Tempo esgotado — comando cancelado.');
        }
      }
      const mention = targetArg.match(/^<@!?(\d+)>$/);
      const targetId = mention ? mention[1] : targetArg.replace(/\D/g,'');
      const targetUser = await client.users.fetch(targetId).catch(()=>null);
      if (!targetUser) return message.channel.send('❌ Usuário não encontrado.');

      // Stage 1: get message text
      await message.channel.send(`✍️ Digite a mensagem para **${targetUser.tag}** (60s):`);
      let messageText;
      try {
        const coll = await message.channel.awaitMessages({ filter: m => m.author.id === message.author.id, max: 1, time: 60000, errors: ['time'] });
        messageText = coll.first().content.trim();
        try { await coll.first().delete().catch(()=>{}); } catch {}
      } catch {
        return message.channel.send('⌛ Tempo esgotado — comando cancelado.');
      }
      if (!messageText) return message.channel.send('❌ Mensagem vazia — cancelado.');
      if (messageText.length > 3500) return message.channel.send('❌ Mensagem muito longa (máx 3500).');

      // Stage 2: preview + confirmation buttons
      const preview = new EmbedBuilder()
        .setTitle('📨 Confirmação - Carter')
        .setColor(EMBED_COLOR)
        .addFields(
          { name: 'Destinatário', value: `${targetUser.tag} (<@${targetUser.id}>)`, inline: false },
          { name: 'Remetente', value: `${message.author.tag}`, inline: true },
          { name: 'Mensagem', value: messageText.length > 1024 ? messageText.slice(0,1020) + '...' : messageText, inline: false },
          { name: 'Aviso', value: 'Se a mensagem for ofensiva/ameaçadora/ilegal, você pode ser responsabilizado. Ao confirmar, assume responsabilidade.' }
        ).setTimestamp();

      const nonce = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2,8)}`;
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`carter_send_${nonce}`).setLabel('Enviar mensagem').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`carter_cancel_${nonce}`).setLabel('Cancelar').setStyle(ButtonStyle.Secondary)
      );
      const confirmMsg = await message.channel.send({ embeds: [preview], components: [row] });

      const filter = i => i.user.id === message.author.id && (i.customId === `carter_send_${nonce}` || i.customId === `carter_cancel_${nonce}`);
      const collector = confirmMsg.createMessageComponentCollector({ filter, max: 1, time: 30000 });

      collector.on('collect', async i => {
        if (i.customId === `carter_cancel_${nonce}`) {
          await i.update({ content: '❌ Envio cancelado.', embeds: [], components: [] });
          return;
        }
        await i.update({ content: '⏳ Enviando mensagem...', embeds: [], components: [] }).catch(()=>{});
        const dmEmbed = new EmbedBuilder()
          .setTitle('📩 Você recebeu uma mensagem')
          .setDescription(messageText)
          .addFields({ name: 'Enviada por', value: `${message.author.tag}`, inline: true }, { name: 'ID do remetente', value: `${message.author.id}`, inline: true })
          .setColor(EMBED_COLOR)
          .setTimestamp();
        const replyId = `reply_${nonce}`;
        replyMap.set(nonce, { fromId: message.author.id, toId: targetUser.id, preview: messageText });
        const replyRow = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(replyId).setLabel('Responder').setStyle(ButtonStyle.Primary)
        );
        let dmSuccess = false;
        try {
          await targetUser.send({ embeds: [dmEmbed], components: [replyRow] });
          dmSuccess = true;
        } catch (e) { dmSuccess = false; }
        const resultEmbed = new EmbedBuilder()
          .setTitle(dmSuccess ? '✅ Mensagem enviada' : '⚠️ Falha ao enviar DM')
          .setColor(dmSuccess ? '#22c55e' : '#e45656')
          .addFields({ name: 'Destinatário', value: `${targetUser.tag}`, inline: true }, { name: 'ID destinatário', value: `${targetUser.id}`, inline: true }, { name: 'Mensagem', value: messageText.length > 1024 ? messageText.slice(0,1020)+'...' : messageText, inline: false }, { name: 'Observação', value: dmSuccess ? 'Mensagem entregue por DM.' : 'Não foi possível entregar — destinatário pode ter DMs bloqueadas.' });
        await message.channel.send({ embeds: [resultEmbed] }).catch(()=>{});
      });

      collector.on('end', collected => {
        if (collected.size === 0) confirmMsg.edit({ content: '⌛ Tempo esgotado — envio não confirmado.', embeds: [], components: [] }).catch(()=>{});
      });

      return;
    } // end Carter

    // ---- MODERATION COMMANDS (guild only) ----
    const modCommands = ['ban','mute','unmute','lock','unlock','warn','warns','clearwarns','lockdown','unlockdown'];
    if (modCommands.includes(command)) {
      if (!message.guild) return message.reply('Este comando só pode ser usado dentro do servidor.');
      // First check user has Discord permission for the command
      if (!hasRequiredPermission(message.member, command)) {
        return message.reply('🚫 Você não tem a permissão necessária do Discord para executar este comando.');
      }
      // check config exists
      const cfg = await dbGet(pathCommandConfig(message.guild.id, command)).catch(()=>null);
      if (!cfg || !cfg.roles || Object.keys(cfg.roles).length === 0) {
        return message.reply(`❌ Este comando requer configuração do servidor. Peça a um administrador executar \`${PREFIX}setup\` e configurar o comando "${command.toUpperCase()}".`);
      }
      // check member has one of the configured roles (unless admin)
      if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
        const allowedRoleIds = Object.keys(cfg.roles || {});
        const hasRole = allowedRoleIds.some(rid => message.member.roles.cache.has(rid));
        if (!hasRole) {
          return message.reply('🚫 Você não tem um dos cargos autorizados para executar este comando.');
        }
      }

      // Now implement each command logic
      if (command === 'ban') {
        const targetArg = args[0];
        const reason = args.slice(1).join(' ') || 'Não informado';
        if (!targetArg) return message.reply('Uso: -ban <@user|id> [motivo]');
        try {
          await actionBan(message.guild, message.member, targetArg, reason);
          return message.reply(`✅ Usuário banido. Motivo: ${reason}`);
        } catch (e) {
          return message.reply(`❌ Erro ao banir: ${e.message || e}`);
        }
      }

      if (command === 'mute') {
        const targetArg = args[0];
        const durArg = args[1];
        const reason = args.slice(2).join(' ') || 'Não informado';
        if (!targetArg || !durArg) return message.reply("Uso: -mute <@user|id> <duração ex: '10m' '2h' '3d'> [motivo]");
        const durMs = parseDurationPT(durArg);
        if (!durMs) return message.reply("Duração inválida. Exemplos: '10m', '2h', '3d'.");
        try {
          await actionMute(message.guild, message.member, targetArg, durMs, reason);
          return message.reply(`🔇 Usuário mutado por ${formatDuration(durMs)}. Motivo: ${reason}`);
        } catch (e) {
          return message.reply(`❌ Erro ao mutar: ${e.message || e}`);
        }
      }

      if (command === 'unmute') {
        const targetArg = args[0];
        if (!targetArg) return message.reply('Uso: -unmute <@user|id>');
        try {
          await actionUnmute(message.guild, message.member, targetArg);
          return message.reply('✅ Usuário desmutado.');
        } catch (e) {
          return message.reply(`❌ Erro: ${e.message || e}`);
        }
      }

      if (command === 'lock' || command === 'unlock') {
        const channelId = args[0] || message.channel.id;
        try {
          const ch = await actionLockChannel(message.guild, message.member, channelId, command === 'unlock');
          return message.reply(`${command === 'lock' ? '🔒 Canal trancado' : '🔓 Canal destrancado'}: <#${ch.id}>`);
        } catch (e) {
          return message.reply(`❌ Erro: ${e.message || e}`);
        }
      }

      if (command === 'warn') {
        const targetArg = args[0];
        const reason = args.slice(1).join(' ') || 'Não informado';
        if (!targetArg) return message.reply('Uso: -warn <@user|id> [motivo]');
        const id = targetArg.replace(/\D/g,'');
        const member = await message.guild.members.fetch(id).catch(()=>null);
        if (!member) return message.reply('Usuário não encontrado.');
        if (member.roles.highest.position >= message.member.roles.highest.position) return message.reply('🚫 Você não pode advertir alguém com cargo igual/maior que o seu.');
        const warnsPath = pathWarns(message.guild.id, member.id);
        const r = await fetcher(warnsPath);
        const cur = r.ok ? await r.json().catch(()=>null) : null;
        const next = (cur && typeof cur.count === 'number') ? cur.count + 1 : 1;
        await fetcher(warnsPath, { method: 'PUT', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ count: next, lastReason: reason, lastBy: message.author.id, lastAt: Date.now() }) });
        try { await member.send({ embeds: [ new EmbedBuilder().setTitle('⚠️ Advertência').setDescription(`Você recebeu uma advertência no servidor **${message.guild.name}**.`).addFields({name:'Motivo',value:reason},{name:'Advertência Nº',value:String(next)},{name:'Moderador',value:message.author.tag}).setColor(EMBED_COLOR).setTimestamp() ] }).catch(()=>{}); } catch(e){}
        return message.reply(`⚠️ ${member.user.tag} recebeu advertência. Total: ${next}`);
      }

      if (command === 'warns') {
        const targetArg = args[0] || message.author.id;
        const id = targetArg.replace(/\D/g,'');
        const warnsPath = pathWarns(message.guild.id, id);
        const r = await fetcher(warnsPath);
        const cur = r.ok ? await r.json().catch(()=>null) : null;
        const c = (cur && typeof cur.count === 'number') ? cur.count : 0;
        return message.reply({ embeds: [ new EmbedBuilder().setTitle('📋 Warns').setDescription(`<@${id}> tem ${c} warn(s)`).setColor(EMBED_COLOR) ] });
      }

      if (command === 'clearwarns') {
        const targetArg = args[0];
        if (!targetArg) return message.reply('Uso: -clearwarns <@user|id>');
        const id = targetArg.replace(/\D/g,'');
        const warnsPath = pathWarns(message.guild.id, id);
        await fetcher(warnsPath, { method: 'DELETE' });
        return message.reply(`✅ Warns de <@${id}> limpos.`);
      }

      if (command === 'lockdown') {
        try {
          await doLockdown(message.guild, message.member);
          return message.reply('🔐 Lockdown ativado em todos os canais (backup salvo).');
        } catch (e) {
          return message.reply(`❌ Erro no lockdown: ${e.message || e}`);
        }
      }

      if (command === 'unlockdown') {
        try {
          await undoLockdown(message.guild, message.member);
          return message.reply('🔓 Lockdown revertido — permissões restauradas (na medida do backup).');
        } catch (e) {
          return message.reply(`❌ Erro ao reverter lockdown: ${e.message || e}`);
        }
      }

    } // end modCommands handling

  } catch (err) {
    console.error('Erro messageCreate:', err);
    try { if (message && message.channel) await message.channel.send('❌ Ocorreu um erro ao processar seu comando. Verifique o console.'); } catch {}
  }
});

// ---- ready ----
client.once('ready', () => {
  console.log(`✅ Bot online: ${client.user.tag}`);
});

// ---- login ----
client.login(TOKEN).catch(err => {
  console.error('Erro ao logar. Verifique o TOKEN:', err);
});
```0
