/**
 * index.js — Bot completo (único arquivo)
 *
 * Dependências: discord.js v14, express, node-fetch@2
 * npm install discord.js express node-fetch@2
 *
 * Variáveis de ambiente:
 * - TOKEN (obrigatório)
 * - FIREBASE_DATABASE_URL (opcional: URL do Realtime Database sem barra final)
 * - PREFIX (opcional, default "-")
 * - PORT (opcional, default 3000)
 *
 * Nota: Se FIREBASE_DATABASE_URL não estiver definido, o bot usará armazenamento em memória
 * (ideal para testes; para persistência real use Firebase ou outro DB).
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

let fetcher = global.fetch;
if (!fetcher) {
  try {
    fetcher = require('node-fetch'); // node-fetch@2 (CommonJS)
  } catch (e) {
    console.error('Instale node-fetch@2: npm install node-fetch@2');
    process.exit(1);
  }
}

// ----- CONFIG -----
const TOKEN = process.env.TOKEN || '';
const FIREBASE_DATABASE_URL = (process.env.FIREBASE_DATABASE_URL || '').replace(/\/$/, '');
const PREFIX = (process.env.PREFIX || '-').trim();
const PORT = process.env.PORT || 3000;
const EMBED_COLOR = '#8B4513';
const MUTED_ROLE_NAME = process.env.MUTED_ROLE_NAME || 'Muted (Bot)';
const MAX_ROLES_PER_COMMAND = 7;

// quick guard
if (!TOKEN) {
  console.error('Erro: variável de ambiente TOKEN não definida. Defina TOKEN antes de rodar o bot.');
  // do not exit here in some hosts, but it's fine to exit
  process.exit(1);
}

// ----- EXPRESS (uptime) -----
const app = express();
app.get('/', (req, res) => res.send('Bot rodando'));
app.listen(PORT, () => console.log(`HTTP server ouvindo na porta ${PORT}`));

// ----- DISCORD CLIENT -----
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

// ----- STORAGE (Firebase REST ou in-memory) -----
/*
Firebase schema used (via REST):
/guilds/{guildId}/commands/{command} => { roles: { roleId: true, ... }, configuredAt, configuredBy }
/guilds/{guildId}/warns/{userId} => { count: N, lastReason, lastBy, lastAt }
*/
const useFirebase = !!FIREBASE_DATABASE_URL;

const memoryDB = {
  // guildId: { commands: { ban: { roles: {roleId:true} }, ... }, warns: { userId: {count, lastReason,...} }, lockdown_backup: {...} }
};

async function dbGet(path) {
  if (!useFirebase) {
    // path format: /guilds/{guildId}/... we'll parse minimal
    // Very simple parser: split after /guilds/
    if (!path) return null;
    try {
      const parts = path.split('/').filter(Boolean);
      // parts like ["https:", "", "docucraft...firebaseio.com","guilds","GUILDID","commands","ban.json"] - so we fallback to reading memoryDB by manual calls
      // We'll not rely on full path; instead higher-level functions use memory when firebase not present.
      return null;
    } catch (e) {
      return null;
    }
  }
  try {
    const res = await fetcher(path);
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    console.error('dbGet error', e);
    return null;
  }
}
async function dbSet(path, payload) {
  if (!useFirebase) return null;
  try {
    const res = await fetcher(path, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!res.ok) throw new Error('Firebase PUT ' + res.status);
    return await res.json();
  } catch (e) {
    console.error('dbSet error', e);
    throw e;
  }
}
async function dbDelete(path) {
  if (!useFirebase) return false;
  try {
    const res = await fetcher(path, { method: 'DELETE' });
    return res.ok;
  } catch (e) {
    console.error('dbDelete error', e);
    return false;
  }
}

// helpers that hide Firebase vs memory
function firebasePathCommandConfig(guildId, command) {
  return `${FIREBASE_DATABASE_URL}/guilds/${encodeURIComponent(guildId)}/commands/${encodeURIComponent(command)}.json`;
}
function firebasePathWarns(guildId, userId) {
  return `${FIREBASE_DATABASE_URL}/guilds/${encodeURIComponent(guildId)}/warns/${encodeURIComponent(userId)}.json`;
}
function firebasePathLockdown(guildId) {
  return `${FIREBASE_DATABASE_URL}/guilds/${encodeURIComponent(guildId)}/lockdown_backup.json`;
}

