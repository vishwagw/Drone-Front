// Stripe Checkout for the one-time purchase, over Stripe's REST API (no SDK).
import crypto from 'node:crypto';

export class Payments {
  constructor({ secretKey, webhookSecret, publicUrl, priceCents = 500, currency = 'usd', automaticTax = false, apiBase = 'https://api.stripe.com' }) {
    Object.assign(this, { secretKey, webhookSecret, publicUrl: publicUrl?.replace(/\/$/, ''), priceCents, currency, automaticTax, apiBase });
  }
  get enabled() { return !!(this.secretKey && this.webhookSecret && this.publicUrl); }
  get priceLabel() { return `$${(this.priceCents / 100).toFixed(2).replace(/\.00$/, '')}`; }

  // Returns the Stripe-hosted checkout page URL for this account.
  async checkout(account) {
    const body = new URLSearchParams({
      mode: 'payment',
      'line_items[0][quantity]': '1',
      'line_items[0][price_data][currency]': this.currency,
      'line_items[0][price_data][unit_amount]': String(this.priceCents),
      'line_items[0][price_data][product_data][name]': 'Drone Front: full game',
      'line_items[0][price_data][product_data][description]': 'All 7 campaign sorties and the online world',
      success_url: `${this.publicUrl}/?purchase=success`,
      cancel_url: `${this.publicUrl}/?purchase=cancelled`,
      client_reference_id: String(account.id),
      customer_email: account.email,
      'metadata[account]': String(account.id),
      'payment_intent_data[metadata][account]': String(account.id),
    });
    if (this.automaticTax) body.set('automatic_tax[enabled]', 'true');
    const res = await fetch(`${this.apiBase}/v1/checkout/sessions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.secretKey}`, 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.url) throw new Error(json.error?.message || `Stripe answered ${res.status}`);
    return json.url;
  }

  // Checks the Stripe-Signature header and returns the parsed event, or null.
  verify(rawBody, header, toleranceSec = 300) {
    if (!this.webhookSecret || typeof header !== 'string') return null;
    let t = null; const sigs = [];
    for (const kv of header.split(',')) {
      const [k, v] = kv.split('=');
      if (k === 't') t = Number(v); else if (k === 'v1' && v) sigs.push(v);
    }
    if (!Number.isFinite(t) || !sigs.length || Math.abs(Date.now() / 1000 - t) > toleranceSec) return null;
    const want = crypto.createHmac('sha256', this.webhookSecret).update(`${t}.${rawBody}`).digest();
    const ok = sigs.some((s) => { const got = Buffer.from(s, 'hex'); return got.length === want.length && crypto.timingSafeEqual(got, want); });
    if (!ok) return null;
    try { return JSON.parse(rawBody); } catch { return null; }
  }

  sign(rawBody, t = Math.floor(Date.now() / 1000)) {   // used by tests and local tools
    return `t=${t},v1=${crypto.createHmac('sha256', this.webhookSecret).update(`${t}.${rawBody}`).digest('hex')}`;
  }
}
