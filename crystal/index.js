import {
  Client,
  GatewayIntentBits,
  Partials,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  PermissionFlagsBits,
  ChannelType,
  Events,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ApplicationCommandOptionType,
} from "discord.js";

import express from "express";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";
import { v4 as uuid } from "uuid";

import { createInvoicePDF } from "./utils/invoice.js";
import { createCryptomusInvoice, isCryptomusWebhookTrusted } from "./utils/crypto.js";
import { createStripeCheckout, getStripe } from "./utils/stripe.js";
import {
  upsertOrder,
  getOrderByChannelId,
  getOrderById,
  markPaid,
  ensureDataFiles,
} from "./utils/store.js";

import {
  findCoupon,
  applyCouponToAmount,
  addCoupon,
  deleteCoupon,
  listCoupons,
  incrementCouponUse,
} from "./utils/coupons.js";

import {
  ensurePendingCouponsFile,
  setPendingCoupon,
  getPendingCoupon,
  clearPendingCoupon,
} from "./utils/pendingCoupons.js";

dotenv.config();
ensureDataFiles();
ensurePendingCouponsFile();

fs.mkdirSync(path.resolve("./invoices"), { recursive: true });

const STORE_NAME = process.env.STORE_NAME || "Crystal Store";
const products = JSON.parse(fs.readFileSync("./products.json", "utf8"));

/* ================== Express ================== */
const app = express();
app.use("/webhook/cryptomus", express.json({ limit: "1mb" }));
app.use("/webhook/stripe", express.raw({ type: "application/json" }));
app.use(express.static("public"));
app.get("/health", (_, res) => res.status(200).send("ok"));

app.post("/webhook/cryptomus", async (req, res) => {
  try {
    if (!isCryptomusWebhookTrusted(req, process.env)) return res.status(401).send("untrusted");

    const payload = req.body || {};
    const orderId = payload?.order_id;
    const status = String(payload?.status || "").toLowerCase();
    if (!orderId) return res.status(200).send("no order");

    const paidStatuses = new Set(["paid", "paid_over", "paid_partial"]);
    if (!paidStatuses.has(status)) return res.status(200).send("not paid");

    const order = markPaid(orderId, {
      method: "crypto",
      provider: "cryptomus",
      transactionId: payload?.uuid || payload?.txid || payload?.payment_uuid || null,
      paidAmount: payload?.amount || null,
    });

    if (order) {
      // Mark coupon usage ONCE after successful payment
      if (order?.pricing?.coupon?.code && !order?.pricing?.couponUsedMarked) {
        incrementCouponUse(order.pricing.coupon.code);
        order.pricing.couponUsedMarked = true;
        upsertOrder(order);
      }
      await notifyPaid(order);
    }

    return res.status(200).send("ok");
  } catch (e) {
    console.log("Cryptomus webhook error:", e);
    return res.status(200).send("ok");
  }
});

app.post("/webhook/stripe", async (req, res) => {
  try {
    const stripe = getStripe(process.env);
    const sig = req.headers["stripe-signature"];
    const whSecret = process.env.STRIPE_WEBHOOK_SECRET;

    let event;
    if (whSecret) {
      event = stripe.webhooks.constructEvent(req.body, sig, whSecret);
    } else {
      event = JSON.parse(req.body.toString("utf8"));
    }

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const orderId = session?.metadata?.orderId;

      if (orderId) {
        const order = markPaid(orderId, {
          method: "stripe",
          provider: "stripe",
          transactionId: session?.payment_intent || session?.id || null,
          paidAmount: session?.amount_total
            ? `$${(session.amount_total / 100).toFixed(2)}`
            : null,
        });

        if (order) {
          // Mark coupon usage ONCE after successful payment
          if (order?.pricing?.coupon?.code && !order?.pricing?.couponUsedMarked) {
            incrementCouponUse(order.pricing.coupon.code);
            order.pricing.couponUsedMarked = true;
            upsertOrder(order);
          }
          await notifyPaid(order);
        }
      }
    }

    return res.status(200).send("ok");
  } catch (e) {
    console.log("Stripe webhook error:", e);
    return res.status(200).send("ok");
  }
});

