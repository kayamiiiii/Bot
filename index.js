/**
 * index.js — Bot único
 * Funcionalidades principais:
 *  - -setup (painel de configuração com botões)
 *  - -setuphourlock (configura LockHour; exige fuso BR)
 *  - -lockhour (mostra config)
 *  - -warn (motivo obrigatório + confirmação; envia DM e informa resultado)
 *  - -warns / -clearwarns
 *  - -ban, -mute, -unmute, -lock, -unlock, -lockdown, -unlockdown (básicos)
 *  - Express server para manter processo online (Render)
 *
 * Use process.env.TOKEN no Render.
 * AVISO: armazenamento em memória — reinício perde configs (posso adicionar Firebase se quiser).
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

const TOKEN = process.env.TOKEN || 'INSIRA_SEU_TOKEN_AQUI'; // DEFINA process.env.TOKEN no Render
const PREFIX = process.env.PREFIX || '-';
const PORT = process.env.PORT || 3000;
const EMBED_COLOR = '#8B4513';
const MUTED_ROLE_NAME = 'Muted (Bot)';
const MAX_ROLES_PER_COMMAND = 7;

// Express (uptime)
const app = express();
app.get('/', (req, res) => res.send('Bot online'));
app.listen(PORT, () => console.log(`Express escutando na porta ${PORT}`));

// Discord client
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

// ---------- In-memory storage ----------
const db = {}; // db[guildId] = { commands: {cmd: {roles:{roleId:true}}}, warns: {userId: {count,...}}, lockhour: {...}, lockdown_backup: {...} }
function ensureGuild(gid) {
  if (!db[gid]) db[gid] = { commands: {}, warns: {}, lockhour: null, lockdown_backup: {} };
  return db[gid];
}
async function getCommandRoles(gid, cmd) {
  const g = ensureGuild(gid);
  return g.commands[cmd] && g.commands[cmd].roles ? Object.keys(g.commands[cmd].roles) : [];
}
async function addRoleToCommand(gid, cmd, roleId, setterId) {
  const g = ensureGuild(gid);
  if (!g.commands[cmd]) g.commands[cmd] = { roles: {} };
  g.commands[cmd].roles[roleId] = true;
  g.commands[cmd].configuredBy = setterId;
  g.commands[cmd].configuredAt = Date.now();
  return g.commands[cmd];
}
async function removeRoleFromCommand(gid, cmd, roleId, setterId) {
  const g = ensureGuild(gid);
  if (!g.commands[cmd]) return null;
  delete g.commands[cmd].roles[roleId];
  g.commands[cmd].configuredBy = setterId;
  g.commands[cmd].configuredAt = Date.now();
  return g.commands[cmd];
}
async function getWarns(gid, uid) { const g = ensureGuild(gid); return g.warns[uid] || null; }
async function setWarns(gid, uid, payload) { const g = ensureGuild(gid); g.warns[uid] = payload; return payload; }
async function deleteWarns(gid, uid) { const g = ensureGuild(gid); delete g.warns[uid]; return true; }
async function setLockHour(gid, payload) { const g = ensureGuild(gid); g.lockhour = payload; return payload; }
async function getLockHour(gid) { const g = ensureGuild(gid); return g.lockhour || null; }
async function deleteLockHour(gid) { const g = ensureGuild(gid); g.lockhour = null; return true; }
async function setLockdownBackup(gid, payload) { const g = ensureGuild(gid); g.lockdown_backup = payload; return payload; }
async function getLockdownBackup(gid) { const g = ensureGuild(gid); return g.lockdown_backup || {}; }
async function deleteLockdownBackup(gid) { const g = ensureGuild(gid); g.lockdown_backup = {}; return true; }

// ---------- Helpers ----------
function parseDurationPT(text) {
  if (!text) return null;
  const s = text.trim().toLowerCase();
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
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  const d = Math.floor(h / 24);
  if (d) return `${d} dia(s)`;
  if (h) return `${h} hora(s)`;
  if (m) return `${m} minuto(s)`;
  return `${s} segundo(s)`;
}

function parseTimePT(input) {
  if (!input) return null;
  const s = input.trim().toLowerCase();
  if (/^(meia[-\s]?noite|meianoite)$/i.test(s)) return { h: 0, m: 0 };
  if (/^(meio[-\s]?dia|meiodia)$/i.test(s)) return { h: 12, m: 0 };
  let m = s.match(/^(\d{1,2}):(\d{2})$/);
  if (m) {
    const hh = parseInt(m[1], 10), mm = parseInt(m[2], 10);
    if (hh >= 0 && hh < 24 && mm >= 0 && mm < 60) return { h: hh, m: mm };
  }
  m = s.match(/^(\d{1,2})h(\d{2})$/);
  if (m) {
    const hh = parseInt(m[1], 10), mm = parseInt(m[2], 10);
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

// Brasil timezone handling: Brasília é UTC-3 (no Brasil atualmente não há DST oficial).
// To schedule "daily at HH:MM Brasília", convert Brasília time to UTC: UTC = BR + 3h
function msUntilNextBrasil(hour, minute) {
  const now = new Date();
  // target UTC time components:
  let targetHourUTC = hour + 3; // BR -> UTC
  let targetDay = now.getUTCDate();
  let targetMonth = now.getUTCMonth();
  let targetYear = now.getUTCFullYear();
  if (targetHourUTC >= 24) {
    targetHourUTC -= 24;
    // move to next day for initial target if necessary
    const tmp = new Date(Date.UTC(targetYear, targetMonth, targetDay));
    tmp.setUTCDate(tmp.getUTCDate() + 1);
    targetDay = tmp.getUTCDate();
    targetMonth = tmp.getUTCMonth();
    targetYear = tmp.getUTCFullYear();
  }
  let target = new Date(Date.UTC(targetYear, targetMonth, targetDay, targetHourUTC, minute, 0, 0));
  if (target <= now) {
    // schedule for next day
    const tmp = new Date(target.getTime() + 24 * 60 * 60 * 1000);
    target = tmp;
  }
  return target.getTime() - now.getTime();
}

// ---------- Permissions helper ----------
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

// ---------- Moderation utilities ----------
async function ensureMutedRole(guild) {
  let role = guild.roles.cache.find(r => r.name === MUTED_ROLE_NAME);
  if (role) return role;
  if (!guild.members.me.permissions.has(PermissionsBitField.Flags.ManageRoles)) throw new Error('Bot precisa de permissão Gerenciar Cargos para criar role de mute.');
  role = await guild.roles.create({ name: MUTED_ROLE_NAME, permissions: [] });
  for (const [, ch] of guild.channels.cache) {
    try {
      if (ch.type === ChannelType.GuildText || ch.type === ChannelType.GuildAnnouncement) {
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
      await u.send({ embeds: [ new EmbedBuilder().setTitle('🔨 Você foi banido').setDescription(`Você foi banido do servidor **${guild.name}**`).addFields({ name:'Motivo', value:reason }, { name:'Moderador', value:moderator.user.tag }).setColor(EMBED_COLOR).setTimestamp() ] }).catch(()=>{});
    }
  } catch {}
  await guild.members.ban(targetId, { reason });
  return true;
}

const muteTimers = new Map();
async function muteUser(guild, moderator, targetId, durationMs, reason='Não informado') {
  const member = await guild.members.fetch(targetId).catch(()=>null);
  if (!member) throw new Error('Usuário não encontrado.');
  if (member.roles.highest.position >= moderator.roles.highest.position) throw new Error('Não pode mutar alguém com cargo igual/maior que o seu.');
  const role = await ensureMutedRole(guild);
  await member.roles.add(role, `Muted by ${moderator.user.tag}: ${reason}`);
  const key = `${guild.id}-${member.id}`;
  if (muteTimers.has(key)) clearTimeout(muteTimers.get(key).timeout);
  const timeout = setTimeout(async () => {
    try {
      const fresh = await guild.members.fetch(member.id).catch(()=>null);
      if (fresh && role && fresh.roles.cache.has(role.id)) {
        await fresh.roles.remove(role, 'Unmute automático (expirado)').catch(()=>{});
      }
    } catch (e) { console.error('unmute erro', e); }
    muteTimers.delete(key);
  }, durationMs);
  muteTimers.set(key, { timeout, expiresAt: Date.now()+durationMs });
  try { await member.send({ embeds: [ new EmbedBuilder().setTitle('🔇 Você foi silenciado').setDescription(`Você foi silenciado no servidor **${guild.name}**`).addFields({name:'Motivo', value:reason}, {name:'Duração', value: formatDuration(durationMs)}, {name:'Moderador', value: moderator.user.tag}).setColor(EMBED_COLOR).setTimestamp() ] }).catch(()=>{}); } catch {}
  return true;
}

async function unmuteUser(guild, moderator, targetId) {
  const member = await guild.members.fetch(targetId).catch(()=>null);
  if (!member) throw new Error('Usuário não encontrado.');
  const role = guild.roles.cache.find(r => r.name === MUTED_ROLE_NAME);
  if (!role || !member.roles.cache.has(role.id)) throw new Error('Usuário não está mutado.');
  await member.roles.remove(role, `Unmuted by ${moderator.user.tag}`).catch(err => { throw err; });
  const key = `${guild.id}-${member.id}`;
  if (muteTimers.has(key)) { clearTimeout(muteTimers.get(key).timeout); muteTimers.delete(key); }
  try { await member.send({ embeds: [ new EmbedBuilder().setTitle('🔊 Você foi desmutado').setDescription(`Seu mute foi removido no servidor **${guild.name}** por ${moderator.user.tag}`).setColor(EMBED_COLOR).setTimestamp() ] }).catch(()=>{}); } catch {}
  return true;
}

async function lockChannel(guild, moderator, channelId, lock=true) {
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
    if (ch.type === ChannelType.GuildText || ch.type === ChannelType.GuildAnnouncement) {
      try {
        const overwrite = ch.permissionOverwrites.cache.get(guild.id);
        const hadAllow = overwrite && overwrite.allow && overwrite.allow.has(PermissionsBitField.Flags.SendMessages);
        const hadDeny = overwrite && overwrite.deny && overwrite.deny.has(PermissionsBitField.Flags.SendMessages);
        let prev = null;
        if (hadAllow) prev = true;
        else if (hadDeny) prev = false;
        backup[ch.id] = prev;
        await ch.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: false }).catch(()=>{});
      } catch (e) { console.warn('lockdown err', e); }
    }
  }
  await setLockdownBackup(guild.id, backup).catch(()=>{});
  return true;
}

async function unlockdownAll(guild, moderator) {
  if (!guild.members.me.permissions.has(PermissionsBitField.Flags.ManageChannels)) throw new Error('Bot precisa de ManageChannels.');
  const backup = await getLockdownBackup(guild.id) || {};
  for (const chId of Object.keys(backup)) {
    const ch = guild.channels.cache.get(chId);
    if (!ch) continue;
    const prev = backup[chId];
    try {
      if (prev === true) await ch.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: true }).catch(()=>{});
      else if (prev === false) await ch.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: false }).catch(()=>{});
      else await ch.permissionOverwrites.delete(guild.roles.everyone).catch(()=>{});
    } catch (e) { console.warn('unlockdown restore err', e); }
  }
  await deleteLockdownBackup(guild.id).catch(()=>{});
  return true;
}

// ---------- LockHour scheduling ----------
const lockHourTimers = new Map(); // guildId => { startTimeout, endTimeout, startInterval, endInterval }
function clearLockHourTimers(gid) {
  const t = lockHourTimers.get(gid);
  if (!t) return;
  if (t.startTimeout) clearTimeout(t.startTimeout);
  if (t.endTimeout) clearTimeout(t.endTimeout);
  if (t.startInterval) clearInterval(t.startInterval);
  if (t.endInterval) clearInterval(t.endInterval);
  lockHourTimers.delete(gid);
}
async function scheduleLockHour(guild, cfg) {
  // cfg: { enabled:true, start:{h,m}, end:{h,m}, configuredBy, configuredAt }
  if (!cfg || !cfg.enabled) return;
  clearLockHourTimers(guild.id);
  const startMs = msUntilNextBrasil(cfg.start.h, cfg.start.m);
  const endMs = msUntilNextBrasil(cfg.end.h, cfg.end.m);

  // start timeout
  const startTimeout = setTimeout(async () => {
    try { await lockdownAll(guild, guild.members.me); console.log(`LockHour START applied for ${guild.id}`); } catch (e) { console.error('lockhour start err', e); }
  }, startMs);

  // end timeout
  const endTimeout = setTimeout(async () => {
    try { await unlockdownAll(guild, guild.members.me); console.log(`LockHour END applied for ${guild.id}`); } catch (e) { console.error('lockhour end err', e); }
  }, endMs);

  // set intervals to repeat every 24h after the scheduled moment (use extra setTimeout to wait first run)
  const startInterval = setTimeout(() => {
    const iv = setInterval(async () => {
      try { await lockdownAll(guild, guild.members.me); } catch (e) { console.error('lockhour recurring start err', e); }
    }, 24*60*60*1000);
    const cur = lockHourTimers.get(guild.id) || {};
    cur.startInterval = iv;
    lockHourTimers.set(guild.id, cur);
  }, startMs + 1000);

  const endInterval = setTimeout(() => {
    const iv = setInterval(async () => {
      try { await unlockdownAll(guild, guild.members.me); } catch (e) { console.error('lockhour recurring end err', e); }
    }, 24*60*60*1000);
    const cur = lockHourTimers.get(guild.id) || {};
    cur.endInterval = iv;
    lockHourTimers.set(guild.id, cur);
  }, endMs + 1000);

  lockHourTimers.set(guild.id, { startTimeout, endTimeout, startInterval: null, endInterval: null });
}

// Load configs on ready
async function loadLockHours() {
  for (const [id, guild] of client.guilds.cache) {
    const cfg = await getLockHour(id);
    if (cfg && cfg.enabled) {
      try { await scheduleLockHour(guild, cfg); } catch (e) { console.warn('Erro schedule on load', e); }
    }
  }
}

// ---------- Interaction handling (setup buttons etc.) ----------
client.on('interactionCreate', async interaction => {
  try {
    if (!interaction.isButton()) return;
    const id = interaction.customId;

    // Setup command buttons: setup_cmd_{command}_{adminId}
    if (id.startsWith('setup_cmd_')) {
      const parts = id.split('_'); // ["setup","cmd","ban","12345"]
      const commandName = parts[2];
      const adminId = parts[3];
      if (interaction.user.id !== adminId) return interaction.reply({ content: 'Somente o autor pode usar este painel.', ephemeral: true });
      const guild = interaction.guild;
      const roles = guild.roles.cache.filter(r => r.id !== guild.id).map(r => ({ id: r.id, name: r.name }));
      if (!roles.length) return interaction.update({ content: 'Nenhum cargo disponível.', embeds: [], components: [] });
      const rows = [];
      for (let i = 0; i < roles.length && i < 20; i += 5) {
        const chunk = roles.slice(i, i+5);
        const row = new ActionRowBuilder();
        for (const r of chunk) {
          row.addComponents(new ButtonBuilder().setCustomId(`setup_role_${commandName}_${r.id}_${adminId}`).setLabel(r.name.length>80? r.name.slice(0,77)+'...' : r.name).setStyle(ButtonStyle.Primary));
        }
        rows.push(row);
      }
      rows.push(new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`setup_done_${commandName}_${adminId}`).setLabel('Concluir').setStyle(ButtonStyle.Success), new ButtonBuilder().setCustomId(`setup_cancel_${commandName}_${adminId}`).setLabel('Cancelar').setStyle(ButtonStyle.Secondary)));
      const embed = new EmbedBuilder().setTitle(`Configurar: ${commandName.toUpperCase()}`).setDescription('Clique em um cargo para adicionar/remover (máx 7).').setColor(EMBED_COLOR);
      return interaction.update({ embeds: [embed], components: rows });
    }

    if (id.startsWith('setup_role_')) {
      const parts = id.split('_'); // setup_role_{cmd}_{roleId}_{adminId}
      const commandName = parts[2];
      const roleId = parts[3];
      const adminId = parts[4];
      if (interaction.user.id !== adminId) return interaction.reply({ content: 'Somente o autor pode interagir.', ephemeral: true });
      const guild = interaction.guild;
      const role = guild.roles.cache.get(roleId);
      if (!role) return interaction.reply({ content: 'Cargo não encontrado.', ephemeral: true });
      const rolesNow = await getCommandRoles(guild.id, commandName);
      const present = rolesNow.includes(roleId);
      if (!present) {
        if (rolesNow.length >= MAX_ROLES_PER_COMMAND) return interaction.reply({ content: `Máx ${MAX_ROLES_PER_COMMAND} cargos por comando.`, ephemeral: true });
        await addRoleToCommand(guild.id, commandName, roleId, interaction.user.id);
        return interaction.reply({ content: `✅ Cargo **${role.name}** ADICIONADO ao comando **${commandName}**.`, ephemeral: true });
      } else {
        const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`setup_remove_${commandName}_${roleId}_${adminId}`).setLabel('Remover').setStyle(ButtonStyle.Danger), new ButtonBuilder().setCustomId(`setup_keep_${commandName}_${roleId}_${adminId}`).setLabel('Manter').setStyle(ButtonStyle.Secondary));
        return interaction.reply({ content: `O cargo **${role.name}** já está configurado. Deseja remover?`, components: [row], ephemeral: true });
      }
    }

    if (id.startsWith('setup_remove_')) {
      const parts = id.split('_');
      const commandName = parts[2];
      const roleId = parts[3];
      const adminId = parts[4];
      if (interaction.user.id !== adminId) return interaction.reply({ content: 'Somente o autor pode interagir.', ephemeral: true });
      const guild = interaction.guild;
      const role = guild.roles.cache.get(roleId);
      await removeRoleFromCommand(guild.id, commandName, roleId, interaction.user.id);
      return interaction.update({ content: `✅ Cargo **${role ? role.name : roleId}** removido do comando **${commandName}**.`, embeds: [], components: [] });
    }

    if (id.startsWith('setup_done_')) {
      const parts = id.split('_');
      const commandName = parts[2];
      const adminId = parts[3];
      if (interaction.user.id !== adminId) return interaction.reply({ content: 'Somente o autor pode concluir.', ephemeral: true });
      const rolesNow = await getCommandRoles(interaction.guild.id, commandName);
      const desc = rolesNow && rolesNow.length ? `Cargos autorizados: ${rolesNow.map(r=>`<@&${r}>`).join(', ')}` : 'Nenhum cargo configurado.';
      const embed = new EmbedBuilder().setTitle(`Configuração finalizada: ${commandName.toUpperCase()}`).setDescription(desc).setColor(EMBED_COLOR).setTimestamp();
      return interaction.update({ embeds: [embed], components: [] });
    }

    if (id.startsWith('setup_cancel_')) {
      return interaction.update({ content: 'Operação cancelada.', embeds: [], components: [] });
    }

  } catch (err) {
    console.error('interactionCreate err', err);
    try { if (!interaction.replied) await interaction.reply({ content: 'Erro interno.', ephemeral: true }); } catch {}
  }
});

// ---------- Message commands ----------
client.on('messageCreate', async message => {
  try {
    if (message.author.bot) return;
    if (!message.content.startsWith(PREFIX)) return;

    const raw = message.content.slice(PREFIX.length).trim();
    const argv = raw.split(/\s+/).filter(Boolean);
    const cmd = (argv[0]||'').toLowerCase();
    const args = argv.slice(1);

    // HELP
    if (cmd === 'help') {
      const embed = new EmbedBuilder().setTitle('📚 Ajuda').setColor(EMBED_COLOR)
        .setDescription('Comandos principais')
        .addFields(
          { name: `${PREFIX}setup`, value: 'Configurar cargos por comando (apenas admin)' },
          { name: `${PREFIX}setuphourlock`, value: 'Configurar LockHour (apenas admin) — exige fuso BR' },
          { name: `${PREFIX}lockhour`, value: 'Mostrar configuração atual' },
          { name: `${PREFIX}warn <@user|id>`, value: 'Pede motivo (obrigatório) + confirmação; tenta DM e mostra se entregou' },
          { name: `${PREFIX}warns <@user|id?>`, value: 'Ver warns' }
        );
      return message.channel.send({ embeds: [embed] });
    }

    // SETUP panel
    if (cmd === 'setup') {
      if (!message.guild) return message.reply('⚠️ Use este comando no servidor.');
      if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) return message.reply('🚫 Apenas administradores podem usar -setup.');
      const commands = ['ban','mute','warn','lock','unlock','clearwarns','warns','lockdown','lockhour'];
      const rows = [];
      for (let i=0;i<commands.length;i+=5) {
        const chunk = commands.slice(i,i+5);
        const row = new ActionRowBuilder();
        for (const c of chunk) row.addComponents(new ButtonBuilder().setCustomId(`setup_cmd_${c}_${message.author.id}`).setLabel(c.toUpperCase()).setStyle(ButtonStyle.Primary));
        rows.push(row);
      }
      const embed = new EmbedBuilder().setTitle('🛠 Painel de Setup').setDescription('Clique no comando para configurar cargos autorizados (máx 7). Apenas você pode interagir.').setColor(EMBED_COLOR);
      return message.reply({ embeds: [embed], components: rows });
    }

    // SETUPHOURLOCK guided (BR timezone required)
    if (cmd === 'setuphourlock') {
      if (!message.guild) return message.reply('⚠️ Use no servidor.');
      if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) return message.reply('🚫 Apenas administradores podem usar.');
      // ask for timezone - accept only BR
      await message.reply('🌎 Primeiro, informe o fuso: **Digite "BR"** (apenas Brasil é aceito). Você tem 60s:');
      let tz;
      try {
        const coll = await message.channel.awaitMessages({ filter: m => m.author.id === message.author.id, max:1, time:60000, errors:['time'] });
        tz = coll.first().content.trim().toLowerCase();
      } catch {
        return message.reply('⌛ Tempo esgotado (fuso). Reexecute -setuphourlock.');
      }
      if (!['br','brasil','brazil','bra'].includes(tz)) return message.reply('❌ Só aceitamos fuso do Brasil (digite "BR"). Comando abortado.');

      await message.reply('🕒 Agora informe o horário **inicial** do LOCK (ex: 22:00, 22h00, 22 horas, meia-noite). 90s:');
      let startInput;
      try {
        const coll = await message.channel.awaitMessages({ filter: m => m.author.id===message.author.id, max:1, time:90000, errors:['time'] });
        startInput = coll.first().content.trim();
      } catch {
        return message.reply('⌛ Tempo esgotado (início). Reexecute -setuphourlock.');
      }
      const startParsed = parseTimePT(startInput);
      if (!startParsed) return message.reply('❌ Horário inicial inválido (use 22:00, 22h00, 22 horas).');

      await message.reply('🕒 Agora informe o horário **final** do LOCK (quando desbloqueia). 90s:');
      let endInput;
      try {
        const coll2 = await message.channel.awaitMessages({ filter: m => m.author.id===message.author.id, max:1, time:90000, errors:['time'] });
        endInput = coll2.first().content.trim();
      } catch {
        return message.reply('⌛ Tempo esgotado (final). Reexecute -setuphourlock.');
      }
      const endParsed = parseTimePT(endInput);
      if (!endParsed) return message.reply('❌ Horário final inválido.');

      // confirmation
      const preview = new EmbedBuilder().setTitle('⏰ Confirmação — LockHour (Horário de Brasília)')
        .setColor(EMBED_COLOR)
        .setDescription('Deseja ativar o Lock diário com o horário abaixo? (Fuso: Brasil — UTC−3)')
        .addFields(
          { name: 'Início (BR)', value: `${String(startParsed.h).padStart(2,'0')}:${String(startParsed.m).padStart(2,'0')}`, inline:true },
          { name: 'Término (BR)', value: `${String(endParsed.h).padStart(2,'0')}:${String(endParsed.m).padStart(2,'0')}`, inline:true },
          { name: 'Configurado por', value: `${message.author.tag}`, inline:false }
        ).setTimestamp();
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`lockhour_confirm_${message.id}`).setLabel('Ativar').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`lockhour_cancel_${message.id}`).setLabel('Cancelar').setStyle(ButtonStyle.Secondary)
      );
      const confMsg = await message.channel.send({ embeds: [preview], components: [row] });

      const filter = i => i.user.id === message.author.id && (i.customId === `lockhour_confirm_${message.id}` || i.customId === `lockhour_cancel_${message.id}`);
      const collector = confMsg.createMessageComponentCollector({ filter, max:1, time:30000 });
      collector.on('collect', async i => {
        if (i.customId === `lockhour_cancel_${message.id}`) return i.update({ content: '❌ Configuração cancelada.', embeds: [], components: [] });
        // save config
        const payload = { enabled: true, start: startParsed, end: endParsed, configuredBy: message.author.id, configuredAt: Date.now() };
        await setLockHour(message.guild.id, payload);
        // schedule
        try { await scheduleLockHour(message.guild, payload); } catch (e) { console.error('scheduleLockHour err', e); }
        await i.update({ content: `✅ LockHour ativado (BR): ${String(startParsed.h).padStart(2,'0')}:${String(startParsed.m).padStart(2,'0')} → ${String(endParsed.h).padStart(2,'0')}:${String(endParsed.m).padStart(2,'0')}`, embeds: [], components: [] });
      });
      collector.on('end', collected => { if (collected.size===0) confMsg.edit({ content: '⌛ Tempo esgotado — não confirmado.', embeds: [], components: [] }).catch(()=>{}); });
      return;
    }

    // CARTER DM flow — not changing now (kept from prior code)...
    if (cmd === 'carter') {
      if (message.channel.type !== ChannelType.DM) return message.reply('❌ Carter só funciona em DM com o bot.');
      // simplified: ask target, ask text, confirm with buttons, send DM and show result
      let targetArg = args[0];
      if (!targetArg) {
        await message.channel.send('Para quem deseja enviar? Responda com menção ou ID (60s).');
        try {
          const coll = await message.channel.awaitMessages({ filter: m => m.author.id === message.author.id, max:1, time:60000, errors:['time'] });
          targetArg = coll.first().content.trim();
        } catch { return message.channel.send('⌛ Cancelado por timeout.'); }
      }
      const mention = targetArg.match(/^<@!?(\d+)>$/);
      const targetId = mention ? mention[1] : targetArg.replace(/\D/g,'');
      const targetUser = await client.users.fetch(targetId).catch(()=>null);
      if (!targetUser) return message.channel.send('Usuário não encontrado.');
      await message.channel.send(`✍️ Digite a mensagem para ${targetUser.tag} (60s):`);
      let messageText;
      try {
        const coll = await message.channel.awaitMessages({ filter: m => m.author.id === message.author.id, max:1, time:60000, errors:['time'] });
        messageText = coll.first().content.trim();
      } catch { return message.channel.send('⌛ Cancelado por timeout.'); }
      if (!messageText) return message.channel.send('Mensagem vazia.');
      const preview = new EmbedBuilder().setTitle('📨 Confirmação - Carter').setColor(EMBED_COLOR)
        .addFields({ name:'Destinatário', value: `${targetUser.tag} (<@${targetUser.id}>)` }, { name:'Remetente', value: `${message.author.tag}` }, { name:'Mensagem', value: messageText.length>1024?messageText.slice(0,1020)+'...' : messageText }, { name:'Aviso', value: 'Mensagens ofensivas podem ter consequências.' })
        .setTimestamp();
      const nonce = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2,8)}`;
      const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`carter_send_${nonce}`).setLabel('Enviar').setStyle(ButtonStyle.Success), new ButtonBuilder().setCustomId(`carter_cancel_${nonce}`).setLabel('Cancelar').setStyle(ButtonStyle.Secondary));
      const confMsg = await message.channel.send({ embeds: [preview], components: [row] });
      const filter = i => i.user.id === message.author.id && (i.customId === `carter_send_${nonce}` || i.customId === `carter_cancel_${nonce}`);
      const collector = confMsg.createMessageComponentCollector({ filter, max:1, time:30000 });
      collector.on('collect', async i => {
        if (i.customId === `carter_cancel_${nonce}`) return i.update({ content: '❌ Envio cancelado.', embeds: [], components: [] });
        await i.update({ content: '⏳ Enviando...', embeds: [], components: [] }).catch(()=>{});
        const dmEmbed = new EmbedBuilder().setTitle('📩 Você recebeu uma mensagem').setDescription(messageText).addFields({ name:'Enviada por', value: `${message.author.tag}` }, { name:'ID do remetente', value: `${message.author.id}` }).setColor(EMBED_COLOR).setTimestamp();
        let dmSuccess = false;
        try { await targetUser.send({ embeds: [dmEmbed] }); dmSuccess = true; } catch (e) { dmSuccess = false; }
        const resultEmbed = new EmbedBuilder().setTitle(dmSuccess ? '✅ Mensagem enviada' : '⚠️ Falha ao enviar DM').setColor(dmSuccess ? '#22c55e' : '#e45656').addFields({ name:'Destinatário', value: `${targetUser.tag}` }, { name:'Observação', value: dmSuccess ? 'Mensagem entregue.' : 'Não foi possível entregar — DMs possivelmente bloqueadas.' }).setTimestamp();
        await message.channel.send({ embeds: [resultEmbed] }).catch(()=>{});
      });
      collector.on('end', collected => { if (collected.size === 0) confMsg.edit({ content: '⌛ Tempo esgotado — envio não confirmado.', embeds: [], components: [] }).catch(()=>{}); });
      return;
    }

    // Moderation commands list
    const modCommands = ['ban','mute','unmute','lock','unlock','warn','warns','clearwarns','lockdown','unlockdown','lockhour'];
    if (modCommands.includes(cmd)) {
      if (!message.guild) return message.reply('Este comando só funciona no servidor.');
      if (!hasDiscordPermission(message.member, cmd)) return message.reply('🚫 Você não tem a permissão Discord exigida.');
      const rolesConfigured = await getCommandRoles(message.guild.id, cmd);
      if (!rolesConfigured || rolesConfigured.length === 0) {
        return message.reply(`❌ Este comando não está configurado. Peça a um administrador executar \`${PREFIX}setup\` e configurar o comando ${cmd.toUpperCase()}.`);
      }
      // role check (admins bypass)
      if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
        const allowed = rolesConfigured;
        const hasRole = allowed.some(rid => message.member.roles.cache.has(rid));
        if (!hasRole) return message.reply('🚫 Você não tem um dos cargos autorizados para executar este comando.');
      }

      // BAN
      if (cmd === 'ban') {
        const target = args[0];
        const reason = args.slice(1).join(' ') || 'Não informado';
        if (!target) return message.reply(`Uso: ${PREFIX}ban <@user|id> [motivo]`);
        const mention = target.match(/^<@!?(\d+)>$/);
        const targetId = mention ? mention[1] : target.replace(/\D/g,'');
        const user = await client.users.fetch(targetId).catch(()=>null);
        if (!user) return message.reply('Usuário não encontrado.');
        const embed = new EmbedBuilder().setTitle('⚠️ Confirmação de ban').setColor(EMBED_COLOR).setDescription(`Você deseja banir ${user.tag}?`).addFields({ name:'Motivo', value:reason }, { name:'Moderador', value: message.author.tag }).setTimestamp();
        const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`confirm_ban_${message.id}_${targetId}`).setLabel('Confirmar').setStyle(ButtonStyle.Danger), new ButtonBuilder().setCustomId(`cancel_ban_${message.id}_${targetId}`).setLabel('Cancelar').setStyle(ButtonStyle.Secondary));
        const confMsg = await message.channel.send({ embeds: [embed], components: [row] });
        const filter = i => i.user.id === message.author.id && (i.customId === `confirm_ban_${message.id}_${targetId}` || i.customId === `cancel_ban_${message.id}_${targetId}`);
        const collector = confMsg.createMessageComponentCollector({ filter, max:1, time:30000 });
        collector.on('collect', async i => {
          if (i.customId === `cancel_ban_${message.id}_${targetId}`) return i.update({ content: '❌ Ban cancelado.', embeds: [], components: [] });
          await i.update({ content: '⏳ Aplicando ban...', embeds: [], components: [] }).catch(()=>{});
          try {
            await banUser(message.guild, message.member, targetId, reason);
            await message.channel.send({ embeds: [ new EmbedBuilder().setTitle('✅ Ban aplicado').setDescription(`${user.tag} banido por ${message.author.tag}`).addFields({ name:'Motivo', value: reason }).setColor(EMBED_COLOR).setTimestamp() ] });
          } catch (e) {
            await message.channel.send(`❌ Erro ao banir: ${e.message || e}`);
          }
        });
        collector.on('end', collected => { if (collected.size===0) confMsg.edit({ content: '⌛ Tempo esgotado — não confirmado.', embeds: [], components: [] }).catch(()=>{}); });
        return;
      }

      // MUTE
      if (cmd === 'mute') {
        const target = args[0];
        const dur = args[1];
        const reason = args.slice(2).join(' ') || 'Não informado';
        if (!target || !dur) return message.reply(`Uso: ${PREFIX}mute <@user|id> <duração ex: 10m 2h 3d> [motivo]`);
        const durMs = parseDurationPT(dur);
        if (!durMs) return message.reply('Duração inválida. Exemplos: 10m 2h 3d');
        const targetId = (target.match(/^<@!?(\d+)>$/) ? target.match(/^<@!?(\d+)>$/)[1] : target.replace(/\D/g,''));
        const user = await client.users.fetch(targetId).catch(()=>null);
        if (!user) return message.reply('Usuário não encontrado.');
        const embed = new EmbedBuilder().setTitle('⚠️ Confirmação de mute').setColor(EMBED_COLOR).setDescription(`Deseja aplicar mute em ${user.tag}?`).addFields({ name:'Duração', value: formatDuration(durMs) }, { name:'Motivo', value: reason }).setTimestamp();
        const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`confirm_mute_${message.id}_${targetId}_${durMs}`).setLabel('Confirmar').setStyle(ButtonStyle.Danger), new ButtonBuilder().setCustomId(`cancel_mute_${message.id}_${targetId}`).setLabel('Cancelar').setStyle(ButtonStyle.Secondary));
        const confMsg = await message.channel.send({ embeds: [embed], components: [row] });
        const filter = i => i.user.id === message.author.id && (i.customId === `confirm_mute_${message.id}_${targetId}_${durMs}` || i.customId === `cancel_mute_${message.id}_${targetId}`);
        const collector = confMsg.createMessageComponentCollector({ filter, max:1, time:30000 });
        collector.on('collect', async i => {
          if (i.customId === `cancel_mute_${message.id}_${targetId}`) return i.update({ content: '❌ Mute cancelado.', embeds: [], components: [] });
          await i.update({ content: '⏳ Aplicando mute...', embeds: [], components: [] }).catch(()=>{});
          try {
            await muteUser(message.guild, message.member, targetId, durMs, reason);
            await message.channel.send({ embeds: [ new EmbedBuilder().setTitle('🔇 Mutado').setDescription(`${user.tag} mutado por ${formatDuration(durMs)}`).addFields({ name:'Motivo', value: reason }).setColor(EMBED_COLOR).setTimestamp() ] });
          } catch (e) {
            await message.channel.send(`❌ Erro ao mutar: ${e.message || e}`);
          }
        });
        collector.on('end', collected => { if (collected.size===0) confMsg.edit({ content: '⌛ Tempo esgotado — não confirmado.', embeds: [], components: [] }).catch(()=>{}); });
        return;
      }

      // UNMUTE
      if (cmd === 'unmute') {
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
      if (cmd === 'lock' || cmd === 'unlock') {
        const channelId = args[0] || message.channel.id;
        try {
          const ch = await lockChannel(message.guild, message.member, channelId, cmd === 'lock');
          return message.reply(`${cmd === 'lock' ? '🔒 Canal trancado' : '🔓 Canal destrancado'}: <#${ch.id}>`);
        } catch (e) {
          return message.reply(`❌ Erro: ${e.message || e}`);
        }
      }

      // WARN (requires reason + confirmation, and informs whether DM delivered)
      if (cmd === 'warn') {
        const target = args[0];
        if (!target) return message.reply(`Uso: ${PREFIX}warn <@user|id>`);
        const id = (target.match(/^<@!?(\d+)>$/) ? target.match(/^<@!?(\d+)>$/)[1] : target.replace(/\D/g,''));
        const member = await message.guild.members.fetch(id).catch(()=>null);
        if (!member) return message.reply('Usuário não encontrado.');
        if (member.roles.highest.position >= message.member.roles.highest.position) return message.reply('🚫 Você não pode advertir alguém com cargo igual/maior que o seu.');

        // ask for reason
        await message.reply(`✍️ Informe o **motivo** da advertência para ${member.user.tag} (obrigatório). Você tem 90s:`);
        let reasonText;
        try {
          const coll = await message.channel.awaitMessages({ filter: m => m.author.id === message.author.id, max:1, time:90000, errors:['time'] });
          reasonText = coll.first().content.trim();
        } catch { return message.reply('⌛ Tempo esgotado. Reexecute -warn.'); }
        if (!reasonText) return message.reply('❌ Motivo obrigatório. Abortando.');

        // preview + confirmation
        const preview = new EmbedBuilder().setTitle('⚠️ Confirmação de Advertência').setColor(EMBED_COLOR).setDescription(`Deseja realmente advertir **${member.user.tag}**?`).addFields({ name:'Motivo', value: reasonText }, { name:'Moderador', value: message.author.tag }).setTimestamp();
        const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`confirm_warn_${message.id}_${member.id}`).setLabel('Enviar').setStyle(ButtonStyle.Success), new ButtonBuilder().setCustomId(`cancel_warn_${message.id}_${member.id}`).setLabel('Cancelar').setStyle(ButtonStyle.Secondary));
        const confMsg = await message.channel.send({ embeds: [preview], components: [row] });
        const filter = i => i.user.id === message.author.id && (i.customId === `confirm_warn_${message.id}_${member.id}` || i.customId === `cancel_warn_${message.id}_${member.id}`);
        const collector = confMsg.createMessageComponentCollector({ filter, max:1, time:30000 });
        collector.on('collect', async i => {
          if (i.customId === `cancel_warn_${message.id}_${member.id}`) return i.update({ content: '❌ Advertência cancelada.', embeds: [], components: [] });
          await i.update({ content: '⏳ Aplicando advertência...', embeds: [], components: [] }).catch(()=>{});
          try {
            const cur = await getWarns(message.guild.id, member.id);
            const next = (cur && typeof cur.count === 'number') ? cur.count + 1 : 1;
            await setWarns(message.guild.id, member.id, { count: next, lastReason: reasonText, lastBy: message.author.id, lastAt: Date.now() });
            // try to DM user and capture result
            let dmSuccess = false;
            try {
              await member.send({ embeds: [ new EmbedBuilder().setTitle('⚠️ Você recebeu uma advertência').setDescription(`Você recebeu uma advertência no servidor **${message.guild.name}**.`).addFields({ name:'Motivo', value: reasonText }, { name:'Advertência Nº', value: String(next) }, { name:'Moderador', value: message.author.tag }).setColor(EMBED_COLOR).setTimestamp() ] });
              dmSuccess = true;
            } catch (e) {
              dmSuccess = false;
              console.log(`Não foi possível enviar DM para ${member.user.tag}`);
            }
            // final message in channel
            const finalEmbed = new EmbedBuilder().setTitle('✅ Advertência aplicada').setColor(EMBED_COLOR)
              .setDescription(`${member.user.tag} advertido por ${message.author.tag}`)
              .addFields({ name:'Motivo', value: reasonText }, { name:'Total de warns', value: String(next) }, { name:'DM entregue?', value: dmSuccess ? '✅ Sim' : '❌ Não — DMs possivelmente bloqueadas' })
              .setTimestamp();
            await message.channel.send({ embeds: [finalEmbed] });
          } catch (e) {
            await message.channel.send(`❌ Erro ao aplicar advertência: ${e.message || e}`);
          }
        });
        collector.on('end', collected => { if (collected.size===0) confMsg.edit({ content: '⌛ Tempo esgotado — advertência não confirmada.', embeds: [], components: [] }).catch(()=>{}); });
        return;
      }

      // WARNS
      if (cmd === 'warns') {
        const target = args[0] || message.author.id;
        const id = (target.match(/^<@!?(\d+)>$/) ? target.match(/^<@!?(\d+)>$/)[1] : target.replace(/\D/g,''));
        const cur = await getWarns(message.guild.id, id);
        const c = (cur && typeof cur.count === 'number') ? cur.count : 0;
        return message.reply({ embeds: [ new EmbedBuilder().setTitle('📋 Warns').setDescription(`<@${id}> tem ${c} warn(s)`).setColor(EMBED_COLOR) ] });
      }

      // CLEARWARNS
      if (cmd === 'clearwarns') {
        const target = args[0];
        if (!target) return message.reply(`Uso: ${PREFIX}clearwarns <@user|id>`);
        const id = (target.match(/^<@!?(\d+)>$/) ? target.match(/^<@!?(\d+)>$/)[1] : target.replace(/\D/g,''));
        await deleteWarns(message.guild.id, id);
        return message.reply(`✅ Warns de <@${id}> limpos.`);
      }

      // LOCKDOWN / UNLOCKDOWN
      if (cmd === 'lockdown') {
        try {
          await lockdownAll(message.guild, message.member);
          return message.reply('🔐 Lockdown ativado (todos os canais).');
        } catch (e) {
          return message.reply(`❌ Erro no lockdown: ${e.message || e}`);
        }
      }
      if (cmd === 'unlockdown') {
        try {
          await unlockdownAll(message.guild, message.member);
          return message.reply('🔓 Lockdown revertido (tentativa de restauração).');
        } catch (e) {
          return message.reply(`❌ Erro ao reverter lockdown: ${e.message || e}`);
        }
      }

      // LOCKHOUR show
      if (cmd === 'lockhour') {
        const cfg = await getLockHour(message.guild.id);
        if (!cfg || !cfg.enabled) return message.reply('🔕 LockHour não está configurado neste servidor.');
        const embed = new EmbedBuilder().setTitle('⏰ LockHour — Configuração atual').setColor(EMBED_COLOR)
          .addFields({ name:'Início (BR)', value: `${String(cfg.start.h).padStart(2,'0')}:${String(cfg.start.m).padStart(2,'0')}`, inline:true }, { name:'Término (BR)', value: `${String(cfg.end.h).padStart(2,'0')}:${String(cfg.end.m).padStart(2,'0')}`, inline:true }, { name:'Configurado por', value: `<@${cfg.configuredBy}>` }).setTimestamp();
        return message.reply({ embeds: [embed] });
      }

    } // end modCommands

  } catch (err) {
    console.error('messageCreate err', err);
    try { if (message && message.channel) await message.channel.send('❌ Erro interno ao processar comando. Veja logs.'); } catch {}
  }
});

// ---------- Ready ----------
client.once('ready', async () => {
  console.log(`✅ Bot online: ${client.user.tag}`);
  await loadLockHours();
});

// ---------- Login ----------
client.login(TOKEN).catch(err => {
  console.error('Erro ao logar. Verifique process.env.TOKEN:', err);
});
