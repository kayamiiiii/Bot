// index.js — Versão final corrigida
// Requisitos: Node 18+ recomendado
// Dependências: discord.js v14, express, node-fetch@2 (fallback se Node <18)
// Instalar (ex.): npm install discord.js express node-fetch@2

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

// fetch compat (Node 18+ tem global.fetch)
let fetcher = global.fetch;
if (!fetcher) {
  try {
    fetcher = require('node-fetch'); // node-fetch@2 (CommonJS)
  } catch (e) {
    console.error('fetch não disponível. Se estiver em Node < 18, instale node-fetch@2: npm install node-fetch@2');
    process.exit(1);
  }
}

// ---------- CONFIG ----------
const TOKEN = process.env.TOKEN || ''; // coloque o token como variável de ambiente
const FIREBASE_DATABASE_URL = (process.env.FIREBASE_DATABASE_URL || '').replace(/\/$/, ''); // opcional
const PREFIX = (process.env.PREFIX || '-').trim();
const PORT = process.env.PORT || 3000;
const EMBED_COLOR = '#8B4513'; // sua paleta
const MUTED_ROLE_NAME = process.env.MUTED_ROLE_NAME || 'Muted (Bot)';
const MAX_ROLES_PER_COMMAND = 7;

// sanity
if (!TOKEN) {
  console.error('ERRO: variável de ambiente TOKEN não definida. Defina TOKEN antes de rodar.');
  process.exit(1);
}

const useFirebase = !!FIREBASE_DATABASE_URL;

// ---------- UPTIME (express) ----------
const app = express();
app.get('/', (req, res) => res.send('Bot rodando'));
app.listen(PORT, () => console.log(`HTTP server ouvindo na porta ${PORT}`));

// ---------- CLIENT ----------
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

// ---------- STORAGE (Firebase REST ou in-memory) ----------
const memoryDB = {}; // estrutura simples para testes se firebase não configurado