app.listen(process.env.PORT || 20180, () => console.log("Web server started"));

/* ================== Discord ================== */
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel],
});

const money = (n) => `$${Number(n).toFixed(2)}`;

/* -------- Transcript (Log channel #2) -------- */
async function buildTranscriptText(channel) {
  const lines = [];
  lines.push("Ticket Transcript");
  lines.push(`Channel: #${channel.name} (${channel.id})`);
  lines.push(`Guild: ${channel.guild?.name} (${channel.guildId})`);
  lines.push(`Closed at: ${new Date().toISOString()}`);
  lines.push("----------------------------------------");

  let beforeId = null;
  let fetched = 0;

  while (true) {
    const batch = await channel.messages.fetch({ limit: 100, before: beforeId }).catch(() => null);
    if (!batch || batch.size === 0) break;

    const msgs = Array.from(batch.values()).sort((a, b) => a.createdTimestamp - b.createdTimestamp);

    for (const m of msgs) {
      const time = new Date(m.createdTimestamp).toISOString();
      const author = `${m.author?.tag || "unknown"} (${m.author?.id || "-"})`;
      const content = (m.content || "").replace(/\n/g, "\\n");
      lines.push(`[${time}] ${author}: ${content}`);

      if (m.attachments?.size) {
        for (const a of m.attachments.values()) {
          lines.push(`  [attachment] ${a.url}`);
        }
      }

      if (m.embeds?.length) {
        lines.push(`  [embeds] ${m.embeds.length}`);
      }
    }

    fetched += batch.size;
    beforeId = msgs[0]?.id;

    // safety cap
    if (fetched >= 2000) {
      lines.push("(Transcript truncated at 2000 messages)");
      break;
    }
  }

  return lines.join("\n");
}

async function sendTranscriptToLog(channel) {
  const logId = process.env.LOG_TRANSCRIPT_CHANNEL_ID;
  if (!logId) return;

  const logCh = await client.channels.fetch(logId).catch(() => null);
  if (!logCh) return;

  const text = await buildTranscriptText(channel);
  const filename = `transcript-${channel.id}.txt`;

  await logCh
    .send({
      content: `🧾 Transcript for <#${channel.id}>`,
      files: [{ attachment: Buffer.from(text, "utf8"), name: filename }],
    })
    .catch(() => {});
}

/* -------- Embeds / UI -------- */
const panelEmbed = () =>
  new EmbedBuilder()
    .setTitle(`${STORE_NAME} — Ticket Panel`)
    .setDescription(
      [
        "Open a ticket to order or get support.",
        "",
        "✅ Fast delivery",
        "✅ Secure payments (Crypto/Stripe)",
        "✅ Invoice PDF after delivery",
      ].join("\n")
    )
    .setFooter({ text: "Click Open Ticket" });

const welcomeEmbed = (user) =>
  new EmbedBuilder()
    .setTitle("Welcome 👋")
    .setDescription(`Hello ${user}!\n\nChoose your product below. After payment you will get confirmation here.`);

const productsEmbed = () =>
  new EmbedBuilder()
    .setTitle("Products")
    .setDescription(
      products
        .map((p) => `${p.emoji} **${p.name}** — ${money(p.price)} _(ETA: ${p.delivery})_`)
        .join("\n")
    )
    .setFooter({ text: "Select one product to continue." });

const paymentMethodsEmbed = (prod, order) => {
  const total = order?.pricing?.total ?? prod.price;
  const disc =
    order?.pricing?.discount
      ? `\n**Discount:** -$${Number(order.pricing.discount).toFixed(2)} (${order.pricing.coupon?.code})`
      : "";
  return new EmbedBuilder()
    .setTitle("Choose Payment Method")
    .setDescription(`**Product:** ${prod.name}\n**Total:** ${money(total)}${disc}\n\nSelect one option:`);
};

