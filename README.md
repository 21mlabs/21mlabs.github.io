# 21mlabs.com

A deliberately spare, one-page static site, built with
[Eleventy](https://www.11ty.dev/): the wordmark, a single cryptic line, the
contact email, and one faint live signal — the current Bitcoin block height +
hash tail, quietly ticking toward 21,000,000. Monospace, dark, no explanation.
Plain HTML/CSS/JS output, deployed to GitHub Pages.

No trackers, no analytics, no cookies. The only network call at runtime is a
read of the current block from [mempool.space](https://mempool.space)
(falling back to [blockstream.info](https://blockstream.info)).

## Develop

```sh
npm install
npm run dev      # serves at http://localhost:8080 with live reload
npm run build    # one-shot build to ./_site
```

## Edit

| What                 | Where                          |
| -------------------- | ------------------------------ |
| Wordmark / layout    | `src/index.njk`                |
| Tagline / email / meta | `src/_data/site.js`          |
| Live block signal    | `src/assets/js/chaintip.js`    |
| Styles               | `src/assets/css/main.css`      |
| Page shell / meta    | `src/_includes/*.njk`          |

## Deploy

Push to `master`. The GitHub Actions workflow (`.github/workflows/gh-pages.yml`)
builds and publishes `./_site` to the `gh-pages` branch; GitHub serves it at
<https://21mlabs.com> (`src/CNAME`).