async function dbGet(url) {
  if (!useFirebase) return null;
  try {
    const r = await fetcher(url);
    if (!r.ok) return null;
    return await r.json();
  } catch (e) {
    console.error('dbGet error', e);
    return null;
  }
}
async function dbSet(url, payload) {
  if (!useFirebase) return null;
  try {
    const r = await fetcher(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    if (!r.ok) throw new Error('Firebase PUT ' + r.status);
    return await r.json();
  } catch (e) {
    console.error('dbSet error', e);
    throw e;
  }
}
async function dbDelete(url) {
  if (!useFirebase) return false;
  try {
    const r = await fetcher(url, { method: 'DELETE' });
    return r.ok;
  } catch (e) {
    console.error('dbDelete error', e);
    return false;
  }
}

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
    await dbSet(url, payload);
    return payload;
  } else {
    if (!memoryDB[guildId]) memoryDB[guildId] = { commands:{}, warns:{}, lockdown_backup:{} };
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
    await dbSet(url, payload);
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
    const d = await dbGet(url).catch(()=>null);
    return d || null;
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
    if (!memoryDB[guildId]) memoryDB[guildId] = { commands:{}, warns:{}, lockdown_backup:{} };
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
    if (!memoryDB[guildId]) memoryDB[guildId] = { commands:{}, warns:{}, lockdown_backup:{} };
    memoryDB[guildId].lockdown_backup = payload;
    return payload;
  }
}
async function getLockdownBackup(guildId) {
  if (useFirebase) {
    const url = firebasePathLockdown(guildId);
    const d = await dbGet(url).catch(()=>null);
    return d || null;
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

// ---------- UTIL ----------
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
function parseDurationPT(text) {
  if (!text) return null;
  const s = text.trim().toLowerCase();
  // examples: 10m 2h 3d or "2 horas"
  const m = s.match(/^(\d+)\s*(m|minutos?|h|horas?|d|dias?)$/i);
  if (m) {
    const n = parseInt(m[1],10);
    const u = m[2].toLowerCase();
    if (u.startsWith('m')) return n*60*1000;
    if (u.startsWith('h')) return n*60*60*1000;
    if (u.startsWith('d')) return n*24*60*60*1000;
  }
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

// permissions required (discord)
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

// ---------- MOD ACTIONS ----------
const muteTimers = new Map(); // key guildId-userId => { timeout, expiresAt }

async function ensureMutedRole(guild) {
  let role = guild.roles.cache.find(r => r.name === MUTED_ROLE_NAME);
  if (role) return role;
  if (!guild.members.me.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
    throw new Error('Bot precisa de permissão Gerenciar Cargos para criar o cargo de mute.');
  }
  role = await guild.roles.create({ name: MUTED_ROLE_NAME, permissions: [] });
  for (const [, ch] of guild.channels.cache) {
    try {
      await ch.permissionOverwrites.edit(role, { SendMessages: false, AddReactions: false, Speak: false, Connect: false }).catch(()=>{});
    } catch {}
  }
  return role;
}

async function banUser(guild, moderator, target, reason='Não informado') {
  const id = String(target).replace(/\D/g,'');
  if (!id) throw new Error('ID inválido.');
  if (!guild.members.me.permissions.has(PermissionsBitField.Flags.BanMembers)) throw new Error('Bot sem permissão de ban.');
  try {
    const u = await client.users.fetch(id).catch(()=>null);
    if (u) {
      await u.send({ embeds: [ new EmbedBuilder().setTitle('🔨 Você foi banido').setDescription(`Você foi banido do servidor **${guild.name}**`).addFields({name:'Motivo',value:reason},{name:'Moderador',value:moderator.user.tag}).setColor(EMBED_COLOR).setTimestamp() ] }).catch(()=>{});
    }
  } catch {}
  await guild.members.ban(id, { reason });
  return true;
}

async function muteUser(guild, moderator, target, durationMs, reason='Não informado') {
  const id = String(target).replace(/\D/g,'');
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
    } catch (e) { console.error('unmute erro', e); }
    muteTimers.delete(key);
  }, durationMs);
  muteTimers.set(key, { timeout, expiresAt: Date.now() + durationMs });
  try { await member.send({ embeds: [ new EmbedBuilder().setTitle('🔇 Você foi silenciado').setDescription(`Você foi silenciado no servidor **${guild.name}**`).addFields({name:'Motivo',value:reason},{name:'Duração',value:formatDuration(durationMs)},{name:'Moderador',value:moderator.user.tag}).setColor(EMBED_COLOR).setTimestamp() ] }).catch(()=>{}); } catch {}
  return true;
}

async function unmuteUser(guild, moderator, target) {
  const id = String(target).replace(/\D/g,'');
  const member = await guild.members.fetch(id).catch(()=>null);
  if (!member) throw new Error('Usuário não encontrado.');
  const role = guild.roles.cache.find(r => r.name === MUTED_ROLE_NAME);
  if (!role || !member.roles.cache.has(role.id)) throw new Error('Usuário não está mutado.');
  await member.roles.remove(role, `Unmuted by ${moderator.user.tag}`).catch(err=>{ throw err; });
  const key = `${guild.id}-${member.id}`;
  if (muteTimers.has(key)) { clearTimeout(muteTimers.get(key).timeout); muteTimers.delete(key); }
  try { await member.send({ embeds: [ new EmbedBuilder().setTitle('🔊 Você foi desmutado').setDescription(`Seu mute foi removido no servidor **${guild.name}** por ${moderator.user.tag}`).setColor(EMBED_COLOR).setTimestamp() ] }).catch(()=>{}); } catch {}
  return true;
}