const paymentInstructionsEmbed = (method, order) => {
  const total = order?.pricing?.total ?? order.product.price;

  const lines = [
    `**Order ID:** \`${order.id}\``,
    `**Product:** ${order.product.name}`,
    `**Total:** ${money(total)}`,
    order?.pricing?.coupon?.code ? `**Coupon:** \`${order.pricing.coupon.code}\`` : "",
    "",
  ].filter(Boolean);

  if (method === "crypto") {
    lines.push("**Crypto (Cryptomus)**");
    lines.push("1) Click **Pay Now**");
    lines.push("2) Complete payment");
    lines.push("3) Wait for confirmation here");
  } else {
    lines.push("**Stripe (Card)**");
    lines.push("1) Click **Pay Now**");
    lines.push("2) Complete checkout");
    lines.push("3) Wait for confirmation here");
  }

  return new EmbedBuilder().setTitle("Payment").setDescription(lines.join("\n"));
};

const couponRow = () =>
  new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("open_coupon")
      .setLabel("Use Coupon")
      .setEmoji("🏷️")
      .setStyle(ButtonStyle.Secondary)
  );

/* -------- Register commands -------- */
client.once(Events.ClientReady, async () => {
  console.log(`Logged in as ${client.user.tag}`);

  try {
    const guilds = await client.guilds.fetch();

    const commands = [
      {
        name: "panel",
        description: "Send ticket panel to this channel",
        default_member_permissions: String(PermissionFlagsBits.Administrator),
      },
      {
        name: "coupon",
        description: "Manage coupons",
        default_member_permissions: String(PermissionFlagsBits.Administrator),
        options: [
          {
            type: ApplicationCommandOptionType.Subcommand,
            name: "add",
            description: "Add a new coupon",
            options: [
              {
                type: ApplicationCommandOptionType.String,
                name: "code",
                description: "Coupon code",
                required: true,
              },
              {
                type: ApplicationCommandOptionType.String,
                name: "type",
                description: "fixed or percent",
                required: true,
                choices: [
                  { name: "fixed", value: "fixed" },
                  { name: "percent", value: "percent" },
                ],
              },
              {
                type: ApplicationCommandOptionType.Number,
                name: "value",
                description: "Discount value",
                required: true,
              },
              {
                type: ApplicationCommandOptionType.Integer,
                name: "maxuses",
                description: "0 = unlimited",
                required: false,
              },
            ],
          },
          {
            type: ApplicationCommandOptionType.Subcommand,
            name: "delete",
            description: "Delete a coupon",
            options: [
              {
                type: ApplicationCommandOptionType.String,
                name: "code",
                description: "Coupon code",
                required: true,
              },
            ],
          },
          {
            type: ApplicationCommandOptionType.Subcommand,
            name: "list",
            description: "List all coupons",
          },
        ],
      },
    ];

    for (const [, g] of guilds) {
      const guild = await client.guilds.fetch(g.id);
      await guild.commands.set(commands);
    }

    console.log("Commands registered.");
  } catch (e) {
    console.log("Command registration error:", e);
  }
});