async function getCommandRoles(guildId, command) {
  if (useFirebase) {
    const url = firebasePathCommandConfig(guildId, command);
    const cfg = await dbGet(url).catch(()=>null);
    return (cfg && cfg.roles) ? Object.keys(cfg.roles) : [];
  } else {
    const g = memoryDB[guildId];
    if (!g || !g.commands || !g.commands[command] || !g.commands[command].roles) return [];
    return Object.keys(g.commands[command].roles);
  }
}
async function addRoleToCommand(guildId, command, roleId, setterId) {
  if (useFirebase) {
    const url = firebasePathCommandConfig(guildId, command);
    const cur = await dbGet(url).catch(()=>null) || {};
    const rolesObj = cur.roles || {};
    rolesObj[roleId] = true;
    const payload = { roles: rolesObj, configuredBy: setterId, configuredAt: Date.now() };
    await dbSet(url, payload).catch(e=>{ throw e; });
    return payload;
  } else {
    if (!memoryDB[guildId]) memoryDB[guildId] = { commands: {}, warns: {}, lockdown_backup: {} };
    if (!memoryDB[guildId].commands[command]) memoryDB[guildId].commands[command] = { roles: {} };
    memoryDB[guildId].commands[command].roles[roleId] = true;
    memoryDB[guildId].commands[command].configuredBy = setterId;
    memoryDB[guildId].commands[command].configuredAt = Date.now();
    return memoryDB[guildId].commands[command];
  }
}
async function removeRoleFromCommand(guildId, command, roleId, setterId) {
  if (useFirebase) {
    const url = firebasePathCommandConfig(guildId, command);
    const cur = await dbGet(url).catch(()=>null) || {};
    const rolesObj = cur.roles || {};
    delete rolesObj[roleId];
    const payload = { roles: rolesObj, configuredBy: setterId, configuredAt: Date.now() };
    await dbSet(url, payload).catch(e=>{ throw e; });
    return payload;
  } else {
    if (!memoryDB[guildId] || !memoryDB[guildId].commands[command]) return null;
    delete memoryDB[guildId].commands[command].roles[roleId];
    memoryDB[guildId].commands[command].configuredBy = setterId;
    memoryDB[guildId].commands[command].configuredAt = Date.now();
    return memoryDB[guildId].commands[command];
  }
}
async function getWarns(guildId, userId) {
  if (useFirebase) {
    const url = firebasePathWarns(guildId, userId);
    const data = await dbGet(url).catch(()=>null);
    return data || null;
  } else {
    if (!memoryDB[guildId]) return null;
    return memoryDB[guildId].warns[userId] || null;
  }
}
async function setWarns(guildId, userId, payload) {
  if (useFirebase) {
    const url = firebasePathWarns(guildId, userId);
    await dbSet(url, payload).catch(()=>{});
    return payload;
  } else {
    if (!memoryDB[guildId]) memoryDB[guildId] = { commands: {}, warns: {}, lockdown_backup: {} };
    memoryDB[guildId].warns[userId] = payload;
    return payload;
  }
}
async function deleteWarns(guildId, userId) {
  if (useFirebase) {
    const url = firebasePathWarns(guildId, userId);
    await dbDelete(url).catch(()=>{});
    return true;
  } else {
    if (!memoryDB[guildId]) return false;
    delete memoryDB[guildId].warns[userId];
    return true;
  }
}
async function setLockdownBackup(guildId, payload) {
  if (useFirebase) {
    const url = firebasePathLockdown(guildId);
    await dbSet(url, payload).catch(()=>{});
    return payload;
  } else {
    if (!memoryDB[guildId]) memoryDB[guildId] = { commands: {}, warns: {}, lockdown_backup: {} };
    memoryDB[guildId].lockdown_backup = payload;
    return payload;
  }
}
async function getLockdownBackup(guildId) {
  if (useFirebase) {
    const url = firebasePathLockdown(guildId);
    const data = await dbGet(url).catch(()=>null);
    return data || null;
  } else {
    if (!memoryDB[guildId]) return null;
    return memoryDB[guildId].lockdown_backup || null;
  }
}
async function deleteLockdownBackup(guildId) {
  if (useFirebase) {
    const url = firebasePathLockdown(guildId);
    await dbDelete(url).catch(()=>{});
    return true;
  } else {
    if (!memoryDB[guildId]) return false;
    delete memoryDB[guildId].lockdown_backup;
    return true;
  }
}

// ----- UTILS -----
function formatDuration(ms) {
  if (!ms || ms <= 0) return '0';
  const s = Math.floor(ms/1000);
  const m = Math.floor(s/60);
  const h = Math.floor(m/60);
  const d = Math.floor(h/24);
  if (d) return `${d} dia(s)`;
  if (h) return `${h} hora(s)`;
  if (m) return `${m} minuto(s)`;
  return `${s} segundo(s)`;
}
function parseDurationPT(input) {
  if (!input) return null;
  const s = input.trim().toLowerCase();
  // formats: 10m 2h 3d or "2 horas"
  const m = s.match(/^(\d+)\s*(m|min|mins|minuto|minutos|h|hr|hora|horas|d|dia|dias)$/i);
  if (m) {
    const n = parseInt(m[1],10);
    const unit = m[2].toLowerCase();
    if (/^m/i.test(unit)) return n*60*1000;
    if (/^h/i.test(unit)) return n*60*60*1000;
    if (/^d/i.test(unit)) return n*24*60*60*1000;
  }
  // try simple patterns like "10m" or "2h"
  const m2 = s.match(/^(\d+)(m|h|d)$/i);
  if (m2) {
    const n = parseInt(m2[1],10);
    const u = m2[2].toLowerCase();
    if (u==='m') return n*60*1000;
    if (u==='h') return n*60*60*1000;
    if (u==='d') return n*24*60*60*1000;
  }
  return null;
}