async function lockChannel(guild, moderator, channelId, lock=true) {
  const ch = guild.channels.cache.get(channelId);
  if (!ch) throw new Error('Canal não encontrado.');
  if (!guild.members.me.permissions.has(PermissionsBitField.Flags.ManageChannels)) throw new Error('Bot precisa de ManageChannels.');
  await ch.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: lock ? false : true }).catch(err=>{ throw err; });
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
        let sendAllowed = null;
        if (hadAllow) sendAllowed = true;
        else if (hadDeny) sendAllowed = false;
        else sendAllowed = null;
        backup[ch.id] = sendAllowed;
        await ch.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: false }).catch(()=>{});
      } catch(e) { console.warn('lockdown canal erro', ch.id, e); }
    }
  }
  await setLockdownBackup(guild.id, backup).catch(()=>{});
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
        await ch.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: true }).catch(()=>{});
      } else if (prev === false) {
        await ch.permissionOverwrites.edit(guild.roles.everyone, { SendMessages: false }).catch(()=>{});
      } else {
        await ch.permissionOverwrites.delete(guild.roles.everyone).catch(()=>{});
      }
    } catch(e) { console.warn('unlockdown restore erro', channelId, e); }
  }
  await deleteLockdownBackup(guild.id).catch(()=>{});
  return true;
}

// ---------- Carter reply store ----------
const replyMap = new Map(); // nonce -> { fromId, toId, preview }