/* -------- Slash command handlers -------- */
client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  if (interaction.commandName === "panel") {
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("open_ticket")
        .setLabel("Open Ticket")
        .setEmoji("🎫")
        .setStyle(ButtonStyle.Primary)
    );

    await interaction.channel.send({ embeds: [panelEmbed()], components: [row] });
    await interaction.reply({ content: "✅ Panel sent.", ephemeral: true });
    return;
  }

  if (interaction.commandName === "coupon") {
    const sub = interaction.options.getSubcommand();

    if (sub === "add") {
      try {
        const code = interaction.options.getString("code", true);
        const type = interaction.options.getString("type", true);
        const value = interaction.options.getNumber("value", true);
        const maxUses = interaction.options.getInteger("maxuses") ?? 0;

        const c = addCoupon({ code, type, value, maxUses });
        await interaction.reply({
          content: `✅ Added coupon **${c.code}** (${c.type} - ${
            c.type === "percent" ? `${c.value}%` : `$${c.value}`
          }, maxUses: ${c.maxUses || "unlimited"})`,
          ephemeral: true,
        });
      } catch (e) {
        await interaction.reply({ content: `❌ ${e.message}`, ephemeral: true });
      }
      return;
    }

    if (sub === "delete") {
      const code = interaction.options.getString("code", true);
      const ok = deleteCoupon(code);
      await interaction.reply({
        content: ok ? `✅ Deleted coupon **${code.toUpperCase()}**` : "⚠️ Coupon not found.",
        ephemeral: true,
      });
      return;
    }

    if (sub === "list") {
      const arr = listCoupons();
      if (!arr.length) {
        await interaction.reply({ content: "No coupons yet.", ephemeral: true });
        return;
      }

      const lines = arr
        .map((c) => {
          const typeText = c.type === "percent" ? `${c.value}%` : `$${c.value}`;
          const usesText = Number(c.maxUses || 0) > 0 ? `${c.uses}/${c.maxUses}` : `${c.uses}/∞`;
          return `• **${c.code}** — ${c.type} (${typeText}) — uses: ${usesText} — ${
            c.active === false ? "inactive" : "active"
          }`;
        })
        .join("\n");

      const embed = new EmbedBuilder().setTitle("Coupons").setDescription(lines);
      await interaction.reply({ embeds: [embed], ephemeral: true });
      return;
    }
  }
});