// permission map required by Discord for each command
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
  unlockdown: PermissionsBitField.Flags.ManageChannels
};

function hasDiscordPermission(member, commandName) {
  const req = COMMAND_PERMISSIONS[commandName];
  if (!req) return false;
  return member.permissions.has(req) || member.permissions.has(PermissionsBitField.Flags.Administrator);
}

// ----- Moderation helpers -----
const muteTimers = new Map(); // key: `${guildId}-${userId}`

async function ensureMutedRole(guild) {
  let role = guild.roles.cache.find(r => r.name === MUTED_ROLE_NAME);
  if (role) return role;
  if (!guild.members.me.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
    throw new Error('Bot precisa de permissão Gerenciar Cargos para criar role Muted.');
  }
  role = await guild.roles.create({ name: MUTED_ROLE_NAME, permissions: [] });
  for (const [, ch] of guild.channels.cache) {
    try {
      if (ch.permissionOverwrites) {
        await ch.permissionOverwrites.edit(role, { SendMessages: false, AddReactions: false, Speak: false, Connect: false }).catch(()=>{});
      }
    } catch (e) { /* ignore per-channel failures */ }
  }
  return role;
}

async function actionBan(guild, moderator, targetIdentifier, reason='Não informado') {
  const id = String(targetIdentifier).replace(/\D/g,'');
  if (!id) throw new Error('ID inválido.');
  if (!guild.members.me.permissions.has(PermissionsBitField.Flags.BanMembers)) throw new Error('Bot sem permissão de ban.');
  try {
    const user = await client.users.fetch(id).catch(()=>null);
    if (user) {
      await user.send({ embeds: [ new EmbedBuilder().setTitle('🔨 Você foi banido').setDescription(`Você foi banido do servidor **${guild.name}**`).addFields({name:'Motivo',value:reason},{name:'Moderador',value:moderator.user.tag}).setColor(EMBED_COLOR).setTimestamp() ] }).catch(()=>{});
    }
  } catch(e){}
  await guild.members.ban(id, { reason });
  return true;
}

async function actionMute(guild, moderator, targetIdentifier, durationMs, reason='Não informado') {
  const id = String(targetIdentifier).replace(/\D/g,'');
  const member = await guild.members.fetch(id).catch(()=>null);
  if (!member) throw new Error('Usuário não encontrado no servidor.');
  if (member.roles.highest.position >= moderator.roles.highest.position) throw new Error('Não pode mutar alguém com cargo igual/maior que o seu.');
  const role = await ensureMutedRole(guild);
  await member.roles.add(role, `Muted by ${moderator.user.tag}: ${reason}`);
  const key = `${guild.id}-${member.id}`;
  if (muteTimers.has(key)) clearTimeout(muteTimers.get(key).timeout);
  const timeout = setTimeout(async () => {
    try {
      const fresh = await guild.members.fetch(member.id).catch(()=>null);
      const roleNow = guild.roles.cache.find(r => r.name === MUTED_ROLE_NAME);
      if (fresh && roleNow && fresh.roles.cache.has(roleNow.id)) {
        await fresh.roles.remove(roleNow, 'Unmute automático (expirado)').catch(()=>{});
      }
    } catch (e){ console.error('Erro ao unmute automático', e); }
    muteTimers.delete(key);
  }, durationMs);
  muteTimers.set(key, { timeout, expiresAt: Date.now() + durationMs });
  try {
    await member.send({ embeds: [ new EmbedBuilder().setTitle('🔇 Você foi silenciado').setDescription(`Você foi silenciado no servidor **${guild.name}**`).addFields({name:'Motivo',value:reason},{name:'Duração',value:formatDuration(durationMs)},{name:'Moderador',value:moderator.user.tag}).setColor(EMBED_COLOR).setTimestamp() ] }).catch(()=>{});
  } catch(e){}
  return true;
}

async function actionUnmute(guild, moderator, targetIdentifier) {
  const id = String(targetIdentifier).replace(/\D/g,'');
  const member = await guild.members.fetch(id).catch(()=>null);
  if (!member) throw new Error('Usuário não encontrado.');
  const role = guild.roles.cache.find(r => r.name === MUTED_ROLE_NAME);
  if (!role || !member.roles.cache.has(role.id)) throw new Error('Usuário não está mutado.');
  await member.roles.remove(role, `Unmuted by ${moderator.user.tag}`);
  const key = `${guild.id}-${member.id}`;
  if (muteTimers.has(key)) { clearTimeout(muteTimers.get(key).timeout); muteTimers.delete(key); }
  try {
    await member.send({ embeds: [ new EmbedBuilder().setTitle('🔊 Você foi desmutado').setDescription(`Seu mute foi removido no servidor **${guild.name}** por ${moderator.user.tag}`).setColor(EMBED_COLOR).setTimestamp() ] }).catch(()=>{});
  } catch(e){}
  return true;
}