// ---------- INTERACTIONS ----------
client.on('interactionCreate', async interaction => {
  try {
    if (!interaction.isButton()) return;

    const id = interaction.customId;

    // Carter reply button
    if (id.startsWith('reply_')) {
      await interaction.deferReply({ ephemeral: true });
      const nonce = id.slice('reply_'.length);
      const info = replyMap.get(nonce);
      if (!info) return interaction.editReply({ content: '⚠️ Link expirado ou inválido.' });
      await interaction.editReply({ content: '✍️ Escreva aqui a resposta (120s).' });
      const dm = interaction.channel;
      const filter = m => m.author.id === interaction.user.id;
      dm.awaitMessages({ filter, max: 1, time: 120000 }).then(async coll => {
        if (!coll || coll.size === 0) {
          return interaction.followUp({ content: '⌛ Tempo esgotado — resposta não enviada.', ephemeral: true });
        }
        const text = coll.first().content;
        const original = await client.users.fetch(info.fromId).catch(()=>null);
        if (!original) return interaction.followUp({ content: '❌ Não foi possível encontrar o remetente.', ephemeral: true });
        const embed = new EmbedBuilder().setTitle('💬 Resposta via Carter').setDescription(text).addFields({ name: 'Respondente', value: `${interaction.user.tag}` }).setColor('#2b9e4a').setTimestamp();
        try {
          await original.send({ embeds: [embed] });
          await interaction.followUp({ content: '✅ Resposta enviada ao remetente (DM).', ephemeral: true });
        } catch (e) {
          await interaction.followUp({ content: '❌ Falha ao enviar DM (destinatário pode ter DMs bloqueadas).', ephemeral: true });
        }
        replyMap.delete(nonce);
      }).catch(async () => {
        await interaction.followUp({ content: '⌛ Tempo esgotado — resposta não enviada.', ephemeral: true });
      });
      return;
    }

    // Setup flow interactions (lots of customIds)
    if (id.startsWith('setup_cmd_')) {
      const parts = id.split('_'); // setup_cmd_{command}_{adminId}
      const commandName = parts[2];
      const adminId = parts[3];
      if (interaction.user.id !== adminId) return interaction.reply({ content: 'Só o autor do painel pode interagir.', ephemeral: true });
      const guild = interaction.guild;
      const roles = guild.roles.cache.filter(r => r.id !== guild.id).map(r => ({ id: r.id, name: r.name }));
      if (!roles.length) return interaction.update({ content: 'Nenhum cargo disponível no servidor.', embeds: [], components: [] });
      const rows = [];
      const perPage = 10;
      const pageRoles = roles.slice(0, perPage);
      for (let i=0;i<pageRoles.length;i+=5) {
        const chunk = pageRoles.slice(i,i+5);
        const row = new ActionRowBuilder();
        for (const r of chunk) {
          row.addComponents(new ButtonBuilder().setCustomId(`setup_role_${commandName}_${r.id}_${adminId}`).setLabel(r.name.length>80?r.name.slice(0,77)+'...':r.name).setStyle(ButtonStyle.Primary));
        }
        rows.push(row);
      }
      rows.push(new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`setup_done_${commandName}_${adminId}`).setLabel('Concluir').setStyle(ButtonStyle.Success), new ButtonBuilder().setCustomId(`setup_cancel_${commandName}_${adminId}`).setLabel('Cancelar').setStyle(ButtonStyle.Secondary)));
      const embed = new EmbedBuilder().setTitle(`Configurar: ${commandName.toUpperCase()}`).setDescription('Clique em um cargo para adicionar/remover (máx 7).').setColor(EMBED_COLOR);
      await interaction.update({ embeds: [embed], components: rows });
      return;
    }

    if (id.startsWith('setup_role_')) {
      const parts = id.split('_'); // setup_role_{command}_{roleId}_{adminId}
      const commandName = parts[2];
      const roleId = parts[3];
      const adminId = parts[4];
      if (interaction.user.id !== adminId) return interaction.reply({ content: 'Só o autor do painel pode interagir.', ephemeral: true });
      const guild = interaction.guild;
      const role = guild.roles.cache.get(roleId);
      if (!role) return interaction.reply({ content: 'Cargo não encontrado.', ephemeral: true });
      const rolesNow = await getCommandRoles(guild.id, commandName).catch(()=>[]);
      const isPresent = rolesNow.includes(roleId);
      if (!isPresent) {
        if (rolesNow.length >= MAX_ROLES_PER_COMMAND) return interaction.reply({ content: `❌ Máximo de ${MAX_ROLES_PER_COMMAND} cargos atingido para este comando.`, ephemeral: true });
        await addRoleToCommand(guild.id, commandName, roleId, interaction.user.id).catch(()=>{});
        return interaction.reply({ content: `✅ Cargo **${role.name}** ADICIONADO ao comando **${commandName}**.`, ephemeral: true });
      } else {
        const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`setup_remove_${commandName}_${roleId}_${adminId}`).setLabel('Remover').setStyle(ButtonStyle.Danger), new ButtonBuilder().setCustomId(`setup_keep_${commandName}_${roleId}_${adminId}`).setLabel('Manter').setStyle(ButtonStyle.Secondary));
        return interaction.reply({ content: `O cargo **${role.name}** já está configurado para **${commandName}**. Deseja remover?`, components: [row], ephemeral: true });
      }
    }

    if (id.startsWith('setup_remove_')) {
      const parts = id.split('_');
      const commandName = parts[2];
      const roleId = parts[3];
      const adminId = parts[4];
      if (interaction.user.id !== adminId) return interaction.reply({ content: 'Só o autor do painel pode interagir.', ephemeral: true });
      const guild = interaction.guild;
      const role = guild.roles.cache.get(roleId);
      await removeRoleFromCommand(guild.id, commandName, roleId, interaction.user.id).catch(()=>{});
      return interaction.update({ content: `✅ Cargo **${role ? role.name : roleId}** removido do comando **${commandName}**.`, embeds: [], components: [] });
    }

    if (id.startsWith('setup_keep_')) {
      return interaction.update({ content: '✅ Mantido.', embeds: [], components: [] });
    }

    if (id.startsWith('setup_done_')) {
      const parts = id.split('_');
      const commandName = parts[2];
      const adminId = parts[3];
      if (interaction.user.id !== adminId) return interaction.reply({ content: 'Só o autor do painel pode concluir.', ephemeral: true });
      const rolesNow = await getCommandRoles(interaction.guild.id, commandName).catch(()=>[]);
      const description = rolesNow && rolesNow.length ? `Cargos autorizados: ${rolesNow.map(r=>`<@&${r}>`).join(', ')}` : 'Nenhum cargo configurado.';
      const embed = new EmbedBuilder().setTitle(`Configuração finalizada: ${commandName.toUpperCase()}`).setDescription(description).setColor(EMBED_COLOR).setTimestamp();
      return interaction.update({ embeds: [embed], components: [] });
    }

    if (id.startsWith('setup_cancel_')) {
      return interaction.update({ content: 'Operação cancelada.', embeds: [], components: [] });
    }

    // Carter buttons handled in message flow — respond gracefully
    if (id.startsWith('carter_cancel_')) {
      return interaction.update({ content: '❌ Envio cancelado.', embeds: [], components: [] }).catch(()=>{});
    }

    if (id.startsWith('carter_send_')) {
      return interaction.reply({ content: 'Processo de envio tratado no fluxo de confirmação. Se expirou, reexecute o comando.', ephemeral: true });
    }

  } catch (err) {
    console.error('Erro interactionCreate:', err);
    try { if (!interaction.replied) await interaction.reply({ content: '❌ Erro interno.', ephemeral: true }); } catch {}
  }
});