/* -------- Button handlers -------- */
client.on(Events.InteractionCreate, async (i) => {
  if (!i.isButton()) return;

  try {
    if (i.customId === "open_ticket") {
      const existing = i.guild.channels.cache.find(
        (c) => c.type === ChannelType.GuildText && c.name === `ticket-${i.user.id}`
      );
      if (existing) {
        return i.reply({
          content: `⚠️ You already have a ticket: <#${existing.id}>`,
          ephemeral: true,
        });
      }

      const overwrites = [
        { id: i.guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
        {
          id: i.user.id,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory,
          ],
        },
      ];

      if (process.env.SUPPORT_ROLE_ID) {
        overwrites.push({
          id: process.env.SUPPORT_ROLE_ID,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory,
          ],
        });
      }

      if (process.env.OWNER_ID) {
        overwrites.push({
          id: process.env.OWNER_ID,
          allow: [
            PermissionFlagsBits.ViewChannel,
            PermissionFlagsBits.SendMessages,
            PermissionFlagsBits.ReadMessageHistory,
            PermissionFlagsBits.ManageChannels,
          ],
        });
      }

      const ticket = await i.guild.channels.create({
        name: `ticket-${i.user.id}`,
        type: ChannelType.GuildText,
        parent: process.env.TICKET_CATEGORY_ID || null,
        permissionOverwrites: overwrites,
      });

      // 1) Welcome
      await ticket.send({ embeds: [welcomeEmbed(i.user)] });

      // 2) Products buttons
      const rows = [];
      let row = new ActionRowBuilder();
      let count = 0;

      for (const p of products) {
        if (count === 5) {
          rows.push(row);
          row = new ActionRowBuilder();
          count = 0;
        }
        row.addComponents(
          new ButtonBuilder()
            .setCustomId(`choose_prod:${p.id}`)
            .setLabel(`${p.name} (${money(p.price)})`)
            .setEmoji(p.emoji)
            .setStyle(ButtonStyle.Secondary)
        );
        count++;
      }
      if (count) rows.push(row);

      await ticket.send({ embeds: [productsEmbed()], components: rows });

      // 3) ✅ Coupon message ONCE only (after welcome + products)
      await ticket.send({ content: "Have a discount code? Apply it here:", components: [couponRow()] });

      await i.reply({ content: `✅ Ticket created: <#${ticket.id}>`, ephemeral: true });
      return;
    }

    if (i.customId === "open_coupon") {
      const modal = new ModalBuilder().setCustomId("coupon_modal").setTitle("Apply Coupon");
      const codeInput = new TextInputBuilder()
        .setCustomId("coupon_code")
        .setLabel("Coupon code")
        .setStyle(TextInputStyle.Short)
        .setRequired(true);

      modal.addComponents(new ActionRowBuilder().addComponents(codeInput));
      await i.showModal(modal);
      return;
    }

    if (i.customId.startsWith("choose_prod:")) {
      const prodId = i.customId.split(":")[1];
      const prod = products.find((p) => p.id === prodId);
      if (!prod) return i.reply({ content: "❌ Product not found.", ephemeral: true });

      const orderId = uuid();

      const order = {
        id: orderId,
        status: "pending",
        createdAt: new Date().toISOString(),
        guildId: i.guildId,
        channelId: i.channelId,
        userId: i.user.id,
        userTag: i.user.tag,
        product: { id: prod.id, name: prod.name, price: prod.price },
        payment: { method: null, provider: null, url: null, transactionId: null, paidAmount: null },
        pricing: { original: prod.price, discount: 0, total: prod.price, coupon: null, couponUsedMarked: false },
      };

      // ✅ Apply coupon to the NEXT product (pending per ticket)
      const pending = getPendingCoupon(i.channelId);
      if (pending?.code) {
        const coupon = findCoupon(pending.code);
        if (coupon) {
          const r = applyCouponToAmount(Number(prod.price), coupon);
          order.pricing = {
            original: Number(prod.price),
            discount: r.discount,
            total: r.total,
            coupon: {
              code: coupon.code,
              type: coupon.type,
              value: coupon.value,
              maxUses: coupon.maxUses,
              uses: coupon.uses,
            },
            couponUsedMarked: false,
          };
          clearPendingCoupon(i.channelId); // apply once to the next chosen product
          await i.channel.send(
            `🏷️ Coupon **${coupon.code}** applied to this order. New total: **$${r.total.toFixed(2)}**`
          );
        } else {
          clearPendingCoupon(i.channelId);
        }
      }

      upsertOrder(order);

      const payRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
          .setCustomId(`pay_crypto:${orderId}`)
          .setLabel("Crypto")
          .setEmoji("🪙")
          .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
          .setCustomId(`pay_stripe:${orderId}`)
          .setLabel("Stripe")
          .setEmoji("💳")
          .setStyle(ButtonStyle.Primary)
      );

      await i.channel.send({ embeds: [paymentMethodsEmbed(prod, order)], components: [payRow] });
      await i.reply({ content: "✅ Choose payment method below.", ephemeral: true });
      return;
    }

    if (i.customId.startsWith("pay_crypto:")) {
      const orderId = i.customId.split(":")[1];
      const order = getOrderById(orderId);
      if (!order) return i.reply({ content: "❌ Order not found.", ephemeral: true });
      if (order.status === "paid") return i.reply({ content: "✅ Already paid.", ephemeral: true });

      const amountUsd = order.pricing?.total ?? order.product.price;

      const cb = (process.env.PUBLIC_BASE_URL || "").replace(/\/$/, "") + "/webhook/cryptomus";
      const inv = await createCryptomusInvoice({
        amountUsd,
        orderId: order.id,
        description: `${STORE_NAME} | ${order.product.name}`,
        successUrl: process.env.PUBLIC_BASE_URL || undefined,
        callbackUrl: cb.includes("http") ? cb : undefined,
        env: process.env,
      });

      upsertOrder({
        ...order,
        payment: {
          ...order.payment,
          method: "crypto",
          provider: "cryptomus",
          url: inv.url,
          transactionId: inv.uuid,
        },
      });

      const linkRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setLabel("Pay Now").setStyle(ButtonStyle.Link).setURL(inv.url)
      );

      await i.channel.send({ embeds: [paymentInstructionsEmbed("crypto", order)], components: [linkRow] });
      await i.reply({ content: "✅ Payment link sent.", ephemeral: true });
      return;
    }

    if (i.customId.startsWith("pay_stripe:")) {
      const orderId = i.customId.split(":")[1];
      const order = getOrderById(orderId);
      if (!order) return i.reply({ content: "❌ Order not found.", ephemeral: true });
      if (order.status === "paid") return i.reply({ content: "✅ Already paid.", ephemeral: true });

      const amountUsd = order.pricing?.total ?? order.product.price;
      const base = process.env.PUBLIC_BASE_URL || "https://example.com";

      const successUrl = base.replace(/\/$/, "") + `/success?order=${order.id}`;
      const cancelUrl = base.replace(/\/$/, "") + `/cancel?order=${order.id}`;

      const session = await createStripeCheckout({
        env: process.env,
        amountUsd,
        orderId: order.id,
        productName: `${STORE_NAME} - ${order.product.name}`,
        successUrl,
        cancelUrl,
      });

      upsertOrder({
        ...order,
        payment: {
          ...order.payment,
          method: "stripe",
          provider: "stripe",
          url: session.url,
          transactionId: session.id,
        },
      });

      const linkRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setLabel("Pay Now").setStyle(ButtonStyle.Link).setURL(session.url)
      );

      await i.channel.send({ embeds: [paymentInstructionsEmbed("stripe", order)], components: [linkRow] });
      await i.reply({ content: "✅ Checkout link sent.", ephemeral: true });
      return;
    }
  } catch (e) {
    console.log("Button error:", e);
    try {
      await i.reply({ content: `❌ Error: ${e.message}`, ephemeral: true });
    } catch {}
  }
});

