# Deployment

The site deploys to Cloudflare on every push to `main`. Cloudflare pulls the
repository, runs the build, and uploads the contents of `dist/`.

The connection to GitHub is configured in the Cloudflare dashboard. This
repository holds no deploy workflow and no Cloudflare API token.

## What each file does

| File                       | Purpose                                                                           |
| -------------------------- | --------------------------------------------------------------------------------- |
| `wrangler.jsonc`           | Names the project and points Cloudflare at `dist/`.                               |
| `public/_headers`          | Sets cache and security headers on the response.                                  |
| `.github/workflows/ci.yml` | Runs `vp check` and `vp test` on every push and pull request. It does not deploy. |

Vite copies everything under `public/` into `dist/` without change. That is how
`_headers` reaches the deployed site.

## Build settings in the dashboard

Set these in the Cloudflare project, under Settings, Build:

- Build command: `pnpm build`
- Deploy command: `npx wrangler deploy`
- Build output directory: `dist`

`pnpm build` runs `vp build`. The `vp` CLI is a devDependency, so `pnpm` finds
it in `node_modules/.bin` and no global install is necessary.

CAUTION: Do not add a `devEngines.packageManager` block to `package.json`. npm
reads it and stops with `EBADDEVENGINES` before the deploy command runs. Use the
`packageManager` field instead.

## The custom domain

The site answers on `dicom.soofgolan.com`.

1. Open the project in the Cloudflare dashboard.
2. Open Settings, then Domains and Routes.
3. Add `dicom.soofgolan.com` as a custom domain.
4. Wait for the certificate. This takes a few minutes.

If `soofgolan.com` is a zone on the same Cloudflare account, the DNS record is
created for you. If it is not, add a `CNAME` record at your DNS provider, as the
dashboard instructs.

CAUTION: Add the DNS record only after the custom domain is active. A record
that points at an inactive target returns HTTP 522.

## The content security policy

`public/_headers` holds a Content-Security-Policy that blocks all third-party
script. Two directives need attention.

`script-src` includes `'wasm-unsafe-eval'`. WebAssembly needs it. The
segmentation model runs as WebAssembly when WebGPU is absent.

`connect-src` includes a placeholder hostname, `R2-BUCKET-HOSTNAME.example.com`.
The browser blocks every request to the R2 bucket until you replace it with the
real public hostname. If the app never calls R2, delete the placeholder.

## Cross-origin isolation

The site sets `Cross-Origin-Opener-Policy: same-origin`. It does not set
`Cross-Origin-Embedder-Policy`.

COOP alone costs nothing here. It severs `window.opener`, and this app opens no
popups.

COEP is the directive that breaks things. `require-corp` blocks every
cross-origin subresource that carries no `Cross-Origin-Resource-Policy` header.
The R2 bucket is the first casualty.

Neither WebGPU nor single-threaded WebAssembly needs cross-origin isolation.
Only `SharedArrayBuffer` and WebAssembly threads need it. This app uses neither.

If you later need WebAssembly threads:

1. Add `Cross-Origin-Resource-Policy: cross-origin` to the R2 bucket objects.
2. Add `Cross-Origin-Embedder-Policy: require-corp` to `public/_headers`.
3. Deploy, then load the site and read the console for blocked subresources.

## Troubleshooting

**The build fails with `EBADDEVENGINES`.** `package.json` holds a `devEngines`
block that names a package manager other than npm. Remove the block.

**The deploy succeeds, but the site shows a blank page.** Open the browser
console. A Content-Security-Policy violation is the usual cause. Read which
directive blocked the request, then correct `public/_headers`.

**A request to R2 fails.** The `connect-src` directive still holds the
placeholder hostname. Replace it.

**A client-side route returns 404.** `wrangler.jsonc` must set
`not_found_handling` to `single-page-application`.