// ---------- MESSAGES / COMMANDS ----------
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
      const embed = new EmbedBuilder()
        .setTitle('📚 Ajuda — Comandos')
        .setColor(EMBED_COLOR)
        .setDescription('Painel de comandos e requisitos (use -setup para configurar cargos).')
        .addFields(
          { name: `${PREFIX}setup`, value: 'Painel de configuração (apenas administradores). Não aceita argumentos.' },
          { name: `${PREFIX}ban <@user|id> [motivo]`, value: 'Confirmação por botão, depois aplica ban.' },
          { name: `${PREFIX}mute <@user|id> <duração> [motivo]`, value: 'Confirmação por botão, muta por tempo.' },
          { name: `${PREFIX}unmute <@user|id>`, value: 'Remove mute.' },
          { name: `${PREFIX}warn <@user|id> [motivo]`, value: 'Adiciona warn e envia DM.' },
          { name: `${PREFIX}warns <@user|id?>`, value: 'Mostra warns do usuário.' },
          { name: `${PREFIX}clearwarns <@user|id>`, value: 'Limpa warns do usuário.' },
          { name: `${PREFIX}lock <canalId?> / ${PREFIX}unlock <canalId?>`, value: 'Trancar/destrancar canal (por ID ou canal atual).' },
          { name: `${PREFIX}lockdown / ${PREFIX}unlockdown`, value: 'Trancar/destrancar todos os canais (backup salvo).' },
          { name: `${PREFIX}Carter`, value: 'Fluxo em DM para enviar mensagens com confirmação e botão de resposta.' }
        );
      return message.channel.send({ embeds: [embed] });
    }

    // SETUP (painel)
    if (command === 'setup') {
      if (!message.guild) return message.reply('❌ -setup deve ser usado em servidor.');
      if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator) && !message.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) {
        return message.reply('🚫 Apenas administradores/gestores podem iniciar o setup.');
      }
      if (args.length > 0) return message.reply('⚠️ -setup não aceita argumentos. Use o painel de botões.');
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
      const embed = new EmbedBuilder().setTitle('🛠 Painel de Setup').setDescription('Clique no comando para configurar cargos (máx 7 por comando). Apenas você pode interagir com esse painel.').setColor(EMBED_COLOR);
      return message.reply({ embeds: [embed], components: rows });
    }

    // CARTER — DM-only flow
    if (command === 'carter') {
      if (message.channel.type !== ChannelType.DM) return message.reply('❌ Carter só funciona em DM com o bot.');
      // get target
      let targetArg = args[0];
      if (!targetArg) {
        await message.channel.send('Para quem deseja enviar? Responda com menção ou ID (60s).');
        try {
          const coll = await message.channel.awaitMessages({ filter: m => m.author.id === message.author.id, max:1, time:60000, errors:['time'] });
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

      // get message
      await message.channel.send(`✍️ Digite a mensagem para ${targetUser.tag} (60s):`);
      let messageText;
      try {
        const coll = await message.channel.awaitMessages({ filter: m => m.author.id === message.author.id, max:1, time:60000, errors:['time'] });
        messageText = coll.first().content.trim();
        try { await coll.first().delete().catch(()=>{}); } catch {}
      } catch {
        return message.channel.send('⌛ Cancelado por timeout.');
      }
      if (!messageText) return message.channel.send('❌ Mensagem vazia.');

      // preview + confirm buttons
      const preview = new EmbedBuilder().setTitle('📨 Confirmação - Carter').setColor(EMBED_COLOR)
        .addFields(
          { name: 'Destinatário', value: `${targetUser.tag} (<@${targetUser.id}>)` },
          { name: 'Remetente', value: `${message.author.tag}` },
          { name: 'Mensagem', value: messageText.length>1024?messageText.slice(0,1020)+'...':messageText },
          { name: 'Aviso', value: 'Se a mensagem for ofensiva/ameaçadora/ilegal, você pode ser responsabilizado.' }
        ).setTimestamp();

      const nonce = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2,8)}`;
      const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`carter_send_${nonce}`).setLabel('Enviar').setStyle(ButtonStyle.Success), new ButtonBuilder().setCustomId(`carter_cancel_${nonce}`).setLabel('Cancelar').setStyle(ButtonStyle.Secondary));
      const confirmMsg = await message.channel.send({ embeds: [preview], components: [row] });

      const filter = i => i.user.id === message.author.id && (i.customId === `carter_send_${nonce}` || i.customId === `carter_cancel_${nonce}`);
      const collector = confirmMsg.createMessageComponentCollector({ filter, max:1, time:30000 });
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
          .addFields({ name: 'Destinatário', value: `${targetUser.tag}` }, { name: 'Observação', value: dmSuccess ? 'Mensagem entregue.' : 'Não foi possível entregar — DMs bloqueadas?' }).setTimestamp();
        await message.channel.send({ embeds: [resultEmbed] }).catch(()=>{});
      });
      collector.on('end', collected => {
        if (collected.size === 0) confirmMsg.edit({ content: '⌛ Tempo esgotado — envio não confirmado.', embeds: [], components: [] }).catch(()=>{});
      });
      return;
    } // end Carter

    // ---------- MOD COMMANDS ----------
    const modCommands = ['ban','mute','unmute','lock','unlock','warn','warns','clearwarns','lockdown','unlockdown'];
    if (modCommands.includes(command)) {
      if (!message.guild) return message.reply('Este comando só funciona no servidor.');
      if (!hasDiscordPermission(message.member, command)) return message.reply('🚫 Você não tem a permissão Discord exigida para este comando.');

      const rolesConfigured = await getCommandRoles(message.guild.id, command).catch(()=>[]);
      if (!rolesConfigured || rolesConfigured.length === 0) {
        return message.reply(`❌ Este comando não está configurado. Peça a um admin executar \`${PREFIX}setup\` e configurar o comando ${command.toUpperCase()}.`);
      }
      // role authorization (admin bypass)
      if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
        const allowed = rolesConfigured;
        const hasRole = allowed.some(rid => message.member.roles.cache.has(rid));
        if (!hasRole) return message.reply('🚫 Você não tem um dos cargos autorizados para executar este comando.');
      }

      // BAN (com confirmação via botões)
      if (command === 'ban') {
        const target = args[0];
        const reason = args.slice(1).join(' ') || 'Não informado';
        if (!target) return message.reply(`Uso: ${PREFIX}ban <@user|id> [motivo]`);
        const mentionId = target.match(/^<@!?(\d+)>$/);
        const targetId = mentionId ? mentionId[1] : target.replace(/\D/g,'');
        const targetUser = await client.users.fetch(targetId).catch(()=>null);
        if (!targetUser) return message.reply('Usuário não encontrado.');
        // preview confirm
        const embed = new EmbedBuilder().setTitle('⚠️ Confirmação de ban').setColor(EMBED_COLOR)
          .setDescription(`Você deseja mesmo banir ${targetUser.tag}?`)
          .addFields({ name: 'Motivo', value: reason }, { name: 'Moderador', value: `${message.author.tag}` }).setTimestamp();
        const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`confirm_ban_${message.id}_${targetId}`).setLabel('Confirmar').setStyle(ButtonStyle.Danger), new ButtonBuilder().setCustomId(`cancel_ban_${message.id}_${targetId}`).setLabel('Cancelar').setStyle(ButtonStyle.Secondary));
        const confMsg = await message.channel.send({ embeds: [embed], components: [row] });
        const filter = i => i.user.id === message.author.id && (i.customId === `confirm_ban_${message.id}_${targetId}` || i.customId === `cancel_ban_${message.id}_${targetId}`);
        const collector = confMsg.createMessageComponentCollector({ filter, max:1, time:30000 });
        collector.on('collect', async i => {
          if (i.customId === `cancel_ban_${message.id}_${targetId}`) {
            return i.update({ content: '❌ Ban cancelado.', embeds: [], components: [] });
          }
          // confirm
          await i.update({ content: '⏳ Aplicando ban...', embeds: [], components: [] }).catch(()=>{});
          try {
            await banUser(message.guild, message.member, targetId, reason);
            await message.channel.send({ embeds: [ new EmbedBuilder().setTitle('✅ Ban aplicado').setDescription(`${targetUser.tag} banido por ${message.author.tag}`).addFields({ name:'Motivo', value:reason }).setColor(EMBED_COLOR).setTimestamp() ] });
          } catch (e) {
            await message.channel.send(`❌ Erro ao banir: ${e.message || e}`);
          }
        });
        collector.on('end', collected => {
          if (collected.size === 0) confMsg.edit({ content: '⌛ Tempo esgotado — ban não confirmado.', embeds: [], components: [] }).catch(()=>{});
        });
        return;
      }

      // MUTE (confirmação + duração)
      if (command === 'mute') {
        const target = args[0];
        const dur = args[1];
        const reason = args.slice(2).join(' ') || 'Não informado';
        if (!target || !dur) return message.reply(`Uso: ${PREFIX}mute <@user|id> <duração ex: 10m 2h 3d> [motivo]`);
        const durMs = parseDurationPT(dur);
        if (!durMs) return message.reply('Duração inválida. Exemplos: 10m 2h 3d');
        const targetId = (target.match(/^<@!?(\d+)>$/) ? target.match(/^<@!?(\d+)>$/)[1] : target.replace(/\D/g,''));
        const targetUser = await client.users.fetch(targetId).catch(()=>null);
        if (!targetUser) return message.reply('Usuário não encontrado.');
        const embed = new EmbedBuilder().setTitle('⚠️ Confirmação de mute').setColor(EMBED_COLOR).setDescription(`Deseja aplicar mute em ${targetUser.tag}?`).addFields({ name:'Duração', value: formatDuration(durMs) }, { name:'Motivo', value: reason }).setTimestamp();
        const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`confirm_mute_${message.id}_${targetId}_${durMs}`).setLabel('Confirmar').setStyle(ButtonStyle.Danger), new ButtonBuilder().setCustomId(`cancel_mute_${message.id}_${targetId}`).setLabel('Cancelar').setStyle(ButtonStyle.Secondary));
        const confMsg = await message.channel.send({ embeds: [embed], components: [row] });
        const filter = i => i.user.id === message.author.id && (i.customId === `confirm_mute_${message.id}_${targetId}_${durMs}` || i.customId === `cancel_mute_${message.id}_${targetId}`);
        const collector = confMsg.createMessageComponentCollector({ filter, max:1, time:30000 });
        collector.on('collect', async i => {
          if (i.customId === `cancel_mute_${message.id}_${targetId}`) {
            return i.update({ content: '❌ Mute cancelado.', embeds: [], components: [] });
          }
          await i.update({ content: '⏳ Aplicando mute...', embeds: [], components: [] }).catch(()=>{});
          try {
            await muteUser(message.guild, message.member, targetId, durMs, reason);
            await message.channel.send({ embeds: [ new EmbedBuilder().setTitle('🔇 Mutado').setDescription(`${targetUser.tag} mutado por ${formatDuration(durMs)}`).addFields({name:'Motivo',value:reason}).setColor(EMBED_COLOR).setTimestamp() ] });
          } catch (e) {
            await message.channel.send(`❌ Erro ao mutar: ${e.message || e}`);
          }
        });
        collector.on('end', collected => {
          if (collected.size === 0) confMsg.edit({ content: '⌛ Tempo esgotado — mute não confirmado.', embeds: [], components: [] }).catch(()=>{});
        });
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
          return message.reply(`❌ Erro ao desmutar: ${e.message || e}`);
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

      // WARN
      if (command === 'warn') {
        const target = args[0];
        const reason = args.slice(1).join(' ') || 'Não informado';
        if (!target) return message.reply(`Uso: ${PREFIX}warn <@user|id> [motivo]`);
        const id = (target.match(/^<@!?(\d+)>$/) ? target.match(/^<@!?(\d+)>$/)[1] : target.replace(/\D/g,''));
        const member = await message.guild.members.fetch(id).catch(()=>null);
        if (!member) return message.reply('Usuário não encontrado.');
        if (member.roles.highest.position >= message.member.roles.highest.position) return message.reply('🚫 Você não pode advertir alguém com cargo igual/maior que o seu.');
        const cur = await getWarns(message.guild.id, member.id);
        const next = (cur && typeof cur.count === 'number') ? cur.count + 1 : 1;
        await setWarns(message.guild.id, member.id, { count: next, lastReason: reason, lastBy: message.author.id, lastAt: Date.now() });
        try { await member.send({ embeds: [ new EmbedBuilder().setTitle('⚠️ Você recebeu uma advertência').setDescription(`Você recebeu uma advertência no servidor **${message.guild.name}**.`).addFields({name:'Motivo',value:reason},{name:'Advertência Nº',value:String(next)},{name:'Moderador',value:message.author.tag}).setColor(EMBED_COLOR).setTimestamp() ] }).catch(()=>{}); } catch {}
        return message.reply(`⚠️ ${member.user.tag} recebeu advertência. Total: ${next}`);
      }

      // WARNS
      if (command === 'warns') {
        const target = args[0] || message.author.id;
        const id = (target.match(/^<@!?(\d+)>$/) ? target.match(/^<@!?(\d+)>$/)[1] : target.replace(/\D/g,''));
        const cur = await getWarns(message.guild.id, id);
        const c = (cur && typeof cur.count === 'number') ? cur.count : 0;
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
          return message.reply(`❌ Erro no lockdown: ${e.message || e}`);
        }
      }
      if (command === 'unlockdown') {
        try {
          await unlockdownAll(message.guild, message.member);
          return message.reply('🔓 Lockdown revertido (tentativa de restauração das permissões).');
        } catch (e) {
          return message.reply(`❌ Erro ao reverter lockdown: ${e.message || e}`);
        }
      }

    } // end modCommands

  } catch (err) {
    console.error('Erro messageCreate:', err);
    try { if (message && message.channel) await message.channel.send('❌ Erro interno ao processar comando. Veja logs.'); } catch {}
  }
});

// ---------- READY & LOGIN ----------
client.once('ready', () => {
  console.log(`✅ Bot online: ${client.user.tag}`);
});

client.login(TOKEN).catch(err => {
  console.error('Erro ao logar. Verifique a variável de ambiente TOKEN:', err);
});