async function actionLockChannel(guild, moderator, channelId, lock=true) {
  const ch = guild.channels.cache.get(channelId);
  if (!ch) throw new Error('Canal não encontrado.');
  if (!guild.members.me.permissions.has(PermissionsBitField.Flags.ManageChannels)) throw new Error('Bot precisa de ManageChannels.');
  await ch.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: lock ? false : true });
  return ch;
}

async function doLockdown(guild, moderator) {
  if (!guild.members.me.permissions.has(PermissionsBitField.Flags.ManageChannels)) throw new Error('Bot precisa de ManageChannels.');
  const backup = {};
  for (const [, ch] of guild.channels.cache) {
    if (ch.type === ChannelType.GuildText || ch.type === ChannelType.GuildAnnouncement) {
      try {
        const overwrite = ch.permissionOverwrites.cache.get(guild.id);
        const hadAllow = overwrite && overwrite.allow && overwrite.allow.has(PermissionsBitField.Flags.SendMessages);
        const hadDeny = overwrite && overwrite.deny && overwrite.deny.has(PermissionsBitField.Flags.SendMessages);
        let sendAllowed = null;
        if (hadAllow) sendAllowed = true;
        else if (hadDeny) sendAllowed = false;
        else sendAllowed = null;
        backup[ch.id] = sendAllowed;
        await ch.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: false }).catch(()=>{});
      } catch (e) { console.warn('Erro lockdown canal', ch.id, e); }
    }
  }
  await setLockdownBackup(guild.id, backup).catch(()=>{});
  return true;
}

async function undoLockdown(guild, moderator) {
  if (!guild.members.me.permissions.has(PermissionsBitField.Flags.ManageChannels)) throw new Error('Bot precisa de ManageChannels.');
  const backup = await getLockdownBackup(guild.id) || {};
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
        await ch.permissionOverwrites.delete(guild.roles.everyone).catch(()=>{});
      }
    } catch (e) { console.warn('Erro restaurando canal', ch.id, e); }
  }
  await deleteLockdownBackup(guild.id).catch(()=>{});
  return true;
}

// replyMap for Carter replies
const replyMap = new Map(); // nonce -> { fromId, toId, preview }

