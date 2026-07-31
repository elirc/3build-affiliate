# Reporting conversions (for brands)

How your storefront tells us a sale happened, so the right affiliate gets paid.

---

## The short version

When a customer completes an order, your **server** sends us a signed HTTP
request. Not your storefront JavaScript — a browser can be tampered with, and
anything a browser can send, anyone can forge.

```http
POST https://api.example.com/api/conversions/<campaignId>
Content-Type: application/json
X-Affiliate-Key: ak_9f3c...
X-Affiliate-Timestamp: 1800000000000
X-Affiliate-Signature: 7b2f...

{"externalOrderId":"order-1042","conversionValue":149.99,"attributionCookieId":"..."}
```

## Getting credentials

Campaign → **Developers** tab → **Create key**.

The secret is shown **once**. We store it encrypted and there is no endpoint
that will show it to you again — if a stolen dashboard session could read your
signing secrets, the signatures would not be worth much. Lost it? Create a new
key and revoke the old one.

Keys are scoped to a single campaign. If you run three programmes, use three
keys, so a leak from one integration cannot report sales against the others.

## Signing a request

```text
signature = HMAC_SHA256(secret, timestamp + "." + rawRequestBody)
```

`rawRequestBody` is the exact bytes you send. Serialise your JSON **once**,
sign that string, and send that same string. If you sign an object and let your
HTTP library serialise it separately, key order or whitespace may differ and
the signature will not match.

### Node.js

```js
import crypto from 'node:crypto';

const body = JSON.stringify({
  externalOrderId: order.id,
  conversionValue: order.total,
  attributionCookieId: order.affiliateRef, // the `_ref` value you captured
  customerEmail: order.email,              // optional, hashed on our side
  isFirstTimeCustomer: order.isNewCustomer,
});

const timestamp = String(Date.now());
const signature = crypto
  .createHmac('sha256', process.env.AFFILIATE_SECRET)
  .update(`${timestamp}.${body}`)
  .digest('hex');

await fetch(`https://api.example.com/api/conversions/${CAMPAIGN_ID}`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-affiliate-key': process.env.AFFILIATE_KEY_ID,
    'x-affiliate-timestamp': timestamp,
    'x-affiliate-signature': signature,
  },
  body,
});
```

### Python

```python
import hmac, hashlib, json, time, requests

body = json.dumps({
    "externalOrderId": order.id,
    "conversionValue": float(order.total),
    "attributionCookieId": order.affiliate_ref,
}, separators=(",", ":"))          # serialise once, sign exactly this

timestamp = str(int(time.time() * 1000))
signature = hmac.new(
    SECRET.encode(), f"{timestamp}.{body}".encode(), hashlib.sha256
).hexdigest()

requests.post(
    f"https://api.example.com/api/conversions/{CAMPAIGN_ID}",
    data=body,
    headers={
        "content-type": "application/json",
        "x-affiliate-key": KEY_ID,
        "x-affiliate-timestamp": timestamp,
        "x-affiliate-signature": signature,
    },
)
```

## Where `attributionCookieId` comes from

When a shopper clicks an affiliate link, we redirect them to your landing page
with a `_ref` query parameter:

```text
https://yourbrand.com/pricing?_ref=6f1c9d2e-...
```

Store that value in your own session or cart at first touch and send it back
with the order. Without it we have no way to connect the sale to a click, and
the request is rejected with `422 No attributable clicks found`.

## Timestamps and replays

`X-Affiliate-Timestamp` is milliseconds since the epoch and must be within
**5 minutes** of our clock, in either direction. It is part of the signed
payload, so you cannot refresh it without re-signing.

If you retry a failed request, generate a **new** timestamp and signature.
Retrying with the original headers works only inside the 5-minute window.

Make sure your servers run NTP. A drifting clock produces intermittent 401s
that look like a signing bug.

## Responses

| Status | Meaning | What to do |
| --- | --- | --- |
| `201` | Recorded. Body lists the conversions and commissions created. | Nothing. |
| `401` | Signature, key, or timestamp rejected. | Check the checklist below. Do not retry unchanged. |
| `409` | This `externalOrderId` was already reported for this campaign. | Nothing — you are safe to retry, this is the idempotency guard working. |
| `422` | No attributable clicks in the window. | Expected for organic orders. Log and move on. |
| `429` | Rate limited. | Wait `Retry-After` seconds and retry. See below. |

**A `401` is deliberately vague.** It never says whether the campaign, the key,
or the signature was the problem, because that would let anyone enumerate
campaign ids. When debugging, work through the checklist rather than reading
the message.

### 401 checklist

1. Are you signing the **raw body string** you actually send, not a
   re-serialised object?
2. Is the payload `timestamp + "." + body`, with a literal dot?
3. Is the signature lowercase hex?
4. Is the timestamp in **milliseconds**, not seconds?
5. Is the key revoked? Check the Developers tab.
6. Is the key for **this** campaign?
7. Is your server clock accurate?

## Rate limits

The budget is **per API key**, not per IP address. Your limit is yours: another
brand's traffic cannot spend it, and you cannot spend theirs. Sharing an egress
IP with anyone else — a NAT, a serverless platform — makes no difference.

- **100 requests per minute**, sustained.
- **Bursts of up to 200** are fine. The allowance refills continuously at the
  sustained rate rather than resetting on a clock boundary, so there is no
  benefit to waiting for the top of the minute.

Every response carries the state of your budget:

| Header | Meaning |
| --- | --- |
| `X-RateLimit-Limit` | The burst size: the most you can send at once from a full allowance. |
| `X-RateLimit-Remaining` | Requests you can send right now. |
| `X-RateLimit-Reset` | Seconds until the allowance is completely full again. |
| `Retry-After` | On a `429` only: seconds until the next request will be accepted. |

Honour `Retry-After`. Retrying sooner cannot succeed, and a client that
ignores it spends its refill on rejections.

If you need a higher limit for a migration or a launch, ask before the event
rather than during it.

## Idempotency

`externalOrderId` is unique per campaign. Reporting the same order twice
returns `409` and creates nothing, so a webhook that retries on timeout cannot
double-pay an affiliate. Use your real order id, not a random value.

## Testing

Report against a campaign in `DRAFT` or use a test campaign — conversions on a
live campaign create real commissions that a human then has to reverse.
