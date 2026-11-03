# Mod Ideas

A public wall where players post ideas for the mod and vote on them. No accounts, dark theme, runs free on Cloudflare.

- Post an idea with a category, a title, a full description and an optional Minecraft name
- Every idea has its own page (/i/<id>) with the full text and comments
- Vote + or − (click again to undo). One vote per idea per browser
- Sort by Hot, Top or New. Filter by category. Search
- Share the link to any idea page
- Admin can mark ideas as planned / added / rejected, and delete ideas or comments

## How it works

- `public/` is the page (HTML, CSS, JS)
- `src/worker.js` is the API, running on Cloudflare Workers
- Ideas and votes are stored in Cloudflare D1 (SQLite). Schema in `migrations/`

## Run locally

Requires Node 18+.

```
npm install
npm run dev
```

## Deploy

```
npx wrangler login
npm run deploy
```

First time only: create the database and put its id in `wrangler.jsonc`:

```
npx wrangler d1 create mod-ideas
```

## Settings

- Site name: `SITE_NAME` in `wrangler.jsonc`
- Categories: top of `src/worker.js`

## Admin

Set a secret token once:

```
npx wrangler secret put ADMIN_TOKEN
```

Then open `https://your-site/?admin=YOUR_TOKEN` once. The browser remembers it and shows a status menu and delete buttons on idea pages.

## Backup

```
npx wrangler d1 export mod-ideas --remote --output backup.sql
```

## Limits

- 5 new ideas per 10 minutes, 10 comments per 5 minutes, 120 votes per minute (per IP)
- Titles up to 80 characters, descriptions up to 5000, comments up to 2000
- Duplicate titles are rejected
- Votes are tied to a browser cookie, so clearing cookies lets someone vote again. Fine for a community wall, not for anything with stakes