// ----- INTERACTIONS -----
client.on('interactionCreate', async interaction => {
  try {
    if (!interaction.isButton()) return;

    const cid = interaction.customId;

    // Carter reply button
    if (cid.startsWith('reply_')) {
      await interaction.deferReply({ ephemeral: true });
      const nonce = cid.slice('reply_'.length);
      const info = replyMap.get(nonce);
      if (!info) return interaction.editReply({ content: '⚠️ Link expirado ou inválido.' });
      // open a DM conversation flow: ask the replier to send message in that ephemeral reply chat
      await interaction.editReply({ content: '✍️ Escreva sua resposta aqui (DM). Você tem 120s.' });
      const dmChan = interaction.channel;
      const filter = m => m.author.id === interaction.user.id;
      dmChan.awaitMessages({ filter, max: 1, time: 120000 }).then(async coll => {
        if (!coll || coll.size === 0) {
          try { await interaction.followUp({ content: '⌛ Tempo esgotado — resposta não enviada.', ephemeral: true }); } catch {}
          return;
        }
        const replyText = coll.first().content;
        const originalUser = await client.users.fetch(info.fromId).catch(()=>null);
        if (!originalUser) {
          try { await interaction.followUp({ content: '❌ Não foi possível localizar o remetente.', ephemeral: true }); } catch {}
          return;
        }
        const embed = new EmbedBuilder().setTitle('💬 Resposta via Carter').setDescription(replyText).addFields({ name: 'Respondente', value: `${interaction.user.tag}` }).setColor('#2b9e4a').setTimestamp();
        try {
          await originalUser.send({ embeds: [embed] });
          try { await interaction.followUp({ content: '✅ Resposta enviada ao remetente (DM).', ephemeral: true }); } catch {}
        } catch (e) {
          try { await interaction.followUp({ content: '❌ Falha ao enviar DM ao remetente (talvez bloqueado).', ephemeral: true }); } catch {}
        }
        replyMap.delete(nonce);
      }).catch(async () => {
        try { await interaction.followUp({ content: '⌛ Tempo esgotado.', ephemeral: true }); } catch {}
      });
      return;
    }

    // Setup command buttons patterns:
    // setup_cmd_{command}_{adminId}
    // setup_role_{command}_{roleId}_{adminId}
    // setup_remove_{command}_{roleId}_{adminId}
    // setup_done_{command}_{adminId}
    // setup_cancel_{command}_{adminId}

    if (cid.startsWith('setup_cmd_')) {
      const parts = cid.split('_');
      const commandName = parts[2];
      const adminId = parts[3];
      if (interaction.user.id !== adminId) return interaction.reply({ content: 'Apenas o autor do painel pode interagir.', ephemeral: true });
      const guild = interaction.guild;
      const roles = guild.roles.cache.filter(r => r.id !== guild.id).map(r => ({ id: r.id, name: r.name }));
      if (roles.length === 0) return interaction.update({ content: 'Nenhum cargo disponível.', embeds: [], components: [] });
      const perPage = 10; // 2 rows of 5
      const pageRoles = roles.slice(0, perPage);
      const rows = [];
      for (let i=0;i<pageRoles.length;i+=5) {
        const chunk = pageRoles.slice(i,i+5);
        const row = new ActionRowBuilder();
        for (const r of chunk) {
          row.addComponents(new ButtonBuilder().setCustomId(`setup_role_${commandName}_${r.id}_${adminId}`).setLabel(r.name.length>80?r.name.slice(0,77)+'...':r.name).setStyle(ButtonStyle.Primary));
        }
        rows.push(row);
      }
      rows.push(new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`setup_done_${commandName}_${adminId}`).setLabel('Concluir').setStyle(ButtonStyle.Success), new ButtonBuilder().setCustomId(`setup_cancel_${commandName}_${adminId}`).setLabel('Cancelar').setStyle(ButtonStyle.Secondary)));
      const embed = new EmbedBuilder().setTitle(`Configurar comando: ${commandName}`).setDescription('Clique em um cargo para adicionar/remover (máx 7).').setColor(EMBED_COLOR);
      await interaction.update({ embeds: [embed], components: rows });
      return;
    }

    if (cid.startsWith('setup_role_')) {
      const parts = cid.split('_');
      const commandName = parts[2];
      const roleId = parts[3];
      const adminId = parts[4];
      if (interaction.user.id !== adminId) return interaction.reply({ content: 'Apenas o autor do painel pode interagir.', ephemeral: true });
      const guild = interaction.guild;
      const role = guild.roles.cache.get(roleId);
      if (!role) return interaction.reply({ content: 'Cargo não encontrado.', ephemeral: true });
      const rolesNow = await getCommandRoles(guild.id, commandName).catch(()=>[]);
      const isPresent = rolesNow.includes(roleId);
      if (!isPresent) {
        if (rolesNow.length >= MAX_ROLES_PER_COMMAND) {
          return interaction.reply({ content: `❌ Este comando já tem ${rolesNow.length} cargos (limite ${MAX_ROLES_PER_COMMAND}).`, ephemeral: true });
        }
        await addRoleToCommand(guild.id, commandName, roleId, interaction.user.id).catch(err=>{ console.error(err); });
        return interaction.reply({ content: `✅ Cargo **${role.name}** ADICIONADO ao comando **${commandName}**.`, ephemeral: true });
      } else {
        const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`setup_remove_${commandName}_${roleId}_${adminId}`).setLabel('Remover').setStyle(ButtonStyle.Danger), new ButtonBuilder().setCustomId(`setup_keep_${commandName}_${roleId}_${adminId}`).setLabel('Manter').setStyle(ButtonStyle.Secondary));
        return interaction.reply({ content: `O cargo **${role.name}** já está configurado para **${commandName}**. Deseja remover?`, components: [row], ephemeral: true });
      }
    }

    if (cid.startsWith('setup_remove_')) {
      const parts = cid.split('_');
      const commandName = parts[2];
      const roleId = parts[3];
      const adminId = parts[4];
      if (interaction.user.id !== adminId) return interaction.reply({ content: 'Apenas o autor do painel pode interagir.', ephemeral: true });
      const guild = interaction.guild;
      const role = guild.roles.cache.get(roleId);
      await removeRoleFromCommand(guild.id, commandName, roleId, interaction.user.id).catch(err=>{console.error(err);});
      return interaction.update({ content: `✅ Cargo **${role?role.name:roleId}** removido do comando **${commandName}**.`, components: [], embeds: [] });
    }

    if (cid.startsWith('setup_keep_')) {
      return interaction.update({ content: '✅ Configuração mantida.', components: [], embeds: [] });
    }

    if (cid.startsWith('setup_done_')) {
      const parts = cid.split('_');
      const commandName = parts[2];
      const adminId = parts[3];
      if (interaction.user.id !== adminId) return interaction.reply({ content: 'Apenas o autor do painel pode concluir.', ephemeral: true });
      const rolesNow = await getCommandRoles(interaction.guild.id, commandName).catch(()=>[]);
      const embed = new EmbedBuilder().setTitle(`Configuração finalizada: ${commandName}`).setDescription(rolesNow.length ? `Cargos autorizados: ${rolesNow.map(r=>`<@&${r}>`).join(', ')` : 'Nenhum cargo configurado.').setColor(EMBED_COLOR).setTimestamp();
      return interaction.update({ embeds: [embed], components: [] });
    }

    if (cid.startsWith('setup_cancel_')) {
      const parts = cid.split('_');
      const adminId = parts[3];
      if (interaction.user.id !== adminId) return interaction.reply({ content: 'Apenas o autor do painel pode cancelar.', ephemeral: true });
      return interaction.update({ content: 'Operação cancelada.', embeds: [], components: [] });
    }

    // Carter send/cancel might be handled by message collector flow, but respond gracefully
    if (cid.startsWith('carter_cancel_')) {
      return interaction.update({ content: '❌ Envio cancelado.', embeds: [], components: [] }).catch(()=>{});
    }
    if (cid.startsWith('carter_send_')) {
      // the actual sending is handled inside message flow where button collector exists, reply here just informative
      return interaction.reply({ content: 'Processo de envio tratado no fluxo de confirmação. Se expirou, reexecute o comando.', ephemeral: true });
    }

  } catch (err) {
    console.error('Erro interactionCreate:', err);
    try { if (!interaction.replied) await interaction.reply({ content: '❌ Erro interno.', ephemeral: true }); } catch {}
  }
});

