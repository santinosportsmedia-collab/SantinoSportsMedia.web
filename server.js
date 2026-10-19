const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });
const Stripe = require("stripe");

for (const name of ["STRIPE_SECRET_KEY", "STRIPE_PUBLISHABLE_KEY"]) {
  if (!process.env[name] || process.env[name].endsWith("...")) {
    console.warn(`Warning: ${name} is missing or still a placeholder in .env`);
  }
}

// Limits for custom amounts that customers type in (in US dollars). Change these as you like.
const CUSTOM_MIN = 5;
const CUSTOM_MAX = 5000;

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2026-03-25.dahlia",
});

const express = require("express");
const app = express();

// Only the public/ folder is served, so server.js and .env are never exposed.
app.use(express.static(path.join(__dirname, "public"), { index: "indeximproved.html" }));
app.use(express.json());

// A price can be sold here only if it is the default price of an active product,
// a one-time price in US dollars with a fixed amount.
function isSellablePrice(price, product) {
  return Boolean(
    price &&
      price.active &&
      price.type === "one_time" &&
      price.currency === "usd" &&
      Number.isInteger(price.unit_amount) &&
      price.unit_amount > 0 &&
      product &&
      !product.deleted &&
      product.active &&
      product.default_price === price.id
  );
}

// The dropdown items come straight from your Stripe products (cached for 30 seconds).
let itemsCache = { at: 0, items: [] };
async function loadItems() {
  if (Date.now() - itemsCache.at < 30 * 1000) return itemsCache.items;
  try {
    const products = await stripe.products.list({
      active: true,
      limit: 100,
      expand: ["data.default_price"],
    });
    const items = products.data
      .filter((p) => p.default_price && typeof p.default_price === "object")
      .filter((p) => isSellablePrice(p.default_price, { ...p, default_price: p.default_price.id }))
      .map((p) => ({ id: p.default_price.id, name: p.name, amount: p.default_price.unit_amount / 100 }))
      .sort((a, b) => a.name.localeCompare(b.name));
    itemsCache = { at: Date.now(), items };
    return items;
  } catch (err) {
    console.error("Could not load products from Stripe:", err.message);
    return itemsCache.items;
  }
}

// Re-checks a chosen price with Stripe, so the browser can never pick something that is not for sale.
async function findSellablePrice(priceId) {
  if (typeof priceId !== "string" || !priceId.startsWith("price_")) return null;
  try {
    const price = await stripe.prices.retrieve(priceId, { expand: ["product"] });
    const product = price.product;
    if (!product || typeof product !== "object") return null;
    return isSellablePrice(price, product) ? { priceId: price.id, name: product.name } : null;
  } catch (err) {
    console.error("Could not check price:", err.message);
    return null;
  }
}

// The publishable key is safe to send to the browser.
app.get("/api/config", (req, res) => {
  res.json({ publishableKey: process.env.STRIPE_PUBLISHABLE_KEY });
});

// The items shown in the dropdown.
app.get("/api/items", async (req, res) => {
  res.json({
    items: await loadItems(),
    customMin: CUSTOM_MIN,
    customMax: CUSTOM_MAX,
  });
});

app.post("/api/create-checkout-session", async (req, res) => {
  const { itemId, amount, note } = req.body || {};
  let lineItem;
  const metadata = {};

  if (itemId === "custom") {
    // Custom amount typed by the customer: validated here, never trusted from the browser.
    const dollars = Number(amount);
    if (!Number.isFinite(dollars) || dollars < CUSTOM_MIN || dollars > CUSTOM_MAX) {
      return res.status(400).json({ error: `Please enter an amount between $${CUSTOM_MIN} and $${CUSTOM_MAX}.` });
    }
    lineItem = {
      price_data: {
        currency: "usd",
        unit_amount: Math.round(dollars * 100),
        tax_behavior: "exclusive", // tax is added on top of the price
        product_data: { name: "Custom shoot" },
      },
      quantity: 1,
    };
    metadata.item_id = "custom";
    const cleanNote = String(note || "").trim().slice(0, 200);
    if (cleanNote) metadata.note = cleanNote;
  } else {
    // Fixed items use the real price stored in Stripe, after re-checking it with Stripe.
    const item = await findSellablePrice(itemId);
    if (!item) return res.status(400).json({ error: "Please choose what you are paying for." });
    lineItem = { price: item.priceId, quantity: 1 };
    metadata.item_id = item.priceId;
    metadata.item_name = item.name.slice(0, 200);
  }

  try {
    // Where the customer lands after paying. Set DOMAIN in .env once the site is hosted.
    const origin = process.env.DOMAIN || `${req.protocol}://${req.get("host")}`;
    const session = await stripe.checkout.sessions.create({
      ui_mode: "form",
      mode: "payment", // placeholder: see STRIPE_INTEGRATION_TODO.md
      line_items: [lineItem],
      metadata,
      billing_address_collection: "auto",
      phone_number_collection: { enabled: false },
      automatic_tax: { enabled: true },
      submit_type: "auto",
      name_collection: { individual: { enabled: true, optional: true } },
      integration_identifier: "custom_embedded_web_0001",
      return_url: `${origin}/?session_id={CHECKOUT_SESSION_ID}`,
    });
    res.json({ client_secret: session.client_secret });
  } catch (err) {
    console.error("Checkout session error:", err.message);
    res.status(500).json({ error: "Could not start checkout." });
  }
});

// The page asks Stripe (through this server) whether a session was really paid.
app.get("/api/session-status", async (req, res) => {
  const id = req.query.session_id;
  if (typeof id !== "string" || !id.startsWith("cs_")) {
    return res.status(400).json({ error: "Invalid session." });
  }
  try {
    const session = await stripe.checkout.sessions.retrieve(id);
    res.json({ status: session.status, payment_status: session.payment_status });
  } catch (err) {
    console.error("Session status error:", err.message);
    res.status(500).json({ error: "Could not check payment." });
  }
});

app.listen(4242, () => console.log("Server running on http://localhost:4242"));
