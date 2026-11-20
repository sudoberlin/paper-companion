# Paper Companion

Read a research paper section by section with Claude beside you. Paste an arXiv link (or an OpenReview page, a PDF link, or upload a PDF) and it

- splits the paper into its real sections, using the headings in arXiv's HTML version when there is one,
- writes a one-screen overview and a list of concepts to know first,
- explains each section in plain words, with key terms and two self-check questions,
- gives every section its own chat that has read that section's text, and a chat for the whole paper,
- keeps your papers and chats in a library that follows you to any computer.

Live at https://sudoberlin.github.io/paper-companion/ (passcode protected).

## How it works

```
Browser (GitHub Pages)  ──►  Cloudflare Worker  ──►  Anthropic API (Claude)
  index.html                  checks passcode         
  pdf.js, Markdown, MathML    fetches paper links  ──►  arxiv.org, openreview.net, ...
                              stores library       ──►  Workers KV
```

The page is static HTML with no build step. Everything private lives in the Worker. The Anthropic API key never reaches the browser, every request needs the passcode, and the Worker fixes the model and caps response length so the page can't be used to run up costs.

Cost control

- Chat turns mark the paper text for prompt caching, so follow-up questions on the same section reread it at a much lower price.
- Responses are capped at 4,096 tokens.
- Set a monthly spend limit on your Anthropic account as well. It is the only hard ceiling.

## Setup (about 20 minutes, once)

You need Node.js 18 or newer, an Anthropic API account with billing set up, and a free Cloudflare account.

**1. Create an Anthropic API key.** In the Anthropic Console (console.anthropic.com) create an API key, and set a monthly spend limit in the billing settings. Keep the key out of chats, emails and commits.

**2. Install and log in to Cloudflare.**

```bash
git clone https://github.com/sudoberlin/paper-companion
cd paper-companion/worker
npm install
npx wrangler login
```

**3. Create the library storage.**

```bash
npx wrangler kv namespace create LIBRARY
```

Copy the `id` it prints into `worker/wrangler.toml`, replacing `REPLACE_WITH_YOUR_KV_NAMESPACE_ID`.

**4. Add the two secrets.** Each command asks you to paste the value.

```bash
npx wrangler secret put ANTHROPIC_API_KEY
openssl rand -base64 18        # prints a strong passcode, save it in your password manager
npx wrangler secret put PASSCODE
```

**5. Deploy.**

```bash
npx wrangler deploy
```

It prints the Worker's address, something like `https://paper-companion.<your-subdomain>.workers.dev`.

**6. Point the page at the Worker.** Put that address in `config.js`, then commit and push.

```js
window.PC_CONFIG = { workerUrl: "https://paper-companion.<your-subdomain>.workers.dev" };
```

**7. Turn on GitHub Pages.** In this repository go to Settings, then Pages, choose "Deploy from a branch", branch `main`, folder `/ (root)`. The site appears at https://sudoberlin.github.io/paper-companion/ within a couple of minutes.

## Using it on someone else's computer

Open the page, enter the passcode and leave "Remember on this computer" unchecked. When you're done press **Lock**, which removes the passcode from that browser. Your papers stay in your library on the Worker, not on that computer.

## Changing things

- Model: edit `MODEL` in `worker/wrangler.toml` and run `npx wrangler deploy`.
- Passcode: run `npx wrangler secret put PASSCODE` again. Every browser has to unlock again.
- Another site calling the Worker: add its address to `ALLOWED_ORIGINS` in `worker/wrangler.toml`.

## Local development

```bash
cd worker
printf 'PASSCODE=dev\nANTHROPIC_API_KEY=sk-ant-...\n' > .dev.vars   # ignored by git
npx wrangler dev                                                  # Worker on http://localhost:8787
# in another terminal, from the repo root
python3 -m http.server 8000
```

Set `workerUrl` in `config.js` to `http://localhost:8787` while testing (localhost is always allowed by the Worker's CORS check), and open http://localhost:8000.

## Limits

- Scanned PDFs have no text layer, so paste the text instead.
- Paywalled papers (IEEE, ACM) can't be fetched by link. Download the PDF and upload it.
- Workers KV's free tier allows 1,000 writes a day. Each saved change to a paper is one write, which is plenty for one person.