/* -------- Coupon modal submit (SAVES for next product) -------- */
client.on(Events.InteractionCreate, async (i) => {
  if (!i.isModalSubmit()) return;
  if (i.customId !== "coupon_modal") return;

  const code = i.fields.getTextInputValue("coupon_code")?.trim();
  const coupon = findCoupon(code);

  if (!coupon) {
    await i.reply({ content: "❌ Invalid / expired coupon code.", ephemeral: true });
    return;
  }

  // ✅ Save for NEXT chosen product in this ticket
  setPendingCoupon(i.channelId, {
    code: coupon.code,
    type: coupon.type,
    value: coupon.value,
    maxUses: coupon.maxUses ?? 0,
  });

  await i.reply({
    content: `✅ Coupon saved for your next product: **${coupon.code}**\nNow select a product and it will be applied automatically.`,
    ephemeral: true,
  });

  await i.channel.send(`🏷️ Coupon **${coupon.code}** saved. It will be applied to the next selected product.`);
});

/* -------- Paid notification -------- */
async function notifyPaid(order) {
  try {
    const ch = await client.channels.fetch(order.channelId).catch(() => null);
    if (!ch) return;

    const total = order.pricing?.total ?? order.product.price;

    const embed = new EmbedBuilder()
      .setTitle("✅ Payment Received")
      .setDescription(
        [
          `**Order ID:** \`${order.id}\``,
          `**Product:** ${order.product.name}`,
          `**Amount:** ${money(total)}`,
          order?.pricing?.coupon?.code ? `**Coupon:** \`${order.pricing.coupon.code}\`` : "",
          `**Method:** ${order.payment.method}`,
          "",
          "Owner can deliver and close with `+dn`.",
          "Or close silently with `+close`.",
        ]
          .filter(Boolean)
          .join("\n")
      );

    await ch.send({
      embeds: [embed],
      content: process.env.OWNER_ID ? `<@${process.env.OWNER_ID}>` : undefined,
    });
  } catch (e) {
    console.log("notifyPaid error:", e);
  }
}

