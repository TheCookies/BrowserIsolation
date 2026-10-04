# HTML documentation site

Self-contained reading UI for the project docs (sidebar navigation, search filter, product styling).

## Open it

- Double-click / open [`index.html`](index.html) in a browser, or
- From the repo root:

```bash
npm run docs:serve
```

Then visit http://localhost:4173

## Regenerate

Markdown in `docs/`, the root `README.md`, `CONTRIBUTING.md`, and package READMEs are the source of truth.

```bash
npm run docs
```

That runs `scripts/build-docs-site.mjs` and rewrites `index.html` (CSS is inlined from `styles.css`).