// ----- MESSAGES / COMMANDS -----
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
      const help = new EmbedBuilder()
        .setTitle('📚 Help — Comandos')
        .setColor(EMBED_COLOR)
        .setDescription('Lista de comandos e instruções')
        .addFields(
          { name: `${PREFIX}setup`, value: 'Painel de configuração (apenas administradores). Não aceita argumentos.' },
          { name: `${PREFIX}ban <@user|id> [motivo]`, value: 'Banir usuário (exige permissões discord + cargo configurado).' },
          { name: `${PREFIX}mute <@user|id> <duração> [motivo]`, value: 'Mutar por tempo. Exemplos de duração: 10m 2h 3d' },
          { name: `${PREFIX}unmute <@user|id>`, value: 'Remover mute.' },
          { name: `${PREFIX}warn <@user|id> [motivo]`, value: 'Advertência.' },
          { name: `${PREFIX}warns <@user|id?>`, value: 'Ver warns (por padrão mostra do autor).' },
          { name: `${PREFIX}clearwarns <@user|id>`, value: 'Limpar warns do usuário.' },
          { name: `${PREFIX}lock <canalId?> / ${PREFIX}unlock <canalId?>`, value: 'Trancar/destrancar canal.' },
          { name: `${PREFIX}lockdown / ${PREFIX}unlockdown`, value: 'Trancar todos os canais / reverter.' },
          { name: `${PREFIX}Carter` , value: 'Enviar DM em fluxo (somente em DM com o bot).' }
        );
      return message.channel.send({ embeds: [help] });
    }

    // SETUP (no args allowed)
    if (command === 'setup') {
      if (!message.guild) return message.reply('❌ -setup deve ser usado em servidor.');
      if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator) && !message.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
        return message.reply('🚫 Apenas administradores/gestores podem iniciar o setup.');
      }
      if (args.length > 0) {
        return message.reply('⚠️ O comando -setup **não aceita argumentos**. Use o painel de botões.');
      }

      const commands = ['ban','mute','warn','lock','unlock','clearwarns','warns','lockdown'];
      const rows = [];
      for (let i=0;i<commands.length;i+=5) {
        const chunk = commands.slice(i,i+5);
        const row = new ActionRowBuilder();
        for (const cmd of chunk) {
          row.addComponents(new ButtonBuilder().setCustomId(`setup_cmd_${cmd}_${message.author.id}`).setLabel(cmd.toUpperCase()).setStyle(ButtonStyle.Primary));
        }
        rows.push(row);
      }
      const embed = new EmbedBuilder().setTitle('🛠 Painel de Setup').setDescription('Clique em um comando para configurar os cargos que podem usá-lo. (Máx 7 por comando)').setColor(EMBED_COLOR);
      return message.reply({ embeds: [embed], components: rows });
    }

    // CARTER — DM only
    if (command === 'carter') {
      if (message.channel.type !== ChannelType.DM) return message.reply('❌ Carter só funciona em DM com o bot.');
      // Ask for target if not provided
      let targetArg = args[0];
      if (!targetArg) {
        await message.channel.send('Para quem deseja enviar? Responda com menção ou ID (60s).');
        try {
          const coll = await message.channel.awaitMessages({ filter: m => m.author.id === message.author.id, max: 1, time: 60000, errors: ['time'] });
          targetArg = coll.first().content.trim();
          try { await coll.first().delete().catch(()=>{}); } catch {}
        } catch {
          return message.channel.send('⌛ Cancelado por timeout.');
        }
      }
      const mention = targetArg.match(/^<@!?(\d+)>$/);
      const targetId = mention ? mention[1] : targetArg.replace(/\D/g,'');
      const targetUser = await client.users.fetch(targetId).catch(()=>null);
      if (!targetUser) return message.channel.send('❌ Usuário não encontrado.');

      await message.channel.send(`✍️ Digite a mensagem para ${targetUser.tag} (60s):`);
      let messageText;
      try {
        const coll = await message.channel.awaitMessages({ filter: m => m.author.id === message.author.id, max: 1, time: 60000, errors: ['time'] });
        messageText = coll.first().content.trim();
        try { await coll.first().delete().catch(()=>{}); } catch {}
      } catch {
        return message.channel.send('⌛ Cancelado por timeout.');
      }
      if (!messageText) return message.channel.send('❌ Mensagem vazia.');

      const preview = new EmbedBuilder().setTitle('📨 Confirmação - Carter').setColor(EMBED_COLOR)
        .addFields(
          { name: 'Destinatário', value: `${targetUser.tag} (<@${targetUser.id}>)` },
          { name: 'Remetente', value: `${message.author.tag}` },
          { name: 'Mensagem', value: messageText.length>1024?messageText.slice(0,1020)+'...':messageText },
          { name: 'Aviso', value: 'Se a mensagem for ofensiva/ameaçadora/ilegal, você pode ser responsabilizado.' }
        ).setTimestamp();

      const nonce = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2,8)}`;
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`carter_send_${nonce}`).setLabel('Enviar').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`carter_cancel_${nonce}`).setLabel('Cancelar').setStyle(ButtonStyle.Secondary)
      );
      const confirmMsg = await message.channel.send({ embeds: [preview], components: [row] });

      const filter = i => i.user.id === message.author.id && (i.customId === `carter_send_${nonce}` || i.customId === `carter_cancel_${nonce}`);
      const collector = confirmMsg.createMessageComponentCollector({ filter, max: 1, time: 30000 });

      collector.on('collect', async i => {
        if (i.customId === `carter_cancel_${nonce}`) {
          await i.update({ content: '❌ Envio cancelado.', embeds: [], components: [] }).catch(()=>{});
          return;
        }
        await i.update({ content: '⏳ Enviando...', embeds: [], components: [] }).catch(()=>{});
        const dmEmbed = new EmbedBuilder().setTitle('📩 Você recebeu uma mensagem').setDescription(messageText).addFields({ name: 'Enviada por', value: `${message.author.tag}` }, { name: 'ID do remetente', value: `${message.author.id}` }).setColor(EMBED_COLOR).setTimestamp();
        replyMap.set(nonce, { fromId: message.author.id, toId: targetUser.id, preview: messageText });
        const replyRow = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`reply_${nonce}`).setLabel('Responder').setStyle(ButtonStyle.Primary));
        let dmSuccess = false;
        try {
          await targetUser.send({ embeds: [dmEmbed], components: [replyRow] });
          dmSuccess = true;
        } catch (e) {
          dmSuccess = false;
        }
        const resultEmbed = new EmbedBuilder().setTitle(dmSuccess ? '✅ Mensagem enviada' : '⚠️ Falha ao enviar DM').setColor(dmSuccess ? '#22c55e' : '#e45656')
          .addFields({ name: 'Destinatário', value: `${targetUser.tag}` }, { name: 'Mensagem', value: messageText.length>1024?messageText.slice(0,1020)+'...':messageText }, { name: 'Observação', value: dmSuccess ? 'Mensagem entregue.' : 'Não foi possível entregar — DMs possivelmente bloqueadas.' }).setTimestamp();
        await message.channel.send({ embeds: [resultEmbed] }).catch(()=>{});
      });

      collector.on('end', collected => {
        if (collected.size === 0) confirmMsg.edit({ content: '⌛ Tempo esgotado — envio não confirmado.', embeds: [], components: [] }).catch(()=>{});
      });
      return;
    }

    // Moderation commands
    const modCommands = ['ban','mute','unmute','lock','unlock','warn','warns','clearwarns','lockdown','unlockdown'];
    if (modCommands.includes(command)) {
      if (!message.guild) return message.reply('Este comando só funciona no servidor.');
      if (!hasDiscordPermission(message.member, command)) return message.reply('🚫 Você não tem a permissão Discord exigida.');

      const cfg = await (async ()=> {
        try { return await dbGet(firebasePathCommandConfig(message.guild.id, command)); } catch(e){ return null; }
      })();
      // If using Firebase, cfg is object; if in-memory, we rely on getCommandRoles
      const rolesConfigured = await getCommandRoles(message.guild.id, command);
      if (!rolesConfigured || rolesConfigured.length === 0) {
        return message.reply(`❌ Este comando ainda não foi configurado. Peça a um administrador executar \`${PREFIX}setup\` e configurar o comando ${command.toUpperCase()}.`);
      }
      // admin bypass
      if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
        const allowed = rolesConfigured;
        const hasRole = allowed.some(rid => message.member.roles.cache.has(rid));
        if (!hasRole) return message.reply('🚫 Você não tem um dos cargos autorizados para executar este comando.');
      }

      // implement commands
      if (command === 'ban') {
        const target = args[0];
        const reason = args.slice(1).join(' ') || 'Não informado';
        if (!target) return message.reply(`Uso: ${PREFIX}ban <@user|id> [motivo]`);
        try {
          await actionBan(message.guild, message.member, target, reason);
          return message.reply({ embeds: [ new EmbedBuilder().setTitle('✅ Usuário banido').setDescription(`${target} banido por ${message.author.tag}`).addFields({name:'Motivo',value:reason}).setColor(EMBED_COLOR) ] });
        } catch (e) {
          return message.reply(`❌ Erro ao banir: ${e.message || e}`);
        }
      }

      if (command === 'mute') {
        const target = args[0];
        const dur = args[1];
        const reason = args.slice(2).join(' ') || 'Não informado';
        if (!target || !dur) return message.reply(`Uso: ${PREFIX}mute <@user|id> <duração: ex 10m 2h 3d> [motivo]`);
        const durMs = parseDurationPT(dur);
        if (!durMs) return message.reply('Duração inválida. Exemplos: 10m 2h 3d');
        try {
          await actionMute(message.guild, message.member, target, durMs, reason);
          return message.reply({ embeds: [ new EmbedBuilder().setTitle('🔇 Usuário mutado').setDescription(`${target} mutado por ${formatDuration(durMs)}`).addFields({name:'Motivo',value:reason}).setColor(EMBED_COLOR) ] });
        } catch (e) {
          return message.reply(`❌ Erro ao mutar: ${e.message || e}`);
        }
      }

      if (command === 'unmute') {
        const target = args[0];
        if (!target) return message.reply(`Uso: ${PREFIX}unmute <@user|id>`);
        try {
          await actionUnmute(message.guild, message.member, target);
          return message.reply('✅ Usuário desmutado.');
        } catch (e) {
          return message.reply(`❌ Erro ao desmutar: ${e.message || e}`);
        }
      }

      if (command === 'lock' || command === 'unlock') {
        const channelId = args[0] || message.channel.id;
        try {
          const ch = await actionLockChannel(message.guild, message.member, channelId, command==='unlock');
          return message.reply(`${command==='lock'?'🔒 Canal trancado':'🔓 Canal destrancado'}: <#${ch.id}>`);
        } catch (e) {
          return message.reply(`❌ Erro: ${e.message || e}`);
        }
      }

      if (command === 'warn') {
        const target = args[0];
        const reason = args.slice(1).join(' ') || 'Não informado';
        if (!target) return message.reply(`Uso: ${PREFIX}warn <@user|id> [motivo]`);
        const id = target.replace(/\D/g,'');
        const member = await message.guild.members.fetch(id).catch(()=>null);
        if (!member) return message.reply('Usuário não encontrado.');
        if (member.roles.highest.position >= message.member.roles.highest.position) return message.reply('🚫 Você não pode advertir alguém com cargo igual/maior que o seu.');
        const cur = await getWarns(message.guild.id, member.id);
        const next = (cur && typeof cur.count === 'number') ? cur.count + 1 : 1;
        await setWarns(message.guild.id, member.id, { count: next, lastReason: reason, lastBy: message.author.id, lastAt: Date.now() });
        try {
          await member.send({ embeds: [ new EmbedBuilder().setTitle('⚠️ Você recebeu uma advertência').setDescription(`Você recebeu uma advertência no servidor **${message.guild.name}**.`).addFields({name:'Motivo',value:reason},{name:'Advertência Nº',value:String(next)},{name:'Moderador',value:message.author.tag}).setColor(EMBED_COLOR).setTimestamp() ] }).catch(()=>{});
        } catch(e){}
        return message.reply(`⚠️ ${member.user.tag} recebeu advertência. Total: ${next}`);
      }

      if (command === 'warns') {
        const target = args[0] || message.author.id;
        const id = target.replace(/\D/g,'');
        const cur = await getWarns(message.guild.id, id);
        const c = (cur && typeof cur.count === 'number') ? cur.count : 0;
        return message.reply({ embeds: [ new EmbedBuilder().setTitle('📋 Warns').setDescription(`<@${id}> tem ${c} warn(s)`).setColor(EMBED_COLOR) ] });
      }

      if (command === 'clearwarns') {
        const target = args[0];
        if (!target) return message.reply(`Uso: ${PREFIX}clearwarns <@user|id>`);
        const id = target.replace(/\D/g,'');
        await deleteWarns(message.guild.id, id);
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
    }

  } catch (err) {
    console.error('Erro messageCreate:', err);
    try { if (message && message.channel) await message.channel.send('❌ Erro interno ao processar comando. Veja logs.'); } catch {}
  }
});

// ----- READY & LOGIN -----
client.once('ready', () => {
  console.log(`✅ Bot online: ${client.user.tag}`);
});

client.login(TOKEN).catch(err => {
  console.error('Erro ao logar. Verifique a variável de ambiente TOKEN:', err);
});
