// Crystal Store — site scripts (NO bot logic here)

// 1) Copy product id buttons
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-copy]");
  if (!b) return;
  const id = b.getAttribute("data-copy");
  if (!id) return;
  navigator.clipboard
    .writeText(id)
    .then(() => {
      const old = b.textContent;
      b.textContent = "Copied ✓";
      setTimeout(() => (b.textContent = old || "Copy ID"), 1200);
    })
    .catch(() => {
      // ignore
    });
});

// 2) Stripe Payment Links mode (static hosting friendly)
// Put your links in public/config.js as:
// window.STRIPE_PAYMENT_LINKS = { p1: "https://buy.stripe.com/...", ... }

function getStripeLink(productId) {
  const links = window.STRIPE_PAYMENT_LINKS || {};
  return links[productId] || "";
}

document.addEventListener("click", (e) => {
  const a = e.target.closest("a[data-stripe-buy]");
  if (!a) return;

  const productId = a.getAttribute("data-stripe-buy");
  const link = getStripeLink(productId);
  if (!link) {
    e.preventDefault();
    alert(
      "Stripe link not configured yet.\n\nOpen public/config.js and put your Stripe Payment Link for this product."
    );
    return;
  }

  // Go to Stripe hosted checkout
  a.setAttribute("href", link);
});

// 3) Pay buttons (data-checkout="p1") — redirects to Stripe Payment Link
document.addEventListener("click", (e) => {
  const el = e.target.closest("[data-checkout]");
  if (!el) return;

  const productId = el.getAttribute("data-checkout");
  const link = getStripeLink(productId);

  if (!link) {
    alert("Stripe link not configured for: " + productId);
    return;
  }

  // For <a>, allow normal navigation; for <button>, redirect
  if (el.tagName && el.tagName.toLowerCase() === "a") {
    el.setAttribute("href", link);
    return;
  }

  window.location.href = link;
});