/* -------- +dn / +close -------- */
client.on(Events.MessageCreate, async (m) => {
  if (!m.guild) return;
  if (!m.channel?.name?.startsWith("ticket-")) return;

  const cmd = m.content?.trim();
  if (cmd !== "+dn" && cmd !== "+close") return;

  const isOwner = process.env.OWNER_ID && m.author.id === process.env.OWNER_ID;
  const hasManage = m.member?.permissions?.has(PermissionFlagsBits.ManageChannels);
  if (!isOwner && !hasManage) return;

  const order = getOrderByChannelId(m.channel.id);

  // ✅ +close: close silently (NO invoice, NO order summary log, NO DM invoice)
  if (cmd === "+close") {
    await m.channel.send("✅ Ticket will close in **10 seconds**…");
    await sendTranscriptToLog(m.channel);
    setTimeout(() => m.channel.delete().catch(() => {}), 10_000);
    return;
  }

  // +dn: keep your original safety (double +dn to force close if not paid)
  if (order && order.status !== "paid") {
    const forceKey = `_force_${m.channel.id}`;
    globalThis[forceKey] = (globalThis[forceKey] || 0) + 1;
    if (globalThis[forceKey] < 2) {
      await m.channel.send("⚠️ Order not marked paid. Type `+dn` مرة ثانية للإغلاق الإجباري.");
      return;
    }
  }

  await m.channel.send("✅ Ticket will close in **10 seconds**…");

  if (order) {
    const invoiceId = `INV-${order.id.slice(0, 8).toUpperCase()}`;
    const pdfPath = path.resolve(`./invoices/${invoiceId}.pdf`);

    const total = order.pricing?.total ?? order.product.price;

    await createInvoicePDF(
      {
        storeName: STORE_NAME,
        orderId: order.id,
        invoiceId,
        buyerTag: order.userTag,
        buyerId: order.userId,
        productName: order.product.name,
        amountUsd: total,
        paymentMethod: order.payment.method || "-",
        paymentAmount: order.payment.paidAmount || money(total),
        transactionId: order.payment.transactionId || "-",
        createdAt: new Date().toISOString(),
      },
      pdfPath
    );

    const user = await client.users.fetch(order.userId).catch(() => null);
    if (user) {
      await user
        .send({
          content: `🧾 Your invoice from **${STORE_NAME}** (Order: \`${order.id}\`). Thank you!`,
          files: [pdfPath],
        })
        .catch(() => {});
    }

    // ✅ Existing order summary log (LOG_CHANNEL_ID)
    if (process.env.LOG_CHANNEL_ID) {
      const logCh = await client.channels.fetch(process.env.LOG_CHANNEL_ID).catch(() => null);
      if (logCh) {
        const logEmbed = new EmbedBuilder()
          .setTitle("🧾 New Completed Order")
          .setDescription(
            [
              `**Buyer:** <@${order.userId}> (${order.userTag})`,
              `**Order ID:** \`${order.id}\``,
              `**Product:** ${order.product.name}`,
              order?.pricing?.coupon?.code ? `**Coupon:** \`${order.pricing.coupon.code}\`` : "",
              `**Payment:** ${order.payment.method}`,
              `**Amount:** ${money(total)}`,
            ]
              .filter(Boolean)
              .join("\n")
          );
        await logCh.send({ embeds: [logEmbed] });
      }
    }
  }

  // ✅ Always send transcript to second log channel
  await sendTranscriptToLog(m.channel);

  setTimeout(() => m.channel.delete().catch(() => {}), 10_000);
});

process.on("unhandledRejection", (err) => console.log(err));
process.on("uncaughtException", (err) => console.log(err));

client.login(process.env.DISCORD_TOKEN);
