require("dotenv").config();
const { Client, GatewayIntentBits, EmbedBuilder } = require("discord.js");
const { Pool } = require("pg");

// ================== BASE DE DATOS ==================
const db = new Pool({
  host: process.env.PGHOST,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE,
  port: process.env.PGPORT,
  ssl: { rejectUnauthorized: false }
});

async function initDB() {
  await db.query(`CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    saldo REAL DEFAULT 0,
    codigo TEXT,
    mensajeId TEXT,
    referidos INTEGER DEFAULT 0
  )`);

  await db.query(`CREATE TABLE IF NOT EXISTS historial (
    id SERIAL PRIMARY KEY,
    userId TEXT,
    fecha TEXT,
    monto REAL
  )`);
}

// ================== CLIENTE DISCORD ==================
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages
  ],
});

// ================== FUNCIONES ==================
function generarCodigo(longitud = 6) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let codigo = "";
  for (let i = 0; i < longitud; i++) {
    codigo += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return codigo;
}

function crearEmbedWallet(username, avatarURL, saldo, codigo, referidos, ultimos7, ultimos30) {
  return new EmbedBuilder()
    .setAuthor({ name: `Wallet de ${username}`, iconURL: avatarURL })
    .setColor("#1f8bff")
    .addFields(
      { name: "Saldo actual", value: `$${saldo.toFixed(2)} USD`, inline: true },
      { name: "Código único", value: codigo, inline: true },
      { name: "Referidos", value: `${referidos ?? 0}`, inline: true },
      { name: "Últimos 7 días", value: `$${ultimos7.toFixed(2)} USD`, inline: true },
      { name: "Últimos 30 días", value: `$${ultimos30.toFixed(2)} USD`, inline: true }
    )
    .setFooter({ text: "Datos actualizados automáticamente" })
    .setTimestamp();
}

async function obtenerGananciaPeriodo(userId, dias) {
  const fechaLimite = new Date();
  fechaLimite.setDate(fechaLimite.getDate() - dias);
  const fechaISO = fechaLimite.toISOString().split("T")[0];

  const res = await db.query(
    `SELECT SUM(monto) as total FROM historial WHERE userId = $1 AND fecha >= $2`,
    [userId, fechaISO]
  );
  return res.rows[0].total || 0;
}

async function procesarGananciaDiaria() {
  const hoy = new Date().toISOString().split("T")[0];
  const usuarios = (await db.query(`SELECT * FROM users`)).rows;

  for (const user of usuarios) {
    const ganancia = user.saldo * 0.02;
    const nuevoSaldo = user.saldo + ganancia;

    await db.query(`UPDATE users SET saldo = $1 WHERE id = $2`, [nuevoSaldo, user.id]);
    await db.query(`INSERT INTO historial (userId, fecha, monto) VALUES ($1, $2, $3)`, [
      user.id, hoy, ganancia
    ]);
  }

  console.log("✅ Ganancia diaria procesada");
  actualizarTodasLasWallets();
}

async function actualizarTodasLasWallets() {
  const guild = client.guilds.cache.first();
  if (!guild) return;

  const walletChannel = guild.channels.cache.get(process.env.WALLET_CHANNEL_ID);
  if (!walletChannel) return;

  const usuarios = (await db.query(`SELECT * FROM users`)).rows;

  for (const user of usuarios) {
    try {
      const member = await guild.members.fetch(user.id);
      const g7 = await obtenerGananciaPeriodo(user.id, 7);
      const g30 = await obtenerGananciaPeriodo(user.id, 30);

      const embed = crearEmbedWallet(
        member.user.username,
        member.user.displayAvatarURL(),
        user.saldo,
        user.codigo,
        user.referidos,
        g7,
        g30
      );

      const msg = await walletChannel.messages.fetch(user.mensajeId);
      await msg.edit({ embeds: [embed] });
    } catch (e) {
      console.error(`No se pudo actualizar wallet de ${user.id}`, e);
    }
  }
}

// ================== EVENTOS ==================
client.once("ready", async () => {
  console.log(`🤖 Bot conectado como ${client.user.tag}`);
  await initDB();

  const guild = client.guilds.cache.first();
  if (!guild) return console.log("⚠️ El bot no está en ningún servidor.");

  const walletChannel = guild.channels.cache.get(process.env.WALLET_CHANNEL_ID);
  if (!walletChannel) return console.log("⚠️ No se encontró el canal WALLET");

  const members = await guild.members.fetch();
  for (const member of members.values()) {
    if (member.user.bot) continue;

    const res = await db.query(`SELECT * FROM users WHERE id = $1`, [member.id]);
    const row = res.rows[0];

    if (!row) {
      const codigo = generarCodigo();
      const saldo = 0;
      const referidos = 0;

      const embed = crearEmbedWallet(member.user.username, member.user.displayAvatarURL(), saldo, codigo, referidos, 0, 0);
      const mensaje = await walletChannel.send({ embeds: [embed] });

      await db.query(
        `INSERT INTO users (id, saldo, codigo, mensajeId, referidos) VALUES ($1, $2, $3, $4, $5)`,
        [member.id, saldo, codigo, mensaje.id, referidos]
      );
    } else {
      const g7 = await obtenerGananciaPeriodo(row.id, 7);
      const g30 = await obtenerGananciaPeriodo(row.id, 30);

      const embed = crearEmbedWallet(member.user.username, member.user.displayAvatarURL(), row.saldo, row.codigo, row.referidos, g7, g30);
      const msg = await walletChannel.messages.fetch(row.mensajeId);
      await msg.edit({ embeds: [embed] });
    }
  }

  // Ejecutar ganancia diaria cada 24h
  setInterval(procesarGananciaDiaria, 24 * 60 * 60 * 1000);
});

client.on("guildMemberAdd", async (member) => {
  if (member.user.bot) return;

  const walletChannel = member.guild.channels.cache.get(process.env.WALLET_CHANNEL_ID);
  if (!walletChannel) return;

  const codigo = generarCodigo();
  const saldo = 0;
  const referidos = 0;

  const embed = crearEmbedWallet(member.user.username, member.user.displayAvatarURL(), saldo, codigo, referidos, 0, 0);
  const mensaje = await walletChannel.send({ embeds: [embed] });

  await db.query(
    `INSERT INTO users (id, saldo, codigo, mensajeId, referidos) VALUES ($1, $2, $3, $4, $5)`,
    [member.id, saldo, codigo, mensaje.id, referidos]
  );
});

// ================== EJECUTAR BOT ==================
client.login(process.env.TOKEN);
